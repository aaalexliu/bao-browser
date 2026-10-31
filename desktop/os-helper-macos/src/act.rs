use accessibility_sys::{kAXPressAction, kAXValueAttribute, AXUIElementPerformAction};
use core_foundation::base::TCFType;
use core_foundation::string::CFString;

use serde_json::{json, Value};

use crate::element::{copy_attr, element_list, parent, raw_frame, role_of, set_ax_point, set_ax_size, set_bool, set_string, string_attr, El};
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

fn matches_target(node: &Node, role: &str, name: &str, subrole: &str, path: &[Seg], value_prefix: &str) -> bool {
    node.role == role
        && name_matches(node, name)
        && (subrole.is_empty() || node.subrole == subrole)
        && path_matches(node, path)
        && (value_prefix.is_empty() || node.value.starts_with(value_prefix))
}

/// One harvest. The returned element is the live control, including controls
/// that were found by sampling the window rather than by AXChildren.
fn take_one(bundle: &str, pid: Option<i32>, role: &str, name: &str, subrole: &str, path: &[Seg], value_prefix: &str) -> Result<(Node, El), String> {
    let live = crate::walk::harvest_pid(bundle, pid)?;
    let hits: Vec<usize> = live.nodes.iter().enumerate()
        .filter(|(_, node)| matches_target(node, role, name, subrole, path, value_prefix))
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

pub fn press(bundle: &str, pid: Option<i32>, role: &str, name: &str, subrole: &str, path: &[Seg], value_prefix: &str) -> Result<Node, String> {
    let (node, el) = take_one(bundle, pid, role, name, subrole, path, value_prefix)?;
    if !node.actions.iter().any(|a| a == kAXPressAction) {
        return Err(format!("control {:?} has no AXPress action; refusing coordinate fallback", node.name));
    }
    raise_window(&el);
    let action = CFString::new(kAXPressAction);
    crate::element::ax_ok(unsafe { AXUIElementPerformAction(el.0, action.as_concrete_TypeRef()) }, "AXPress")?;
    Ok(node)
}

pub fn show_menu(bundle: &str, pid: Option<i32>, role: &str, name: &str, subrole: &str, path: &[Seg], value_prefix: &str) -> Result<Node, String> {
    let (node, el) = take_one(bundle, pid, role, name, subrole, path, value_prefix)?;
    if !node.actions.iter().any(|a| a == "AXShowMenu") {
        return Err(format!("control {:?} has no AXShowMenu action", node.name));
    }
    raise_window(&el);
    let action = CFString::new("AXShowMenu");
    crate::element::ax_ok(unsafe { AXUIElementPerformAction(el.0, action.as_concrete_TypeRef()) }, "AXShowMenu")?;
    Ok(node)
}

fn child_list(el: &El) -> Vec<El> {
    let _ = set_bool(el, "AXManualAccessibility", true);
    let _ = set_bool(el, "AXEnhancedUserInterface", true);
    let mut out = Vec::new();
    for name in ["AXChildrenInNavigationOrder", "AXContents", "AXVisibleChildren", "AXChildren"] {
        if let Some(value) = copy_attr(el, name) {
            out.extend(element_list(&value));
        }
    }
    out
}

fn named(el: &El) -> String {
    let title = string_attr(el, "AXTitle");
    if !title.is_empty() { return title; }
    let description = string_attr(el, "AXDescription");
    if !description.is_empty() { return description; }
    string_attr(el, "AXValue")
}

fn find_named(el: &El, role: &str, name: &str, depth: i32, seen: &mut std::collections::HashSet<usize>) -> Option<El> {
    if depth > 30 || seen.len() > 1500 { return None; }
    let ptr = el.0 as usize;
    if !seen.insert(ptr) { return None; }
    if role_of(el) == role && named(el) == name {
        return El::retain(el.0);
    }
    for child in child_list(el) {
        if let Some(found) = find_named(&child, role, name, depth + 1, seen) {
            return Some(found);
        }
    }
    None
}

fn window_candidates(windows: &[El]) -> Vec<Value> {
    windows.iter().map(|window| {
        json!({
            "title": string_attr(window, "AXTitle"),
            "frame": raw_frame(window),
        })
    }).collect()
}

fn pick_windows(pid: i32, frame: Option<(f64, f64, f64, f64)>) -> Result<Vec<El>, String> {
    let (_pid, app) = crate::walk::app_from_pid(pid, true)?;
    let windows = copy_attr(&app, "AXWindows").map(|value| element_list(&value)).unwrap_or_default();
    if let Some(frame) = frame {
        let matched: Vec<El> = windows.iter().filter(|window| {
            raw_frame(window).is_some_and(|ax| {
                (ax.x - frame.0).abs() < 40.0 && (ax.y - frame.1).abs() < 40.0
                    && (ax.w - frame.2).abs() < 80.0 && (ax.h - frame.3).abs() < 80.0
            })
        }).filter_map(|window| El::retain(window.0)).collect();
        if !matched.is_empty() { return Ok(matched); }
    }
    let titled: Vec<El> = windows.iter().filter(|window| {
        string_attr(window, "AXTitle").contains("Inspect with Chrome Developer Tools")
    }).filter_map(|window| El::retain(window.0)).collect();
    if !titled.is_empty() { return Ok(titled); }
    if frame.is_some() {
        return Err(format!("no accessibility window matches the inspect frame {frame:?}; candidates {}", serde_json::to_string(&window_candidates(&windows)).unwrap_or_default()));
    }
    Ok(windows)
}

fn web_areas(window: &El) -> Vec<El> {
    let mut out = Vec::new();
    fn walk(el: &El, depth: i32, out: &mut Vec<El>) {
        if depth > 8 { return; }
        if role_of(el) == "AXWebArea" {
            if let Some(kept) = El::retain(el.0) { out.push(kept); }
            return;
        }
        for child in child_list(el) {
            walk(&child, depth + 1, out);
        }
    }
    walk(window, 0, &mut out);
    out
}

fn inspect_checkbox(pid: i32, name: &str, frame: Option<(f64, f64, f64, f64)>) -> Result<El, String> {
    let windows = pick_windows(pid, frame)?;
    for window in &windows {
        let areas = web_areas(window);
        let roots: Vec<&El> = if areas.is_empty() { vec![window] } else { areas.iter().collect() };
        for root in roots {
            if let Some(found) = find_named(root, "AXCheckBox", name, 0, &mut std::collections::HashSet::new()) {
                return Ok(found);
            }
        }
    }
    Err("inspect checkbox was not found".into())
}

fn checkbox_value(pid: i32, name: &str, frame: Option<(f64, f64, f64, f64)>) -> Result<Value, String> {
    match inspect_checkbox(pid, name, frame) {
        Ok(el) => Ok(json!({"ok": true, "found": true, "value": string_attr(&el, "AXValue"), "frame": raw_frame(&el)})),
        Err(err) => Ok(json!({"ok": true, "found": false, "error": err})),
    }
}

/// Reads the remote-debugging checkbox in the inspect window. Does not raise Chrome.
/// Always returns JSON, including a clear error when the box is missing.
pub fn checkbox_read(pid: i32, name: &str, frame: Option<(f64, f64, f64, f64)>) -> Result<Value, String> {
    checkbox_value(pid, name, frame)
}

/// Sets the checkbox. Does not raise or activate Chrome. AXPress, otherwise a bool value.
pub fn checkbox_set(pid: i32, name: &str, on: bool, frame: Option<(f64, f64, f64, f64)>) -> Result<Value, String> {
    let el = match inspect_checkbox(pid, name, frame) {
        Ok(el) => el,
        Err(err) => return Ok(json!({"ok": true, "found": false, "error": err, "pressed": false})),
    };
    let current = string_attr(&el, "AXValue");
    let already = if on { current == "1" || current == "true" } else { current == "0" || current == "false" };
    if !already {
        let action = CFString::new(kAXPressAction);
        let err = unsafe { AXUIElementPerformAction(el.0, action.as_concrete_TypeRef()) };
        if err != 0 {
            set_bool(&el, "AXValue", on)?;
        }
    }
    Ok(json!({"ok": true, "found": true, "value": string_attr(&el, "AXValue"), "pressed": !already}))
}

pub fn set_checked(bundle: &str, pid: Option<i32>, role: &str, name: &str, on: bool) -> Result<Node, String> {
    let (node, el) = take_one(bundle, pid, role, name, "", &[], "")?;
    set_bool(&el, "AXValue", on)?;
    Ok(node)
}

pub fn set_value(bundle: &str, pid: Option<i32>, role: &str, name: &str, subrole: &str, path: &[Seg], value: &str) -> Result<Node, String> {
    let (node, el) = take_one(bundle, pid, role, name, subrole, path, "")?;
    let _ = set_bool(&el, "AXFocused", true);
    set_string(&el, kAXValueAttribute, value)?;
    Ok(node)
}

pub fn read_value(bundle: &str, pid: Option<i32>, role: &str, name: &str, subrole: &str, path: &[Seg]) -> Result<(Node, String), String> {
    let (node, el) = take_one(bundle, pid, role, name, subrole, path, "")?;
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

#[cfg(test)]
mod tests {
    use super::matches_target;
    use crate::model::Node;

    fn row(value: &str) -> Node {
        Node {
            role: "AXStaticText".into(),
            subrole: String::new(),
            title: String::new(),
            description: String::new(),
            identifier: String::new(),
            name: String::new(),
            value: value.into(),
            actions: vec!["AXPress".into()],
            frame: None,
            ax_frame: None,
            path: Vec::new(),
            pid: 1,
            app: "com.google.Chrome".into(),
            useful: true,
        }
    }

    #[test]
    fn value_prefix_picks_the_url_row_not_the_search_row() {
        let url = row("chrome://inspect/#remote-debugging, press Tab then Enter to Remove Suggestion., 1 of 2");
        let search = row("chrome://inspect/#remote-debugging search, 2 of 2");
        let prefix = "chrome://inspect/#remote-debugging, ";
        assert!(matches_target(&url, "AXStaticText", "", "", &[], prefix));
        assert!(!matches_target(&search, "AXStaticText", "", "", &[], prefix));
        assert!(matches_target(&url, "AXStaticText", "", "", &[], ""));
        assert!(matches_target(&search, "AXStaticText", "", "", &[], ""));
    }
}
