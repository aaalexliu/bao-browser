//! Raw accessibility dumps for one test window.
//! Menu bars are omitted. A title filter drops every other window without
//! writing that window's title. Strings that are not the test content are
//! replaced before the file is written.

use std::collections::BTreeMap;

use accessibility_sys::{kAXSubroleAttribute, kAXTitleAttribute, AXUIElementPerformAction};
use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use serde_json::{json, Value};

use crate::element::{
    actions, attribute_names, copy_attr, describe_attr, element_attr, element_list, role_of,
    string_attr, El, IDENTIFIER,
};
use crate::model::{Frame, Node};
use crate::sample::element_at_point;
use crate::walk::{app_element, app_element_opts, best_name, harvest_filtered};

const SIDEBAR: &[&str] = &[
    "Desktop", "Documents", "Downloads", "Applications", "iCloud Drive", "AirDrop", "Recents",
    "Movies", "Music", "Pictures", "Home", "Macintosh HD", "Recent", "Shared", "Tags", "Locations",
];

const IMPORTANT: &[&str] = &[
    "AXWindow", "AXSheet", "AXButton", "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField",
    "AXCheckBox", "AXRadioButton", "AXLink", "AXPopUpButton", "AXMenuButton", "AXWebArea",
    "AXStaticText", "AXRow", "AXCell", "AXOutlineRow", "AXImage", "AXHeading", "AXList",
    "AXOutline", "AXToolbar", "AXGroup", "AXScrollArea", "AXSplitGroup",
];

fn normalize_label(input: &str) -> String {
    let mut out = String::new();
    for c in input.chars() {
        if c.is_whitespace() {
            out.push(' ');
            continue;
        }
        let isolate = ('\u{200b}'..='\u{200f}').contains(&c)
            || ('\u{202a}'..='\u{202e}').contains(&c)
            || ('\u{2066}'..='\u{2069}').contains(&c)
            || c == '\u{feff}';
        if !isolate {
            out.push(c);
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn sidebar_hit(raw: &str) -> bool {
    let label = normalize_label(raw);
    if label.to_ascii_lowercase().contains("icloud") {
        return true;
    }
    SIDEBAR.iter().any(|name| {
        label == *name
            || label.starts_with(&format!("{name} "))
            || label.starts_with(&format!("{name}-"))
            || label.starts_with(&format!("{name}—"))
    })
}

pub fn redact(input: &str) -> String {
    if sidebar_hit(input) {
        return "[sidebar]".into();
    }
    let mut out = input.to_string();
    if let Ok(user) = std::env::var("USER") {
        if user.len() >= 3 && out.contains(&user) {
            out = out.replace(&user, "[user]");
        }
    }
    out = scrub_home(&out);
    if out.contains("[home]") || out.contains("/Library/") || out.contains("~/") {
        if !out.contains("/tmp/") {
            return "[redacted-path]".into();
        }
    }
    out = scrub_emails(&out);
    let lower = out.to_ascii_lowercase();
    if lower.contains("password") || lower.contains("secret") || lower.contains("api_key") || lower.contains("apikey") || lower.contains("bearer ") {
        return "[redacted]".into();
    }
    let count = out.chars().count();
    if count > 180 {
        let mut clipped: String = out.chars().take(180).collect();
        clipped.push_str("...");
        return clipped;
    }
    out
}

fn scrub_home(input: &str) -> String {
    let mut out = input.to_string();
    for needle in ["/Users/", "/users/"] {
        while let Some(idx) = out.find(needle) {
            let start = idx;
            let name_at = idx + needle.len();
            let rest = &out[name_at..];
            let name_len = rest.find(|c: char| c == '/' || c.is_whitespace() || c == '"' || c == '\'').unwrap_or(rest.len());
            let end = name_at + name_len;
            out.replace_range(start..end, "[home]");
        }
    }
    out
}

fn scrub_emails(input: &str) -> String {
    let mut out = String::new();
    for token in input.split_inclusive(|c: char| c.is_whitespace()) {
        let core = token.trim();
        if core.contains('@') && core.contains('.') {
            let lead = &token[..token.find(core).unwrap_or(0)];
            let trail_at = lead.len() + core.len();
            out.push_str(lead);
            out.push_str("[redacted]");
            out.push_str(&token[trail_at..]);
        } else {
            out.push_str(token);
        }
    }
    out
}

fn redact_value(value: &mut Value) {
    match value {
        Value::String(text) => *text = redact(text),
        Value::Array(items) => {
            for item in items {
                redact_value(item);
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                redact_value(item);
            }
        }
        _ => {}
    }
}

fn menuish(node: &Node) -> bool {
    node.role == "AXMenuBar"
        || node.role == "AXMenuBarItem"
        || node.path.iter().any(|seg| seg.role == "AXMenuBar")
}

fn window_name(node: &Node) -> String {
    if node.role == "AXWindow" {
        return node.name.clone();
    }
    if let Some(seg) = node.path.iter().rev().find(|seg| seg.role == "AXWindow") {
        if !seg.name.is_empty() {
            return seg.name.clone();
        }
    }
    if node.role == "AXSheet" {
        return node.name.clone();
    }
    node.path.iter().rev().find(|seg| seg.role == "AXSheet").map(|seg| seg.name.clone()).unwrap_or_default()
}

fn round_frame(frame: &Frame) -> Value {
    json!({
        "x": frame.x.round() as i64,
        "y": frame.y.round() as i64,
        "w": frame.w.round() as i64,
        "h": frame.h.round() as i64,
    })
}

fn child_brief(el: &El) -> Value {
    let role = role_of(el);
    let title = string_attr(el, kAXTitleAttribute);
    let description = string_attr(el, "AXDescription");
    let identifier = string_attr(el, IDENTIFIER);
    json!({
        "role": role,
        "name": best_name(&title, &description, &identifier),
        "identifier": identifier,
    })
}

fn dump_node(el: &El, node: &Node) -> Value {
    el.timeout_secs(0.8);
    let mut attrs = BTreeMap::new();
    for name in attribute_names(el) {
        let Some(raw) = copy_attr(el, &name) else {
            attrs.insert(name, Value::Null);
            continue;
        };
        attrs.insert(name, Value::String(describe_attr(&raw)));
    }
    let children_raw = copy_attr(el, "AXChildren").map(|v| element_list(&v)).unwrap_or_default();
    let child_count = children_raw.len();
    let children: Vec<Value> = children_raw.iter().take(60).map(child_brief).collect();
    let enabled = match string_attr(el, "AXEnabled").as_str() {
        "true" | "1" => Some(true),
        "false" | "0" => Some(false),
        _ => None,
    };
    let focused = match string_attr(el, "AXFocused").as_str() {
        "true" | "1" => Some(true),
        "false" | "0" => Some(false),
        _ => None,
    };
    json!({
        "role": node.role,
        "subrole": node.subrole,
        "identifier": string_attr(el, IDENTIFIER),
        "title": string_attr(el, kAXTitleAttribute),
        "description": string_attr(el, "AXDescription"),
        "label": string_attr(el, "AXLabel"),
        "value": string_attr(el, "AXValue"),
        "frame": node.frame.as_ref().map(round_frame),
        "enabled": enabled,
        "focused": focused,
        "actions": actions(el),
        "children": children,
        "childCount": child_count,
        "childrenTruncated": child_count > 60,
        "attrs": attrs,
    })
}

fn keep_node(node: &Node, title: &str) -> bool {
    if menuish(node) {
        return false;
    }
    if title.is_empty() {
        return true;
    }
    if node.role == "AXApplication" {
        return true;
    }
    window_name(node).contains(title)
}

fn focused_title(app: &El) -> String {
    element_attr(app, "AXFocusedWindow").map(|el| string_attr(&el, kAXTitleAttribute)).unwrap_or_default()
}

fn product_version() -> String {
    let out = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output();
    match out {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => String::new(),
    }
}

fn samples(pid: i32, frame: &Frame) -> Vec<Value> {
    let step = 48.0;
    let mut out = Vec::new();
    let mut y = step * 0.5;
    while y < frame.h && out.len() < 80 {
        let mut x = step * 0.5;
        while x < frame.w && out.len() < 80 {
            let sx = frame.x + x;
            let sy = frame.y + y;
            if let Some(el) = element_at_point(sx, sy) {
                el.timeout_secs(0.35);
                if crate::element::pid_of(&el) == pid {
                    let role = role_of(&el);
                    let title = string_attr(&el, kAXTitleAttribute);
                    let description = string_attr(&el, "AXDescription");
                    let identifier = string_attr(&el, IDENTIFIER);
                    out.push(json!({
                        "x": sx.round() as i64,
                        "y": sy.round() as i64,
                        "role": role,
                        "name": best_name(&title, &description, &identifier),
                        "identifier": identifier,
                    }));
                }
            }
            x += step;
        }
        y += step;
    }
    out
}

fn limit_nodes(nodes: Vec<Value>) -> (Vec<Value>, bool) {
    if nodes.len() <= 400 {
        return (nodes, false);
    }
    let mut kept: Vec<Value> = nodes.into_iter().filter(|node| {
        node.get("role").and_then(|r| r.as_str()).map(|role| IMPORTANT.contains(&role)).unwrap_or(false)
    }).collect();
    let truncated = kept.len() > 400 || true;
    if kept.len() > 400 {
        kept.truncate(400);
    }
    (kept, truncated)
}

pub fn write_fixture(bundle: &str, out: &str, title: &str, focused_only: bool, manual: bool) -> Result<Value, String> {
    let (_pid, app) = app_element_opts(bundle, manual)?;
    let front = focused_title(&app);
    if focused_only && !title.is_empty() && !front.contains(title) {
        return Err("focused window is not the test window".into());
    }
    let filter = if focused_only && title.is_empty() { front.as_str() } else { title };
    let live = harvest_filtered(bundle, manual, filter, true)?;
    let mut chosen: Vec<Value> = Vec::new();
    let mut window_frame: Option<Frame> = None;
    for (node, el) in live.nodes.iter().zip(live.elems.iter()) {
        if !keep_node(node, filter) {
            continue;
        }
        if focused_only && !filter.is_empty() && node.role != "AXApplication" && !window_name(node).contains(filter) {
            continue;
        }
        if (node.role == "AXWindow" || node.role == "AXSheet") && window_frame.is_none() {
            window_frame = node.frame.clone();
        }
        chosen.push(dump_node(el, node));
    }
    if title_requested(title, focused_only) && window_frame.is_none() {
        return Err("no matching window".into());
    }
    let (chosen, truncated) = limit_nodes(chosen);
    let mut sample_rows = window_frame.as_ref().map(|frame| samples(live.pid, frame)).unwrap_or_default();
    if sample_rows.is_empty() {
        if let Some(frame) = window_frame.as_ref() {
            std::thread::sleep(std::time::Duration::from_millis(250));
            sample_rows = samples(live.pid, frame);
        }
    }
    let mut doc = json!({
        "ok": true,
        "bundle": bundle,
        "os": product_version(),
        "manualAccessibility": manual,
        "titleFilter": title,
        "focusedOnly": focused_only,
        "truncated": truncated,
        "nodeCount": chosen.len(),
        "sampleCount": sample_rows.len(),
        "geometry": {
            "screenW": live.geom.screen_w.round() as i64,
            "screenH": live.geom.screen_h.round() as i64,
            "flipY": live.geom.flip_y,
        },
        "nodes": chosen,
        "samples": sample_rows,
    });
    redact_value(&mut doc);
    if let Some(text) = doc.get("titleFilter").and_then(|v| v.as_str()) {
        if text == "[sidebar]" || text == "[redacted]" || text == "[redacted-path]" {
            return Err("title filter was redacted; refusing to write the fixture".into());
        }
    }
    let body = serde_json::to_string_pretty(&doc).map_err(|err| err.to_string())?;
    std::fs::write(out, body).map_err(|err| format!("write {out}: {err}"))?;
    Ok(json!({
        "ok": true,
        "path": out,
        "nodeCount": doc["nodeCount"],
        "sampleCount": doc["sampleCount"],
        "truncated": truncated,
        "manualAccessibility": manual,
    }))
}

fn title_requested(title: &str, focused_only: bool) -> bool {
    !title.is_empty() || focused_only
}

fn publish_title(title: &str, allow: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() || trimmed == "Open" || trimmed == "Calculator" || trimmed.starts_with("Untitled") {
        return trimmed.to_string();
    }
    if allow.len() >= 4 && trimmed.contains(allow) {
        return redact(trimmed);
    }
    "[omitted]".into()
}

pub fn windows_brief(bundle: &str, allow: &str) -> Result<Value, String> {
    let (_pid, app) = app_element(bundle)?;
    let wins = copy_attr(&app, "AXWindows").map(|v| element_list(&v)).unwrap_or_default();
    let mut rows = Vec::new();
    let mut sheets = 0;
    let mut open_panel = false;
    for win in wins {
        win.timeout_secs(0.8);
        let role = role_of(&win);
        let subrole = string_attr(&win, kAXSubroleAttribute);
        let title = string_attr(&win, kAXTitleAttribute);
        if role == "AXSheet" {
            sheets += 1;
        }
        let kids = copy_attr(&win, "AXChildren").map(|v| element_list(&v)).unwrap_or_default();
        for kid in &kids {
            if role_of(kid) == "AXSheet" {
                sheets += 1;
            }
        }
        let published = publish_title(&title, allow);
        if published == "Open" || subrole.contains("Dialog") {
            open_panel = true;
        }
        rows.push(json!({"role": role, "subrole": subrole, "title": published}));
    }
    if sheets > 0 {
        open_panel = true;
    }
    Ok(json!({"ok": true, "windows": rows, "sheets": sheets, "openPanel": open_panel}))
}

fn collect_text_fields(el: &El, depth: i32, out: &mut Vec<El>) {
    if depth > 14 || out.len() > 12 {
        return;
    }
    let role = role_of(el);
    if matches!(role.as_str(), "AXTextField" | "AXComboBox" | "AXSearchField") {
        if let Some(kept) = El::retain(el.0) {
            out.push(kept);
        }
    }
    if let Some(value) = copy_attr(el, "AXChildren") {
        for child in element_list(&value) {
            collect_text_fields(&child, depth + 1, out);
        }
    }
}

pub fn set_window_text(bundle: &str, title: &str, text: &str) -> Result<Value, String> {
    let (_pid, app) = app_element(bundle)?;
    let win = matching_window(&app, title)?;
    let _ = set_front(&app);
    let action = CFString::new("AXRaise");
    let _ = unsafe { AXUIElementPerformAction(win.0, action.as_concrete_TypeRef()) };
    let mut fields = Vec::new();
    collect_text_fields(&win, 0, &mut fields);
    if fields.is_empty() {
        return Err("matching window has no text field".into());
    }
    let index = fields.iter().position(|el| {
        let blob = format!("{} {}", string_attr(el, "AXDescription"), string_attr(el, IDENTIFIER)).to_ascii_lowercase();
        blob.contains("address") || blob.contains("url") || blob.contains("smart")
    }).unwrap_or(0);
    let field = fields.remove(index);
    crate::element::set_string(&field, "AXValue", text)?;
    let confirm = CFString::new("AXConfirm");
    let confirmed = crate::element::ax_ok(unsafe { AXUIElementPerformAction(field.0, confirm.as_concrete_TypeRef()) }, "AXConfirm").is_ok();
    Ok(json!({"ok": true, "set": true, "confirmed": confirmed, "fields": fields.len() + 1}))
}

pub fn confirm_containing(bundle: &str, title: &str, needle: &str) -> Result<Value, String> {
    if needle.len() < 4 {
        return Err("confirm needle is too short".into());
    }
    let live = harvest_filtered(bundle, true, title, true)?;
    let hit = live.nodes.iter().zip(live.elems.iter()).find(|(node, _)| node.value.contains(needle));
    let Some((_, el)) = hit else {
        return Err("no element contains that text".into());
    };
    let confirm = CFString::new("AXConfirm");
    crate::element::ax_ok(unsafe { AXUIElementPerformAction(el.0, confirm.as_concrete_TypeRef()) }, "AXConfirm")?;
    Ok(json!({"ok": true, "confirmed": true}))
}

pub fn raise_matching(bundle: &str, title: &str) -> Result<Value, String> {
    let (_pid, app) = app_element(bundle)?;
    let win = matching_window(&app, title)?;
    let _ = set_front(&app);
    let action = CFString::new("AXRaise");
    crate::element::ax_ok(unsafe { AXUIElementPerformAction(win.0, action.as_concrete_TypeRef()) }, "AXRaise")?;
    Ok(json!({"ok": true, "raised": true}))
}

fn set_front(app: &El) -> Result<(), String> {
    crate::element::set_bool(app, "AXFrontmost", true)
}

fn matching_window(app: &El, title: &str) -> Result<El, String> {
    if title.len() < 4 {
        return Err("window title is too short".into());
    }
    let wins = copy_attr(app, "AXWindows").map(|v| element_list(&v)).unwrap_or_default();
    let mut hits = Vec::new();
    for win in wins {
        let name = string_attr(&win, kAXTitleAttribute);
        if name.contains(title) {
            hits.push(win);
        }
    }
    match hits.len() {
        1 => Ok(hits.remove(0)),
        0 => Err("no matching window".into()),
        _ => Err("ambiguous window".into()),
    }
}

pub fn close_matching(bundle: &str, title: &str) -> Result<Value, String> {
    let (_pid, app) = app_element(bundle)?;
    let win = matching_window(&app, title)?;
    win.timeout_secs(1.0);
    let kids = copy_attr(&win, "AXChildren").map(|v| element_list(&v)).unwrap_or_default();
    let close = kids.into_iter().find(|el| {
        string_attr(el, kAXSubroleAttribute) == "AXCloseButton" || string_attr(el, "AXDescription") == "close button"
    });
    let Some(close) = close else {
        return Err("matching window has no close button".into());
    };
    let action = CFString::new("AXPress");
    crate::element::ax_ok(unsafe { AXUIElementPerformAction(close.0, action.as_concrete_TypeRef()) }, "AXPress")?;
    Ok(json!({"ok": true, "closed": true}))
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn redacts_home_paths_emails_and_sidebar_names() {
        let home = redact("/Users/example/Library/Autosave Information/Untitled.rtf");
        assert_eq!(home, "[redacted-path]");
        assert_eq!(redact("Desktop"), "[sidebar]");
        assert_eq!(redact("\u{2068}Desktop\u{2069} — Local"), "[sidebar]");
        assert_eq!(redact("iCloud\u{00a0}Drive"), "[sidebar]");
        assert_eq!(redact("a.txt"), "a.txt");
        assert_eq!(redact("/tmp/bao-ax-finder/a.txt"), "/tmp/bao-ax-finder/a.txt");
        assert_eq!(redact("person@example.com"), "[redacted]");
        assert!(redact("bao ax electron").contains("bao ax electron"));
    }
}
