use std::collections::HashSet;

use accessibility_sys::{
    kAXDescriptionAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXValueAttribute,
    kAXWindowsAttribute, AXUIElementCreateApplication,
};
use core_graphics::display::CGDisplay;

use crate::apps::pids_for_bundle;
use crate::element::{
    actions, attribute_names, copy_attr, element_attr, element_list, has_press, numeric_attribute,
    parent, raw_frame, role_of, same_element, set_bool, string_attr, El, IDENTIFIER,
};
use crate::sample::{ancestor_chain, hits_in_window};
use crate::model::{Frame, Geom, Geometry, Node, Seg};
use crate::win::main_window;

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
    let pids = pids_for_bundle(bundle);
    if pids.len() != 1 {
        return Err(format!("expected one process for {bundle}, found {} ({pids:?})", pids.len()));
    }
    let el = El::adopt(unsafe { AXUIElementCreateApplication(pids[0]) })
        .ok_or_else(|| format!("AXUIElementCreateApplication returned null for {}", pids[0]))?;
    el.timeout();
    let _ = set_bool(&el, "AXManualAccessibility", true);
    let _ = set_bool(&el, "AXEnhancedUserInterface", true);
    Ok((pids[0], el))
}

pub fn detect_geom(pid: i32, app: &El) -> Geom {
    let (screen_w, screen_h) = screen_size();
    let mut geom = Geom { screen_w, screen_h, flip_y: false, ax_window: None, cg_window: None };
    let cg = main_window(pid).ok();
    let ax = ax_windows(app).into_iter().filter_map(|el| raw_frame(&el))
        .max_by(|a, b| (a.w * a.h).partial_cmp(&(b.w * b.h)).unwrap_or(std::cmp::Ordering::Equal));
    if let (Some(ax), Some(cg)) = (ax, cg) {
        let same = (ax.y - cg.frame.y).abs();
        let flipped = (screen_h - ax.y - ax.h - cg.frame.y).abs();
        let size_ok = (ax.w - cg.frame.w).abs() < 30.0 && (ax.h - cg.frame.h).abs() < 80.0;
        geom.flip_y = size_ok && flipped < 12.0 && same > 40.0;
        geom.ax_window = Some(ax);
        geom.cg_window = Some(cg.frame);
    }
    geom
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
        if let Some(win) = element_attr(el, "AXMainWindow") { out.push(win); }
        if let Some(win) = element_attr(el, "AXFocusedWindow") { out.push(win); }
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

fn walk(el: &El, ancestors: &[Seg], bundle: &str, pid: i32, geom: &Geom, out: &mut Vec<Node>, elems: &mut Vec<El>, seen: &mut Seen, depth: i32, budget: &mut i32) {
    if *budget <= 0 || depth > MAX_DEPTH { return; }
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
        walk(&child, &next, bundle, pid, geom, out, elems, seen, depth + 1, budget);
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
    let (pid, app) = app_element(bundle)?;
    let geom = detect_geom(pid, &app);
    let mut out = Vec::new();
    let mut elems = Vec::new();
    let mut seen = Seen { ptrs: HashSet::new(), elems: Vec::new(), shapes: HashSet::new() };
    let mut budget = MAX_NODES;
    walk(&app, &[], bundle, pid, &geom, &mut out, &mut elems, &mut seen, 0, &mut budget);
    let mut expanded = HashSet::new();
    for seed in hits_in_window(pid, &geom) {
        if budget <= 0 {
            break;
        }
        for el in ancestor_chain(seed, pid) {
            let _ = set_bool(&el, "AXManualAccessibility", true);
            let _ = set_bool(&el, "AXEnhancedUserInterface", true);
            let role = role_of(&el);
            let depth = if role == "AXApplication" { 1 } else { 0 };
            walk(&el, &ancestor_path(&el), bundle, pid, &geom, &mut out, &mut elems, &mut seen, depth, &mut budget);
            if expanded.insert(el.0 as usize) && !skip_children(&role) && role != "AXApplication" {
                for child in follow(&el, &role) {
                    let child_depth = if role_of(&child) == "AXApplication" { 1 } else { 0 };
                    walk(&child, &ancestor_path(&child), bundle, pid, &geom, &mut out, &mut elems, &mut seen, child_depth, &mut budget);
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
    let live = harvest(bundle)?;
    Ok((live.nodes, live.geom, live.pid))
}

#[cfg(test)]
mod tests {
    use super::*;

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
