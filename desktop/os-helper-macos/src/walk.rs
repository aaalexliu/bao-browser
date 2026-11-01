use std::collections::HashSet;

use accessibility_sys::{
    kAXDescriptionAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXValueAttribute,
    kAXWindowsAttribute, AXUIElementCreateApplication, AXUIElementPerformAction,
};
use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use core_graphics::display::CGDisplay;

use crate::apps::pids_for_bundle;
use crate::element::{
    actions, attribute_names, copy_attr, element_attr, element_list, has_press, numeric_attribute,
    parent, raw_frame, role_of, same_element, set_bool, string_attr, El, IDENTIFIER,
};
use crate::sample::{ancestor_chain, hits_in_window};
use crate::model::{Frame, Geom, Geometry, Node, Seg};

const MAX_NODES: i32 = 1500;
const MAX_DEPTH: i32 = 30;

/// Child lists SwiftUI actually fills. `AXChildren` on a split group can be empty
/// while navigation order or contents still holds the keypad.
pub(crate) fn child_attribute_names() -> &'static [&'static str] {
    &["AXChildrenInNavigationOrder", "AXContents", "AXVisibleChildren", "AXChildren"]
}

pub fn best_name(title: &str, description: &str, identifier: &str) -> String {
    if !title.is_empty() { title.to_string() } else if !description.is_empty() { description.to_string() } else { identifier.to_string() }
}

fn clip(s: &str) -> String {
    let mut out: String = s.chars().take(240).collect();
    if s.chars().count() > 240 { out.push_str("..."); }
    out
}

fn structural(role: &str) -> bool {
    matches!(role, "AXApplication" | "AXWindow" | "AXMenuBar" | "AXMenu" | "AXGroup" | "AXScrollArea" | "AXSplitGroup" | "AXLayoutArea" | "AXGeneric" | "AXUnknown" | "AXWebArea" | "AXList" | "AXOutline" | "AXToolbar" | "AXScrollBar" | "AXStaticText" | "AXImage" | "AXHeading" | "AXRow" | "AXColumn" | "AXCell" | "AXLayoutItem" | "")
}

pub fn is_text_role(role: &str) -> bool {
    matches!(role, "AXTextArea" | "AXTextField" | "AXComboBox" | "AXSearchField" | "AXTextView")
}

fn useful(role: &str, name: &str, acts: &[String]) -> bool {
    if name.is_empty() { return false; }
    if structural(role) { return has_press(acts); }
    has_press(acts) || is_text_role(role) || matches!(role, "AXButton" | "AXCheckBox" | "AXRadioButton" | "AXMenuItem" | "AXMenuButton" | "AXPopUpButton" | "AXLink" | "AXIncrementor" | "AXSlider")
}

pub fn screen_size() -> (f64, f64) {
    let b = CGDisplay::main().bounds();
    (b.size.width, b.size.height)
}

pub fn app_element(bundle: &str) -> Result<(i32, El), String> {
    app_element_opts(bundle, true)
}

pub fn app_element_opts(bundle: &str, manual: bool) -> Result<(i32, El), String> {
    let pids = pids_for_bundle(bundle);
    if pids.len() != 1 {
        return Err(format!("expected one process for {bundle}, found {} ({pids:?})", pids.len()));
    }
    app_from_pid(pids[0], manual)
}

/// One process, even when several share the bundle id. Bao passes the pid it launched.
pub fn app_from_pid(pid: i32, manual: bool) -> Result<(i32, El), String> {
    if pid <= 0 {
        return Err("pid must be positive".into());
    }
    let el = El::adopt(unsafe { AXUIElementCreateApplication(pid) })
        .ok_or_else(|| format!("AXUIElementCreateApplication returned null for {pid}"))?;
    el.timeout();
    if manual {
        let _ = set_bool(&el, "AXManualAccessibility", true);
        let _ = set_bool(&el, "AXEnhancedUserInterface", true);
    }
    Ok((pid, el))
}

pub fn detect_geom(app: &El) -> Geom {
    let (screen_w, screen_h) = screen_size();
    ax_geometry(screen_w, screen_h, ax_windows(app).into_iter().filter_map(|el| raw_frame(&el)))
}

fn ax_geometry(screen_w: f64, screen_h: f64, windows: impl Iterator<Item = Frame>) -> Geom {
    let ax_window = windows.max_by(|a, b| (a.w * a.h).partial_cmp(&(b.w * b.h)).unwrap_or(std::cmp::Ordering::Equal));
    // AX already uses top-left screen points. WindowServer enumeration can ask
    // for Screen Recording even without reading titles, so never use it here.
    Geom { screen_w, screen_h, flip_y: false, ax_window, cg_window: None }
}

fn ax_windows(app: &El) -> Vec<El> {
    copy_attr(app, kAXWindowsAttribute).map(|v| element_list(&v)).unwrap_or_default()
}

pub fn describe(el: &El, path: &[Seg], bundle: &str, pid: i32, geom: &Geom) -> Node {
    let role = role_of(el);
    let subrole = string_attr(el, kAXSubroleAttribute);
    let title = string_attr(el, kAXTitleAttribute);
    let description = string_attr(el, kAXDescriptionAttribute);
    let identifier = string_attr(el, IDENTIFIER);
    let name = best_name(&title, &description, &identifier);
    let acts = actions(el);
    let ax_frame = raw_frame(el);
    let frame = ax_frame.as_ref().map(|f| {
        let (x, y) = geom.to_top_left(f.x, f.y, f.h);
        Frame { x, y, w: f.w, h: f.h }
    });
    Node {
        useful: useful(&role, &name, &acts),
        role, subrole, title, description, identifier, name,
        value: clip(&string_attr(el, kAXValueAttribute)),
        actions: acts, frame, ax_frame, path: path.to_vec(), pid, app: bundle.to_string(),
    }
}

pub fn ancestor_path(el: &El) -> Vec<Seg> {
    let mut segs = Vec::new();
    let mut current = parent(el);
    for _ in 0..24 {
        let Some(node) = current else { break };
        let role = role_of(&node);
        let name = best_name(&string_attr(&node, kAXTitleAttribute), &string_attr(&node, kAXDescriptionAttribute), &string_attr(&node, IDENTIFIER));
        let stop = role == "AXApplication";
        segs.push(Seg { role, name });
        if stop { break; }
        current = parent(&node);
    }
    segs.reverse();
    segs
}

fn skip_children(role: &str) -> bool {
    is_text_role(role) || role == "AXStaticText" || role == "AXMenuBar"
}

fn linked_children(el: &El) -> Vec<El> {
    let mut out = Vec::new();
    for name in child_attribute_names() {
        if let Some(value) = copy_attr(el, name) {
            out.extend(element_list(&value));
        }
    }
    out
}

/// Windows first, then every child list. Groups, split groups, and scroll areas
/// are not skipped. A nested application is not walked again.
fn follow(el: &El, role: &str) -> Vec<El> {
    let mut out = Vec::new();
    if role == "AXApplication" {
        // The focused window goes first. A modal dialog, such as Chrome's "Allow remote debugging?",
        // is focused and small, while the main window's web page can spend the whole node budget.
        if let Some(win) = element_attr(el, "AXFocusedWindow") { out.push(win); }
        if let Some(win) = element_attr(el, "AXMainWindow") { out.push(win); }
        out.extend(ax_windows(el));
    }
    if !skip_children(role) {
        out.extend(linked_children(el));
    }
    out
}

fn shape_key(pid: i32, role: &str, frame: Option<Frame>) -> Option<String> {
    if role == "AXApplication" || role == "AXMenuBar" {
        return Some(format!("{pid}|{role}"));
    }
    let frame = frame?;
    Some(format!("{pid}|{role}|{:.0}|{:.0}|{:.0}|{:.0}", frame.x, frame.y, frame.w, frame.h))
}

fn shape_dedupe(role: &str) -> bool {
    role == "AXApplication" || role == "AXMenuBar"
}

struct Seen {
    ptrs: HashSet<usize>,
    elems: Vec<El>,
    shapes: HashSet<String>,
}

fn remember(el: &El, pid: i32, role: &str, frame: Option<Frame>, seen: &mut Seen) -> bool {
    if seen.ptrs.contains(&(el.0 as usize)) || seen.elems.iter().any(|prev| same_element(prev, el)) {
        return false;
    }
    if shape_dedupe(role) {
        if let Some(key) = shape_key(pid, role, frame) {
            if seen.shapes.contains(&key) {
                return false;
            }
            seen.shapes.insert(key);
        }
    }
    seen.ptrs.insert(el.0 as usize);
    if let Some(kept) = El::retain(el.0) {
        seen.elems.push(kept);
    }
    true
}

struct WalkOpts<'a> {
    title: &'a str,
    skip_menu: bool,
}

fn rejected_window(el: &El, opts: &WalkOpts) -> bool {
    if opts.title.is_empty() {
        return false;
    }
    let role = role_of(el);
    if role != "AXWindow" {
        return false;
    }
    let name = best_name(&string_attr(el, kAXTitleAttribute), &string_attr(el, kAXDescriptionAttribute), &string_attr(el, IDENTIFIER));
    !name.contains(opts.title)
}

fn walk(el: &El, ancestors: &[Seg], bundle: &str, pid: i32, geom: &Geom, out: &mut Vec<Node>, elems: &mut Vec<El>, seen: &mut Seen, depth: i32, budget: &mut i32, opts: &WalkOpts) {
    if *budget <= 0 || depth > MAX_DEPTH { return; }
    let role_now = role_of(el);
    if opts.skip_menu && (role_now == "AXMenuBar" || role_now == "AXMenuBarItem") {
        return;
    }
    if rejected_window(el, opts) {
        return;
    }
    let node = describe(el, ancestors, bundle, pid, geom);
    if !remember(el, pid, &node.role, node.frame.clone(), seen) { return; }
    let Some(kept) = El::retain(el.0) else { return };
    *budget -= 1;
    let role = node.role.clone();
    let name = node.name.clone();
    let descend = role != "AXApplication" || depth == 0;
    out.push(node);
    elems.push(kept);
    if !descend || skip_children(&role) { return; }
    let mut next = ancestors.to_vec();
    next.push(Seg { role: role.clone(), name });
    for child in follow(el, &role) {
        walk(&child, &next, bundle, pid, geom, out, elems, seen, depth + 1, budget, opts);
    }
}

fn fill_numbers(nodes: &mut [Node], elems: &[El]) {
    for (node, el) in nodes.iter_mut().zip(elems.iter()) {
        if !node.value.is_empty() || has_press(&node.actions) {
            continue;
        }
        let value = numeric_attribute(el);
        if !value.is_empty() {
            node.value = value;
        }
    }
}

fn dump_attrs(nodes: &[Node], elems: &[El]) {
    for (node, el) in nodes.iter().zip(elems.iter()) {
        if has_press(&node.actions) {
            continue;
        }
        if !matches!(node.role.as_str(), "AXApplication" | "AXWindow" | "AXGroup" | "AXSplitGroup" | "AXStaticText" | "AXScrollArea" | "AXTextArea" | "AXLayoutArea") {
            continue;
        }
        let bits: Vec<String> = attribute_names(el).into_iter().take(24).map(|name| {
            let value: String = string_attr(el, &name).chars().take(48).collect();
            format!("{name}={value}")
        }).collect();
        eprintln!("ATTRS role={} name={} {}", node.role, node.name, bits.join(" | "));
    }
}

/// Nodes plus the live elements they were built from, in the same order.
pub struct LiveTree {
    pub nodes: Vec<Node>,
    pub elems: Vec<El>,
    pub geom: Geometry,
    pub pid: i32,
}

pub fn harvest(bundle: &str) -> Result<LiveTree, String> {
    harvest_opts(bundle, true)
}

pub fn harvest_opts(bundle: &str, manual: bool) -> Result<LiveTree, String> {
    harvest_filtered(bundle, manual, "", false)
}

pub fn harvest_pid(bundle: &str, pid: Option<i32>) -> Result<LiveTree, String> {
    harvest_filtered_pid(bundle, pid, true, "", false)
}

/// `title` keeps one window. Other windows are not described and their values
/// are not copied. `skip_menu` drops the menu bar before its items are read.
pub fn harvest_filtered(bundle: &str, manual: bool, title: &str, skip_menu: bool) -> Result<LiveTree, String> {
    harvest_filtered_pid(bundle, None, manual, title, skip_menu)
}

pub fn harvest_filtered_pid(bundle: &str, forced: Option<i32>, manual: bool, title: &str, skip_menu: bool) -> Result<LiveTree, String> {
    let (pid, app) = match forced {
        Some(pid) => app_from_pid(pid, manual)?,
        None => app_element_opts(bundle, manual)?,
    };
    let bundle_name = if bundle.is_empty() { crate::apps::bundle_id_for_pid(pid) } else { bundle.to_string() };
    let bundle = bundle_name.as_str();
    let mut geom = detect_geom(&app);
    let mut out = Vec::new();
    let mut elems = Vec::new();
    let mut seen = Seen { ptrs: HashSet::new(), elems: Vec::new(), shapes: HashSet::new() };
    let mut budget = MAX_NODES;
    let opts = WalkOpts { title, skip_menu };
    walk(&app, &[], bundle, pid, &geom, &mut out, &mut elems, &mut seen, 0, &mut budget, &opts);
    if !title.is_empty() {
        let matched = out.iter().zip(elems.iter()).find(|(node, _)| {
            (node.role == "AXWindow" || node.role == "AXSheet") && node.name.contains(title)
        });
        if let Some((node, el)) = matched {
            let action = CFString::new("AXRaise");
            let _ = unsafe { AXUIElementPerformAction(el.0, action.as_concrete_TypeRef()) };
            geom.ax_window = node.ax_frame.clone();
        } else {
            geom.ax_window = None;
        }
    }
    let mut expanded = HashSet::new();
    for seed in hits_in_window(pid, &geom) {
        if budget <= 0 {
            break;
        }
        for el in ancestor_chain(seed, pid) {
            if manual {
                let _ = set_bool(&el, "AXManualAccessibility", true);
                let _ = set_bool(&el, "AXEnhancedUserInterface", true);
            }
            let role = role_of(&el);
            let depth = if role == "AXApplication" { 1 } else { 0 };
            walk(&el, &ancestor_path(&el), bundle, pid, &geom, &mut out, &mut elems, &mut seen, depth, &mut budget, &opts);
            if expanded.insert(el.0 as usize) && !skip_children(&role) && role != "AXApplication" {
                for child in follow(&el, &role) {
                    let child_depth = if role_of(&child) == "AXApplication" { 1 } else { 0 };
                    walk(&child, &ancestor_path(&child), bundle, pid, &geom, &mut out, &mut elems, &mut seen, child_depth, &mut budget, &opts);
                }
            }
        }
    }
    fill_numbers(&mut out, &elems);
    if std::env::var_os("BAO_OS_ATTRS").is_some() {
        dump_attrs(&out, &elems);
    }
    Ok(LiveTree { nodes: out, elems, geom: geom.report(), pid })
}

pub fn tree(bundle: &str) -> Result<(Vec<Node>, Geometry, i32), String> {
    tree_pid(bundle, None)
}

pub fn tree_pid(bundle: &str, pid: Option<i32>) -> Result<(Vec<Node>, Geometry, i32), String> {
    let live = harvest_pid(bundle, pid)?;
    Ok((live.nodes, live.geom, live.pid))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ax_only_geometry_keeps_offset_window_and_retina_points() {
        // A 3024 x 1964 Retina panel exposes a 1512 x 982 point desktop.
        let window = Frame { x: 143.0, y: 117.0, w: 1000.0, h: 700.0 };
        let small = Frame { x: 200.0, y: 140.0, w: 300.0, h: 200.0 };
        let geom = ax_geometry(1512.0, 982.0, vec![small, window].into_iter());
        assert!(!geom.flip_y);
        assert!(geom.cg_window.is_none());
        let frame = geom.ax_window.as_ref().unwrap();
        assert_eq!((frame.x, frame.y, frame.w, frame.h), (143.0, 117.0, 1000.0, 700.0));
        assert_eq!(geom.to_top_left(263.0, 297.0, 32.0), (263.0, 297.0));
        assert_eq!(geom.to_ax_origin(263.0, 297.0, 32.0), (263.0, 297.0));
        let empty = ax_geometry(1512.0, 982.0, std::iter::empty());
        assert!(empty.ax_window.is_none());
        assert_eq!(empty.to_top_left(-80.0, 1100.0, 24.0), (-80.0, 1100.0));
    }

    #[test]
    fn depth_cap_and_group_descent() {
        assert_eq!(MAX_DEPTH, 30);
        assert!(!skip_children("AXSplitGroup"));
        assert!(!skip_children("AXGroup"));
        assert!(!skip_children("AXScrollArea"));
        assert!(!skip_children("AXWindow"));
        assert!(skip_children("AXMenuBar"));
        assert!(skip_children("AXStaticText"));
        assert!(skip_children("AXTextArea"));
    }

    #[test]
    fn child_lists_include_navigation_order() {
        let names = child_attribute_names();
        assert_eq!(names[0], "AXChildrenInNavigationOrder");
        assert!(names.contains(&"AXContents"));
        assert!(names.contains(&"AXVisibleChildren"));
        assert!(names.contains(&"AXChildren"));
    }

    #[test]
    fn same_role_and_frame_dedupes() {
        let frame = Frame { x: 10.0, y: 20.0, w: 30.0, h: 40.0 };
        let button = shape_key(1, "AXButton", Some(frame.clone()));
        assert_eq!(button, shape_key(1, "AXButton", Some(frame.clone())));
        assert_ne!(button, shape_key(1, "AXGroup", Some(frame)));
        assert_eq!(shape_key(4, "AXApplication", None), Some("4|AXApplication".into()));
        assert_ne!(shape_key(4, "AXApplication", None), shape_key(4, "AXMenuBar", None));
    }
}
