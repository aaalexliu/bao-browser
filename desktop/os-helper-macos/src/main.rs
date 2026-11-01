//! macOS Accessibility helper. Hit tests use AXUIElementCopyElementAtPosition
//! on the system-wide element. Press and set-value look the element up again
//! by role and name. They do not click a stored coordinate.

mod act;
mod ae;
mod apps;
mod drag;
mod element;
mod fixture;
mod model;
mod keys;
mod perms;
mod query;
mod sample;
mod walk;
mod win;

use std::path::PathBuf;

use model::Seg;
use serde_json::{json, Value};

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn need<'a>(args: &'a [String], name: &str) -> Result<String, String> {
    flag(args, name).ok_or_else(|| format!("{name} is required"))
}

fn num(args: &[String], name: &str) -> Result<f64, String> {
    need(args, name)?.parse().map_err(|_| format!("{name} is not a number"))
}

fn pid_flag(args: &[String]) -> Result<Option<i32>, String> {
    match flag(args, "--pid") {
        None => Ok(None),
        Some(raw) => raw.parse::<i32>().map(Some).map_err(|_| "--pid is not a number".to_string()),
    }
}

fn frame_flag(args: &[String]) -> Option<(f64, f64, f64, f64)> {
    let x = flag(args, "--frame-x")?.parse::<f64>().ok()?;
    let y = flag(args, "--frame-y")?.parse::<f64>().ok()?;
    let w = flag(args, "--frame-w")?.parse::<f64>().ok()?;
    let h = flag(args, "--frame-h")?.parse::<f64>().ok()?;
    Some((x, y, w, h))
}

fn bundle_or_pid(args: &[String]) -> Result<String, String> {
    if let Some(bundle) = flag(args, "--bundle") {
        return Ok(bundle);
    }
    if pid_flag(args)?.is_some() {
        return Ok(String::new());
    }
    Err("--bundle or --pid is required".into())
}

fn path_arg(args: &[String]) -> Result<Vec<Seg>, String> {
    match flag(args, "--path") {
        None => Ok(Vec::new()),
        Some(raw) => serde_json::from_str(&raw).map_err(|e| format!("--path json: {e}")),
    }
}

fn node_json(node: &model::Node) -> Value {
    serde_json::to_value(node).unwrap_or(Value::Null)
}

fn hit_json(useful: bool, reason: String, node: Option<model::Node>) -> Value {
    let mut v = json!({ "ok": true, "useful": useful, "reason": reason });
    if let Some(node) = node {
        v["element"] = node_json(&node);
        v["app"] = json!(node.app);
        v["role"] = json!(node.role);
        v["name"] = json!(node.name);
        v["path"] = json!(node.path);
    }
    v
}

fn run(args: &[String]) -> Result<Value, String> {
    let cmd = args.first().map(|s| s.as_str()).unwrap_or("help");
    match cmd {
        "help" | "--help" => Ok(json!({"ok": true, "commands": ["permissions", "permissions-ax", "nodes", "hit", "focus", "press", "set-value", "read", "focus-role", "windows", "windows-brief", "move-window", "shot", "key", "type-keys", "fixture", "close-window", "drag", "drag-file"]})),
        "permissions" => Ok(perms::report(args.iter().any(|a| a == "--prompt"), false)),
        "permissions-ax" => Ok(perms::report(false, true)),
        "nodes" => {
            let bundle = bundle_or_pid(args)?;
            let (nodes, geom, pid) = walk::tree_pid(&bundle, pid_flag(args)?)?;
            Ok(json!({"ok": true, "pid": pid, "geometry": geom, "nodes": nodes}))
        }
        "hit" => {
            let (useful, reason, node) = query::at_point(num(args, "--x")?, num(args, "--y")?, &flag(args, "--allow-bundle").unwrap_or_default())?;
            Ok(hit_json(useful, reason, node))
        }
        "focus" => {
            let (useful, reason, node) = query::focused(&flag(args, "--allow-bundle").unwrap_or_default())?;
            Ok(hit_json(useful, reason, node))
        }
        "press" => {
            let node = act::press(&bundle_or_pid(args)?, pid_flag(args)?, &need(args, "--role")?, &need(args, "--name")?, &flag(args, "--subrole").unwrap_or_default(), &path_arg(args)?, &flag(args, "--value-prefix").unwrap_or_default())?;
            eprintln!("STRATEGY=ax-press");
            Ok(json!({"ok": true, "strategy": "ax-press", "pid": pid_flag(args)?, "element": node}))
        }
        "screen-locked" => {
            let locked = perms::screen_locked()?;
            Ok(json!({"ok": true, "locked": locked}))
        }
        "set-value" => {
            let node = act::set_value(&bundle_or_pid(args)?, pid_flag(args)?, &need(args, "--role")?, &need(args, "--name")?, &flag(args, "--subrole").unwrap_or_default(), &path_arg(args)?, &need(args, "--value")?)?;
            eprintln!("STRATEGY=ax-set-value");
            Ok(json!({"ok": true, "strategy": "ax-set-value", "element": node}))
        }
        "read" => {
            let (node, value) = act::read_value(&bundle_or_pid(args)?, pid_flag(args)?, &need(args, "--role")?, &need(args, "--name")?, &flag(args, "--subrole").unwrap_or_default(), &path_arg(args)?)?;
            Ok(json!({"ok": true, "value": value, "element": node}))
        }
        "focus-role" => {
            let node = act::focus_role(&need(args, "--bundle")?, &need(args, "--role")?, &flag(args, "--name").unwrap_or_default())?;
            Ok(json!({"ok": true, "strategy": "ax-focus", "element": node}))
        }
        "windows" => {
            let pid = match pid_flag(args)? {
                Some(pid) => pid,
                None => {
                    let bundle = need(args, "--bundle")?;
                    let pids = apps::pids_for_bundle(&bundle);
                    if pids.len() != 1 { return Err(format!("expected one process for {bundle}, found {}", pids.len())); }
                    pids[0]
                }
            };
            let wins = win::windows_for_pid(pid);
            Ok(json!({"ok": true, "pid": pid, "windows": wins.iter().map(|w| json!({"id": w.id, "layer": w.layer, "x": w.frame.x, "y": w.frame.y, "w": w.frame.w, "h": w.frame.h})).collect::<Vec<_>>()}))
        }
        "move-window" => {
            let (before, after, size_error) = act::move_window(&bundle_or_pid(args)?, pid_flag(args)?, args.iter().any(|a| a == "--frontmost"), num(args, "--x")?, num(args, "--y")?, num(args, "--w")?, num(args, "--h")?)?;
            Ok(json!({"ok": true, "before": before, "after": after, "resized": size_error.is_none(), "sizeError": size_error, "frontmost": args.iter().any(|a| a == "--frontmost")}))
        }
        "key" => {
            keys::post_combo(&need(args, "--bundle")?, &need(args, "--combo")?)?;
            eprintln!("STRATEGY=ax-key");
            Ok(json!({"ok": true, "strategy": "ax-key"}))
        }
        "type-keys" => {
            keys::post_text(&need(args, "--bundle")?, &need(args, "--text")?)?;
            eprintln!("STRATEGY=ax-type");
            Ok(json!({"ok": true, "strategy": "ax-type"}))
        }
        "cg-key" => {
            keys::post_cg_combo(&need(args, "--bundle")?, &need(args, "--combo")?)?;
            eprintln!("STRATEGY=cg-key");
            Ok(json!({"ok": true, "strategy": "cg-key"}))
        }
        "cg-type" => {
            keys::post_cg_text(&need(args, "--bundle")?, &need(args, "--text")?)?;
            eprintln!("STRATEGY=cg-type");
            Ok(json!({"ok": true, "strategy": "cg-type"}))
        }
        "fixture" => {
            let manual = flag(args, "--manual").map(|v| v != "off").unwrap_or(true);
            fixture::write_fixture(&need(args, "--bundle")?, &need(args, "--out")?, &flag(args, "--title").unwrap_or_default(), args.iter().any(|a| a == "--focused"), manual)
        }
        "windows-brief" => fixture::windows_brief(&need(args, "--bundle")?, &flag(args, "--allow").unwrap_or_default()),
        "close-window" => fixture::close_matching(&need(args, "--bundle")?, &need(args, "--title")?),
        "raise-window" => fixture::raise_matching(&need(args, "--bundle")?, &need(args, "--title")?),
        "set-window-text" => fixture::set_window_text(&need(args, "--bundle")?, &need(args, "--title")?, &need(args, "--text")?),
        "confirm-text" => fixture::confirm_containing(&need(args, "--bundle")?, &need(args, "--title")?, &need(args, "--text")?),
        "ae-permission" => {
            let pid = pid_flag(args)?.ok_or("--pid is required")?;
            ae::permission(pid, args.iter().any(|a| a == "--ask"))
        }
        "ae-url" => {
            let pid = pid_flag(args)?.ok_or("--pid is required")?;
            ae::active_url(pid)
        }
        "ae-open" => {
            let pid = pid_flag(args)?.ok_or("--pid is required")?;
            ae::open_inspect(pid)
        }
        "ae-close" => {
            let pid = pid_flag(args)?.ok_or("--pid is required")?;
            let id = need(args, "--id")?;
            let restore = flag(args, "--restore").and_then(|raw| raw.parse::<i32>().ok());
            ae::close_tab_id(pid, &id, restore, flag(args, "--window-id").as_deref())
        }
        "checkbox-read" => {
            let pid = pid_flag(args)?.ok_or("--pid is required")?;
            act::checkbox_read(pid, &need(args, "--name")?, frame_flag(args))
        }
        "checkbox-set" => {
            let pid = pid_flag(args)?.ok_or("--pid is required")?;
            let on = match flag(args, "--value").as_deref() {
                Some("1") | Some("true") => true,
                Some("0") | Some("false") => false,
                _ => return Err("--value 1 or 0 is required".into()),
            };
            act::checkbox_set(pid, &need(args, "--name")?, on, frame_flag(args))
        }
        "drag" => drag::drag(num(args, "--from-x")?, num(args, "--from-y")?, num(args, "--to-x")?, num(args, "--to-y")?),
        "drag-file" => Ok(drag::file_drag_fallback(&need(args, "--path")?)),
        "shot" => {
            let out = PathBuf::from(need(args, "--out")?);
            if let Some(id) = flag(args, "--id") {
                let id: u32 = id.parse().map_err(|_| "window id is not a number".to_string())?;
                let (w, h) = win::capture_window(id, &out)?;
                return Ok(json!({"ok": true, "windowId": id, "width": w, "height": h}));
            }
            let pid = match pid_flag(args)? {
                Some(pid) => pid,
                None => {
                    let bundle = need(args, "--bundle")?;
                    let pids = apps::pids_for_bundle(&bundle);
                    if pids.len() != 1 { return Err(format!("expected one process for {bundle}, found {}", pids.len())); }
                    pids[0]
                }
            };
            let win = win::main_window(pid)?;
            let (w, h) = win::capture_window(win.id, &out)?;
            Ok(json!({"ok": true, "windowId": win.id, "width": w, "height": h}))
        }
        other => Err(format!("unknown command {other}")),
    }
}

fn emit(args: &[String], value: &Value) {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".into());
    println!("{text}");
    if let Some(path) = flag(args, "--result") {
        let _ = std::fs::write(path, text);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(value) => emit(&args, &value),
        Err(err) => {
            emit(&args, &json!({"ok": false, "error": err}));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::run;

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().copied().map(str::to_string).collect()
    }

    #[test]
    fn live_permissions_report_accessibility_without_a_screen_capture_result() {
        let result = run(&args(&["permissions-ax"])).unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["prompted"], false);
        assert!(result["accessibility"].is_boolean());
        assert!(result.get("screenCapture").is_none());
    }

    #[test]
    fn removed_commands_are_unknown() {
        for command in [
            "show-menu", "ae-spec", "ae-index", "ae-tabs", "ae-window", "ae-bounds",
            "ae-window-id", "ae-make", "ae-id", "click", "click-pid", "set-checked",
            "frontmost", "activate",
        ] {
            assert_eq!(run(&args(&[command])).unwrap_err(), format!("unknown command {command}"));
        }
    }

    #[test]
    fn cg_and_raise_commands_require_a_bundle_even_with_a_pid() {
        for command in ["cg-key", "cg-type", "raise-window"] {
            assert_eq!(run(&args(&[command, "--pid", "4242"])).unwrap_err(), "--bundle is required");
        }
    }

    #[test]
    fn ae_close_requires_an_id_instead_of_an_index() {
        assert_eq!(run(&args(&["ae-close", "--pid", "4242", "--index", "1"])).unwrap_err(), "--id is required");
    }

    #[test]
    fn remote_debug_commands_require_a_pid() {
        for command in ["ae-permission", "ae-url", "ae-open", "ae-close", "checkbox-read", "checkbox-set"] {
            assert_eq!(run(&args(&[command])).unwrap_err(), "--pid is required");
        }
    }
}
