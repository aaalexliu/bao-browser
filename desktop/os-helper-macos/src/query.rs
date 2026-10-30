use accessibility_sys::{
    kAXErrorAPIDisabled, kAXErrorSuccess, kAXFocusedApplicationAttribute, kAXFocusedUIElementAttribute,
    AXUIElementCopyElementAtPosition, AXUIElementCreateApplication, AXUIElementCreateSystemWide, AXUIElementGetTypeID,
    AXUIElementRef,
};
use core_foundation::base::{CFGetTypeID, TCFType};

use crate::apps::bundle_id_for_pid;
use crate::element::{copy_attr, has_press, parent, pid_of, El};
use crate::model::{Geom, Node};
use crate::walk::{ancestor_path, describe, detect_geom, is_text_role, screen_size};

fn system_wide() -> Result<El, String> {
    let el = El::adopt(unsafe { AXUIElementCreateSystemWide() }).ok_or("AXUIElementCreateSystemWide returned null")?;
    el.timeout();
    Ok(el)
}

fn geom_for_pid(pid: i32) -> Geom {
    if pid > 0 {
        if let Some(app) = El::adopt(unsafe { AXUIElementCreateApplication(pid) }) {
            app.timeout();
            return detect_geom(pid, &app);
        }
    }
    let (screen_w, screen_h) = screen_size();
    Geom { screen_w, screen_h, flip_y: false, ax_window: None, cg_window: None }
}

fn is_element(value: &core_foundation::base::CFType) -> bool {
    unsafe { CFGetTypeID(value.as_CFTypeRef()) == AXUIElementGetTypeID() }
}

fn adopt_leaf_name(node: &mut Node, leaf: &Node) {
    if !node.name.is_empty() || leaf.name.is_empty() || !has_press(&node.actions) {
        return;
    }
    node.name = leaf.name.clone();
    if node.title.is_empty() { node.title = leaf.title.clone(); }
    if node.description.is_empty() { node.description = leaf.description.clone(); }
    if node.identifier.is_empty() { node.identifier = leaf.identifier.clone(); }
    node.useful = true;
}

fn copy_system(x: f64, y: f64) -> Result<Option<El>, String> {
    let sys = system_wide()?;
    let mut raw: AXUIElementRef = std::ptr::null_mut();
    let err = unsafe { AXUIElementCopyElementAtPosition(sys.0, x as f32, y as f32, &mut raw) };
    if err == kAXErrorAPIDisabled {
        return Err("accessibility is not trusted for this binary (kAXErrorAPIDisabled)".into());
    }
    if err != kAXErrorSuccess || raw.is_null() {
        return Ok(None);
    }
    Ok(El::adopt(raw))
}

fn climb(leaf: El) -> Result<(bool, String, Option<Node>), String> {
    let pid = pid_of(&leaf);
    let bundle = bundle_id_for_pid(pid);
    let geom = geom_for_pid(pid);
    let leaf_node = describe(&leaf, &ancestor_path(&leaf), &bundle, pid, &geom);
    let mut current = El::retain(leaf.0).ok_or("retain failed")?;
    let mut chosen = leaf_node.clone();
    for _ in 0..12 {
        let mut node = describe(&current, &ancestor_path(&current), &bundle, pid, &geom);
        adopt_leaf_name(&mut node, &leaf_node);
        if node.useful { chosen = node; break; }
        chosen = node;
        match parent(&current) {
            Some(p) => current = p,
            None => break,
        }
    }
    let useful = chosen.useful;
    let reason = if useful { String::new() } else { format!("hit {}, not an actionable control", chosen.role) };
    Ok((useful, reason, Some(chosen)))
}

fn contains(frame: &crate::model::Frame, x: f64, y: f64) -> bool {
    x >= frame.x && y >= frame.y && x < frame.x + frame.w && y < frame.y + frame.h
}

/// Smallest useful element whose frame contains the point, else the smallest frame.
fn walk_point(x: f64, y: f64, allow_bundle: &str) -> Result<(bool, String, Option<Node>), String> {
    if allow_bundle.is_empty() {
        return Ok((false, "no accessibility element at point".into(), None));
    }
    let (nodes, _, _) = crate::walk::tree(allow_bundle)?;
    let mut best: Option<Node> = None;
    let mut best_area = f64::MAX;
    for node in nodes {
        let Some(frame) = node.frame.as_ref() else { continue };
        if !contains(frame, x, y) { continue; }
        let area = frame.w * frame.h;
        let replace = match &best {
            None => true,
            Some(cur) => (node.useful && !cur.useful) || (node.useful == cur.useful && area < best_area),
        };
        if replace {
            best_area = area;
            best = Some(node);
        }
    }
    let Some(chosen) = best else {
        return Ok((false, "no accessibility element at point".into(), None));
    };
    let useful = chosen.useful;
    let reason = if useful {
        "window-walk".into()
    } else {
        format!("window walk hit {}, not an actionable control", chosen.role)
    };
    Ok((useful, reason, Some(chosen)))
}

/// System-wide `AXUIElementCopyElementAtPosition`, then the allowed app's windows.
pub fn at_point(x: f64, y: f64, allow_bundle: &str) -> Result<(bool, String, Option<Node>), String> {
    if let Some(leaf) = copy_system(x, y)? {
        let bundle = bundle_id_for_pid(pid_of(&leaf));
        if allow_bundle.is_empty() || bundle == allow_bundle {
            return climb(leaf);
        }
    }
    walk_point(x, y, allow_bundle)
}

pub fn focused(allow_bundle: &str) -> Result<(bool, String, Option<Node>), String> {
    let sys = system_wide()?;
    let from_app = copy_attr(&sys, kAXFocusedApplicationAttribute).and_then(|value| {
        if !is_element(&value) { return None; }
        let app = El::retain(value.as_CFTypeRef() as AXUIElementRef)?;
        copy_attr(&app, kAXFocusedUIElementAttribute)
    });
    let value = if from_app.is_some() { from_app } else { copy_attr(&sys, kAXFocusedUIElementAttribute) };
    let value = if value.is_some() {
        value
    } else if !allow_bundle.is_empty() {
        crate::walk::app_element(allow_bundle).ok().and_then(|(_pid, app)| copy_attr(&app, kAXFocusedUIElementAttribute))
    } else {
        None
    };
    let Some(value) = value else {
        return Ok((false, "no focused accessibility element".into(), None));
    };
    if !is_element(&value) {
        return Ok((false, "focused attribute was not an element".into(), None));
    }
    let el = El::retain(value.as_CFTypeRef() as AXUIElementRef).ok_or("focused element was null")?;
    let pid = pid_of(&el);
    let bundle = bundle_id_for_pid(pid);
    if !allow_bundle.is_empty() && bundle != allow_bundle {
        return Ok((false, "focused element is outside the allowed app".into(), None));
    }
    let geom = geom_for_pid(pid);
    let node = describe(&el, &ancestor_path(&el), &bundle, pid, &geom);
    let text = is_text_role(&node.role);
    let reason = if text { String::new() } else { format!("focused element is {}, not a text control", node.role) };
    Ok((text, reason, Some(node)))
}
