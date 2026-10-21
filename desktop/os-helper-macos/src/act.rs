use std::collections::HashSet;

use accessibility_sys::{kAXPressAction, kAXValueAttribute, AXUIElementPerformAction};
use core_foundation::base::TCFType;
use core_foundation::string::CFString;

use crate::element::{parent, raw_frame, role_of, set_ax_point, set_ax_size, set_bool, set_string, string_attr, El};
use crate::model::{Frame, Node, Seg};
use crate::walk::{app_element, describe, detect_geom, is_text_role, tree};

pub fn name_matches(node: &Node, want: &str) -> bool {
    if want.is_empty() {
        node.name.is_empty()
    } else {
        node.name == want || node.title == want || node.description == want || node.identifier == want
    }
}

pub fn path_matches(node: &Node, want: &[Seg]) -> bool {
    if want.is_empty() { return true; }
    if node.path.len() != want.len() { return false; }
    node.path.iter().zip(want).all(|(got, exp)| got.role == exp.role && (exp.name.is_empty() || got.name == exp.name))
}

pub fn lookup(bundle: &str, role: &str, name: &str, subrole: &str, path: &[Seg]) -> Result<Node, String> {
    let (nodes, _, _) = tree(bundle)?;
    let mut hits: Vec<&Node> = nodes.iter()
        .filter(|n| n.role == role && name_matches(n, name))
        .filter(|n| subrole.is_empty() || n.subrole == subrole)
        .collect();
    if !path.is_empty() {
        hits = hits.into_iter().filter(|n| path_matches(n, path)).collect();
    }
    match hits.len() {
        1 => Ok(hits[0].clone()),
        0 => Err(format!("accessible lookup missed role={role:?} name={name:?} subrole={subrole:?}; refusing coordinate fallback")),
        n => Err(format!("accessible lookup ambiguous ({n} matches) role={role:?} name={name:?}; refusing coordinate fallback")),
    }
}

fn seek(el: &El, ancestors: &[Seg], bundle: &str, pid: i32, geom: &crate::model::Geom, want: &Node, seen: &mut HashSet<usize>, depth: i32, budget: &mut i32) -> Option<El> {
    if *budget <= 0 || depth > 20 || !seen.insert(el.0 as usize) { return None; }
    *budget -= 1;
    let node = describe(el, ancestors, bundle, pid, geom);
    if node.role == want.role && name_matches(&node, &want.name) && (want.subrole.is_empty() || node.subrole == want.subrole) && path_matches(&node, &want.path) {
        return El::retain(el.0);
    }
    if is_text_role(&node.role) || node.role == "AXStaticText" || node.role == "AXMenuBar" { return None; }
    let mut next = ancestors.to_vec();
    next.push(Seg { role: node.role, name: node.name });
    for child in crate::element::children(el) {
        if let Some(found) = seek(&child, &next, bundle, pid, geom, want, seen, depth + 1, budget) {
            return Some(found);
        }
    }
    None
}

fn reopen(bundle: &str, node: &Node) -> Result<El, String> {
    let (pid, app) = app_element(bundle)?;
    let geom = detect_geom(pid, &app);
    let mut seen = HashSet::new();
    let mut budget = 1500;
    seek(&app, &[], bundle, pid, &geom, node, &mut seen, 0, &mut budget)
        .ok_or_else(|| "lookup element disappeared before the action".to_string())
}

fn raise_window(el: &El) {
    let mut current = El::retain(el.0);
    for _ in 0..12 {
        let Some(node) = current.as_ref() else { break };
        if role_of(node) == "AXWindow" {
            let action = CFString::new("AXRaise");
            let _ = unsafe { AXUIElementPerformAction(node.0, action.as_concrete_TypeRef()) };
            break;
        }
        current = parent(node);
    }
}

pub fn press(bundle: &str, role: &str, name: &str, subrole: &str, path: &[Seg]) -> Result<Node, String> {
    let node = lookup(bundle, role, name, subrole, path)?;
    if !node.actions.iter().any(|a| a == kAXPressAction) {
        return Err(format!("control {:?} has no AXPress action; refusing coordinate fallback", node.name));
    }
    let el = reopen(bundle, &node)?;
    raise_window(&el);
    let action = CFString::new(kAXPressAction);
    crate::element::ax_ok(unsafe { AXUIElementPerformAction(el.0, action.as_concrete_TypeRef()) }, "AXPress")?;
    Ok(node)
}

pub fn set_value(bundle: &str, role: &str, name: &str, subrole: &str, path: &[Seg], value: &str) -> Result<Node, String> {
    let node = lookup(bundle, role, name, subrole, path)?;
    let el = reopen(bundle, &node)?;
    let _ = set_bool(&el, "AXFocused", true);
    set_string(&el, kAXValueAttribute, value)?;
    Ok(node)
}

pub fn read_value(bundle: &str, role: &str, name: &str, subrole: &str, path: &[Seg]) -> Result<(Node, String), String> {
    let node = lookup(bundle, role, name, subrole, path)?;
    let el = reopen(bundle, &node)?;
    Ok((node, string_attr(&el, kAXValueAttribute)))
}

pub fn focus_role(bundle: &str, role: &str, name: &str) -> Result<Node, String> {
    let (nodes, _, _) = tree(bundle)?;
    let hits: Vec<&Node> = nodes.iter().filter(|n| n.role == role && (name.is_empty() || name_matches(n, name))).collect();
    if hits.len() != 1 {
        return Err(format!("focus lookup expected one {role} named {name:?}, found {}", hits.len()));
    }
    let node = hits[0].clone();
    let el = reopen(bundle, &node)?;
    set_bool(&el, "AXFocused", true)?;
    Ok(node)
}

pub fn move_window(bundle: &str, x: f64, y: f64, w: f64, h: f64) -> Result<(Frame, Frame), String> {
    let (pid, app) = app_element(bundle)?;
    let geom = detect_geom(pid, &app);
    let wins = crate::element::copy_attr(&app, "AXWindows").map(|v| crate::element::element_list(&v)).unwrap_or_default();
    let win = wins.into_iter().max_by(|a, b| {
        let af = raw_frame(a).map(|f| f.w * f.h).unwrap_or(0.0);
        let bf = raw_frame(b).map(|f| f.w * f.h).unwrap_or(0.0);
        af.partial_cmp(&bf).unwrap_or(std::cmp::Ordering::Equal)
    }).ok_or("app has no AXWindow")?;
    let before_raw = raw_frame(&win).ok_or("window has no frame")?;
    let (bx, by) = geom.to_top_left(before_raw.x, before_raw.y, before_raw.h);
    let before = Frame { x: bx, y: by, w: before_raw.w, h: before_raw.h };
    let (ax_x, ax_y) = geom.to_ax_origin(x, y, h);
    set_ax_point(&win, "AXPosition", ax_x, ax_y)?;
    set_ax_size(&win, w, h)?;
    let after_raw = raw_frame(&win).ok_or("window lost its frame after move")?;
    let (ax2, ay2) = geom.to_top_left(after_raw.x, after_raw.y, after_raw.h);
    Ok((before, Frame { x: ax2, y: ay2, w: after_raw.w, h: after_raw.h }))
}
