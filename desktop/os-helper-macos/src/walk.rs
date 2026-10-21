use std::collections::HashSet;

use accessibility_sys::{
    kAXDescriptionAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXValueAttribute,
    kAXWindowsAttribute, AXUIElementCreateApplication,
};
use core_graphics::display::CGDisplay;

use crate::apps::pids_for_bundle;
use crate::element::{
    actions, children, copy_attr, element_attr, element_list, has_press, parent, raw_frame, role_of,
    same_element, set_bool, string_attr, El, IDENTIFIER,
};
use crate::model::{Frame, Geom, Geometry, Node, Seg};
use crate::win::main_window;

const MAX_NODES: i32 = 1500;
const MAX_DEPTH: i32 = 20;

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

/// Windows first, then children. A nested application is not walked again.
fn follow(el: &El, role: &str) -> Vec<El> {
    let mut out = Vec::new();
    if role == "AXApplication" {
        if let Some(win) = element_attr(el, "AXMainWindow") { out.push(win); }
        if let Some(win) = element_attr(el, "AXFocusedWindow") { out.push(win); }
        out.extend(ax_windows(el));
    }
    if !skip_children(role) {
        out.extend(children(el));
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

struct Seen {
    ptrs: HashSet<usize>,
    elems: Vec<El>,
    shapes: HashSet<String>,
}

fn remember(el: &El, pid: i32, role: &str, frame: Option<Frame>, seen: &mut Seen) -> bool {
    if seen.ptrs.contains(&(el.0 as usize)) || seen.elems.iter().any(|prev| same_element(prev, el)) {
        return false;
    }
    if let Some(key) = shape_key(pid, role, frame) {
        if seen.shapes.contains(&key) {
            return false;
        }
        seen.shapes.insert(key);
    }
    seen.ptrs.insert(el.0 as usize);
    if let Some(kept) = El::retain(el.0) {
        seen.elems.push(kept);
    }
    true
}

fn walk(el: &El, ancestors: &[Seg], bundle: &str, pid: i32, geom: &Geom, out: &mut Vec<Node>, seen: &mut Seen, depth: i32, budget: &mut i32) {
    if *budget <= 0 || depth > MAX_DEPTH { return; }
    let node = describe(el, ancestors, bundle, pid, geom);
    if !remember(el, pid, &node.role, node.frame.clone(), seen) { return; }
    *budget -= 1;
    let role = node.role.clone();
    let name = node.name.clone();
    let descend = role != "AXApplication" || depth == 0;
    out.push(node);
    if !descend || skip_children(&role) { return; }
    let mut next = ancestors.to_vec();
    next.push(Seg { role: role.clone(), name });
    for child in follow(el, &role) {
        walk(&child, &next, bundle, pid, geom, out, seen, depth + 1, budget);
    }
}

pub fn tree(bundle: &str) -> Result<(Vec<Node>, Geometry, i32), String> {
    let (pid, app) = app_element(bundle)?;
    let geom = detect_geom(pid, &app);
    let mut out = Vec::new();
    let mut seen = Seen { ptrs: HashSet::new(), elems: Vec::new(), shapes: HashSet::new() };
    let mut budget = MAX_NODES;
    walk(&app, &[], bundle, pid, &geom, &mut out, &mut seen, 0, &mut budget);
    Ok((out, geom.report(), pid))
}
