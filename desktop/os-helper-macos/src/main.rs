//! macOS Accessibility helper. Hit tests use AXUIElementCopyElementAtPosition
//! on the system-wide element. Press and set-value look the element up again
//! by role and name. They do not click a stored coordinate.

mod act;
mod apps;
mod element;
mod model;
mod perms;
mod query;
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
        "help" | "--help" => Ok(json!({"ok": true, "commands": ["permissions", "nodes", "hit", "focus", "press", "set-value", "read", "focus-role", "windows", "move-window", "shot"]})),
        "permissions" => Ok(perms::report(args.iter().any(|a| a == "--prompt"))),
        "nodes" => {
            let bundle = need(args, "--bundle")?;
            let (nodes, geom, pid) = walk::tree(&bundle)?;
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
            let node = act::press(&need(args, "--bundle")?, &need(args, "--role")?, &need(args, "--name")?, &flag(args, "--subrole").unwrap_or_default(), &path_arg(args)?)?;
            eprintln!("STRATEGY=ax-press");
            Ok(json!({"ok": true, "strategy": "ax-press", "element": node}))
        }
        "set-value" => {
            let node = act::set_value(&need(args, "--bundle")?, &need(args, "--role")?, &need(args, "--name")?, &flag(args, "--subrole").unwrap_or_default(), &path_arg(args)?, &need(args, "--value")?)?;
            eprintln!("STRATEGY=ax-set-value");
            Ok(json!({"ok": true, "strategy": "ax-set-value", "element": node}))
        }
        "read" => {
            let (node, value) = act::read_value(&need(args, "--bundle")?, &need(args, "--role")?, &need(args, "--name")?, &flag(args, "--subrole").unwrap_or_default(), &path_arg(args)?)?;
            Ok(json!({"ok": true, "value": value, "element": node}))
        }
        "focus-role" => {
            let node = act::focus_role(&need(args, "--bundle")?, &need(args, "--role")?, &flag(args, "--name").unwrap_or_default())?;
            Ok(json!({"ok": true, "strategy": "ax-focus", "element": node}))
        }
        "windows" => {
            let bundle = need(args, "--bundle")?;
            let pids = apps::pids_for_bundle(&bundle);
            if pids.len() != 1 { return Err(format!("expected one process for {bundle}, found {}", pids.len())); }
            let wins = win::windows_for_pid(pids[0]);
            Ok(json!({"ok": true, "pid": pids[0], "windows": wins.iter().map(|w| json!({"id": w.id, "layer": w.layer, "x": w.frame.x, "y": w.frame.y, "w": w.frame.w, "h": w.frame.h})).collect::<Vec<_>>()}))
        }
        "move-window" => {
            let (before, after) = act::move_window(&need(args, "--bundle")?, num(args, "--x")?, num(args, "--y")?, num(args, "--w")?, num(args, "--h")?)?;
            Ok(json!({"ok": true, "before": before, "after": after}))
        }
        "shot" => {
            let bundle = need(args, "--bundle")?;
            let out = PathBuf::from(need(args, "--out")?);
            let pids = apps::pids_for_bundle(&bundle);
            if pids.len() != 1 { return Err(format!("expected one process for {bundle}, found {}", pids.len())); }
            let win = win::main_window(pids[0])?;
            let (w, h) = win::capture_window(win.id, &out)?;
            Ok(json!({"ok": true, "windowId": win.id, "width": w, "height": h, "path": out}))
        }
        other => Err(format!("unknown command {other}")),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(value) => println!("{}", serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".into())),
        Err(err) => {
            println!("{}", serde_json::to_string_pretty(&json!({"ok": false, "error": err})).unwrap());
            std::process::exit(1);
        }
    }
}
