use accessibility_sys::{kAXPressAction, kAXValueAttribute, AXUIElementPerformAction};
use core_foundation::base::TCFType;
use core_foundation::string::CFString;

use crate::element::{parent, raw_frame, role_of, set_ax_point, set_ax_size, set_bool, set_string, string_attr, El};
use crate::model::{Frame, Node, Seg};
use crate::walk::{app_element, detect_geom, harvest};

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

fn matches_target(node: &Node, role: &str, name: &str, subrole: &str, path: &[Seg]) -> bool {
    node.role == role
        && name_matches(node, name)
        && (subrole.is_empty() || node.subrole == subrole)
        && path_matches(node, path)
}

/// One harvest. The returned element is the live control, including controls
/// that were found by sampling the window rather than by AXChildren.
fn take_one(bundle: &str, pid: Option<i32>, role: &str, name: &str, subrole: &str, path: &[Seg]) -> Result<(Node, El), String> {
    let live = crate::walk::harvest_pid(bundle, pid)?;
    let hits: Vec<usize> = live.nodes.iter().enumerate()
        .filter(|(_, node)| matches_target(node, role, name, subrole, path))
        .map(|(i, _)| i)
        .collect();
    match hits.len() {
        1 => {
            let i = hits[0];
            let node = live.nodes[i].clone();
            let mut elems = live.elems;
            Ok((node, elems.swap_remove(i)))
        }
        0 => Err(format!("accessible lookup missed role={role:?} name={name:?} subrole={subrole:?}; refusing coordinate fallback")),
        n => Err(format!("accessible lookup ambiguous ({n} matches) role={role:?} name={name:?}; refusing coordinate fallback")),
    }
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

pub fn press(bundle: &str, pid: Option<i32>, role: &str, name: &str, subrole: &str, path: &[Seg]) -> Result<Node, String> {
    let (node, el) = take_one(bundle, pid, role, name, subrole, path)?;
    if !node.actions.iter().any(|a| a == kAXPressAction) {
        return Err(format!("control {:?} has no AXPress action; refusing coordinate fallback", node.name));
    }
    raise_window(&el);
    let action = CFString::new(kAXPressAction);
    crate::element::ax_ok(unsafe { AXUIElementPerformAction(el.0, action.as_concrete_TypeRef()) }, "AXPress")?;
    Ok(node)
}

pub fn set_value(bundle: &str, pid: Option<i32>, role: &str, name: &str, subrole: &str, path: &[Seg], value: &str) -> Result<Node, String> {
    let (node, el) = take_one(bundle, pid, role, name, subrole, path)?;
    let _ = set_bool(&el, "AXFocused", true);
    set_string(&el, kAXValueAttribute, value)?;
    Ok(node)
}

pub fn read_value(bundle: &str, pid: Option<i32>, role: &str, name: &str, subrole: &str, path: &[Seg]) -> Result<(Node, String), String> {
    let (node, el) = take_one(bundle, pid, role, name, subrole, path)?;
    Ok((node, string_attr(&el, kAXValueAttribute)))
}

pub fn focus_role(bundle: &str, role: &str, name: &str) -> Result<Node, String> {
    let live = harvest(bundle)?;
    let hits: Vec<usize> = live.nodes.iter().enumerate()
        .filter(|(_, node)| node.role == role && (name.is_empty() || name_matches(node, name)))
        .map(|(i, _)| i)
        .collect();
    if hits.len() != 1 {
        return Err(format!("focus lookup expected one {role} named {name:?}, found {}", hits.len()));
    }
    let i = hits[0];
    let node = live.nodes[i].clone();
    let mut elems = live.elems;
    let el = elems.swap_remove(i);
    raise_window(&el);
    set_bool(&el, "AXFocused", true)?;
    Ok(node)
}

pub fn move_window(bundle: &str, pid: Option<i32>, frontmost: bool, x: f64, y: f64, w: f64, h: f64) -> Result<(Frame, Frame, Option<String>), String> {
    let (pid, app) = match pid {
        Some(pid) => crate::walk::app_from_pid(pid, true)?,
        None => app_element(bundle)?,
    };
    if frontmost {
        crate::apps::activate_pid(pid)?;
    }
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
    // Calculator rejects AXSize (-25200). The move still stands.
    let size_error = set_ax_size(&win, w, h).err();
    let after_raw = raw_frame(&win).ok_or("window lost its frame after move")?;
    let (ax2, ay2) = geom.to_top_left(after_raw.x, after_raw.y, after_raw.h);
    Ok((before, Frame { x: ax2, y: ay2, w: after_raw.w, h: after_raw.h }, size_error))
}
