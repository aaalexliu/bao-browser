//! Linux AT-SPI helper for desktop spike 2.
//!
//! Looks up a GTK widget by role and accessible name, then either sets its
//! text (`org.a11y.atspi.EditableText.SetTextContents`) or invokes its
//! `click` action. A missed lookup is a hard failure. Extents are recorded
//! and never used as a click.

use std::env;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use atspi::proxy::accessible::AccessibleProxy;
use atspi::proxy::action::ActionProxy;
use atspi::proxy::component::ComponentProxy;
use atspi::proxy::editable_text::EditableTextProxy;
use atspi::proxy::text::TextProxy;
use atspi::zbus::proxy::CacheProperties;
use atspi::zbus::zvariant::ObjectPath;
use atspi::zbus::names::BusName;
use atspi::{AccessibilityConnection, CoordType, ObjectRefOwned, State};
use serde::Serialize;

type Res<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Clone, Serialize)]
struct Seg {
    role: String,
    name: String,
}

#[derive(Clone)]
struct Hit {
    role: String,
    name: String,
    path: Vec<Seg>,
    dest: String,
    obj_path: String,
}

#[derive(Clone, Serialize)]
struct BBox {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    sw: i32,
    sh: i32,
}

#[derive(Serialize)]
struct OsTarget {
    platform: &'static str,
    app: String,
    role: String,
    name: String,
    path: Vec<Seg>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bbox: Option<BBox>,
    dialog: &'static str,
}

#[derive(Serialize)]
struct OsBody {
    target: OsTarget,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

#[derive(Serialize)]
struct Step {
    action: &'static str,
    label: String,
    ts: u64,
    id: String,
    index: usize,
    surface: &'static str,
    os: OsBody,
}

#[derive(Serialize)]
struct Workflow {
    id: String,
    name: String,
    version: u32,
    #[serde(rename = "startUrl")]
    start_url: String,
    variables: Vec<String>,
    steps: Vec<Step>,
    #[serde(rename = "createdAt")]
    created_at: u64,
}

#[derive(Clone)]
struct Want {
    role: String,
    name: String,
}

struct Opts {
    cmd: String,
    app: String,
    entry: Want,
    confirm: Want,
    value: Option<String>,
    out: Option<String>,
    dump: Option<String>,
    workflow: Option<String>,
    screen: (i32, i32),
    pause_ms: u64,
    x: Option<i32>,
    y: Option<i32>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn parse() -> Res<Opts> {
    let args: Vec<String> = env::args().skip(1).collect();
    let cmd = args.first().cloned().unwrap_or_else(|| "help".into());
    let screen = flag(&args, "--screen").unwrap_or_else(|| "1280x800".into());
    let (sw, sh) = screen
        .split_once('x')
        .ok_or("--screen must look like 1280x800")?;
    Ok(Opts {
        cmd,
        app: flag(&args, "--app").unwrap_or_else(|| "zenity".into()),
        entry: Want {
            role: flag(&args, "--entry-role").unwrap_or_else(|| "text box".into()),
            name: flag(&args, "--entry-name").unwrap_or_else(|| "Name:".into()),
        },
        confirm: Want {
            role: flag(&args, "--confirm-role").unwrap_or_else(|| "button".into()),
            name: flag(&args, "--confirm-name").unwrap_or_else(|| "OK".into()),
        },
        value: flag(&args, "--value"),
        out: flag(&args, "--out"),
        dump: flag(&args, "--dump"),
        workflow: flag(&args, "--workflow"),
        screen: (sw.parse()?, sh.parse()?),
        pause_ms: flag(&args, "--pause-ms")
            .unwrap_or_else(|| "0".into())
            .parse()?,
        x: match flag(&args, "--x") {
            Some(v) => Some(v.parse()?),
            None => None,
        },
        y: match flag(&args, "--y") {
            Some(v) => Some(v.parse()?),
            None => None,
        },
    })
}

fn proxy_builder<'a>(
    conn: &'a atspi::zbus::Connection,
    dest: &str,
    path: &str,
) -> Res<atspi::zbus::proxy::Builder<'a, AccessibleProxy<'a>>> {
    let dest: BusName<'static> = dest.to_string().try_into()?;
    let path: ObjectPath<'static> = path.to_string().try_into()?;
    Ok(AccessibleProxy::builder(conn)
        .cache_properties(CacheProperties::No)
        .destination(dest)?
        .path(path)?)
}

async fn reopen<'a>(
    conn: &'a AccessibilityConnection,
    hit: &Hit,
) -> Res<AccessibleProxy<'a>> {
    Ok(proxy_builder(conn.connection(), &hit.dest, &hit.obj_path)?
        .build()
        .await?)
}

async fn text_of<'a>(acc: &AccessibleProxy<'a>) -> Res<TextProxy<'a>> {
    Ok(TextProxy::builder(acc.inner().connection())
        .cache_properties(CacheProperties::No)
        .destination(acc.inner().destination().to_owned())?
        .path(acc.inner().path().to_owned())?
        .build()
        .await?)
}

async fn editable_of<'a>(acc: &AccessibleProxy<'a>) -> Res<EditableTextProxy<'a>> {
    Ok(EditableTextProxy::builder(acc.inner().connection())
        .cache_properties(CacheProperties::No)
        .destination(acc.inner().destination().to_owned())?
        .path(acc.inner().path().to_owned())?
        .build()
        .await?)
}

async fn action_of<'a>(acc: &AccessibleProxy<'a>) -> Res<ActionProxy<'a>> {
    Ok(ActionProxy::builder(acc.inner().connection())
        .cache_properties(CacheProperties::No)
        .destination(acc.inner().destination().to_owned())?
        .path(acc.inner().path().to_owned())?
        .build()
        .await?)
}

async fn component_of<'a>(acc: &AccessibleProxy<'a>) -> Res<ComponentProxy<'a>> {
    Ok(ComponentProxy::builder(acc.inner().connection())
        .cache_properties(CacheProperties::No)
        .destination(acc.inner().destination().to_owned())?
        .path(acc.inner().path().to_owned())?
        .build()
        .await?)
}

fn hit_from(acc_dest: &str, acc_path: &str, role: String, name: String, path: Vec<Seg>) -> Hit {
    Hit {
        role,
        name,
        path,
        dest: acc_dest.to_string(),
        obj_path: acc_path.to_string(),
    }
}

async fn collect(conn: &AccessibilityConnection, app: &AccessibleProxy<'_>) -> Res<Vec<Hit>> {
    let mut out = Vec::new();
    let mut stack = vec![(
        app.inner().destination().to_string(),
        app.inner().path().to_string(),
        Vec::<Seg>::new(),
    )];
    let mut guard = 0;
    while let Some((dest, obj_path, ancestors)) = stack.pop() {
        guard += 1;
        if guard > 500 {
            return Err("accessibility tree exceeded 500 nodes".into());
        }
        if ancestors.len() > 24 {
            continue;
        }
        let node = proxy_builder(conn.connection(), &dest, &obj_path)?
            .build()
            .await?;
        let role = node.get_role_name().await.unwrap_or_else(|_| "?".into());
        let name = node.name().await.unwrap_or_default();
        let children = node.get_children().await.unwrap_or_default();
        out.push(hit_from(&dest, &obj_path, role.clone(), name.clone(), ancestors.clone()));
        let mut child_anc = ancestors;
        child_anc.push(Seg { role, name });
        for child in children.into_iter().rev() {
            if child.is_null() {
                continue;
            }
            let Some(child_name) = child.name() else { continue };
            stack.push((
                child_name.to_string(),
                child.path().to_string(),
                child_anc.clone(),
            ));
        }
    }
    Ok(out)
}

fn render_tree(hits: &[Hit]) -> String {
    let mut s = String::new();
    for h in hits {
        let indent = "  ".repeat(h.path.len());
        s.push_str(&format!("{indent}{} {:?}\n", h.role, h.name));
    }
    s
}

fn lookup<'a>(hits: &'a [Hit], want: &Want) -> Res<&'a Hit> {
    let matches: Vec<&Hit> = hits
        .iter()
        .filter(|h| h.role == want.role && h.name == want.name)
        .collect();
    match matches.len() {
        1 => Ok(matches[0]),
        0 => Err(format!(
            "accessible lookup missed role={:?} name={:?}; refusing coordinate fallback",
            want.role, want.name
        )
        .into()),
        n => Err(format!(
            "accessible lookup ambiguous ({n} matches) role={:?} name={:?}; refusing coordinate fallback",
            want.role, want.name
        )
        .into()),
    }
}

async fn find_app<'a>(
    conn: &'a AccessibilityConnection,
    app_name: &str,
) -> Res<AccessibleProxy<'a>> {
    let root = conn.root_accessible_on_registry().await?;
    let children: Vec<ObjectRefOwned> = root.get_children().await?;
    let mut seen = Vec::new();
    for child in children {
        if child.is_null() {
            continue;
        }
        let Some(name) = child.name() else { continue };
        let proxy = proxy_builder(conn.connection(), name.as_str(), child.path().as_str())?
            .build()
            .await?;
        let got = proxy.name().await.unwrap_or_default();
        seen.push(got.clone());
        if got == app_name {
            return Ok(proxy);
        }
    }
    Err(format!("no accessible application {app_name:?}; saw {seen:?}").into())
}

async fn wait_app(conn: &AccessibilityConnection, app_name: &str) -> Res<Vec<Hit>> {
    let mut last = String::new();
    for _ in 0..40 {
        match find_app(conn, app_name).await {
            Ok(app) => return collect(conn, &app).await,
            Err(err) => last = err.to_string(),
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    Err(last.into())
}

async fn extents(acc: &AccessibleProxy<'_>, screen: (i32, i32)) -> Option<BBox> {
    let comp = component_of(acc).await.ok()?;
    let (x, y, w, h) = comp.get_extents(CoordType::Screen).await.ok()?;
    Some(BBox { x, y, w, h, sw: screen.0, sh: screen.1 })
}

fn target(app: &str, hit: &Hit, bbox: Option<BBox>) -> OsTarget {
    OsTarget {
        platform: "linux",
        app: app.to_string(),
        role: hit.role.clone(),
        name: hit.name.clone(),
        path: hit.path.clone(),
        bbox,
        dialog: "save",
    }
}

async fn set_value(conn: &AccessibilityConnection, hit: &Hit, value: &str) -> Res<()> {
    let acc = reopen(conn, hit).await?;
    let text = text_of(&acc).await?;
    let before = text.get_text(0, -1).await.unwrap_or_default();
    let count_before = text.character_count().await?;
    println!("ENTRY_GET_TEXT={before:?}");
    println!("ENTRY_CHAR_COUNT_BEFORE={count_before}");
    let edit = editable_of(&acc).await?;
    let ok = edit.set_text_contents(value).await?;
    println!("SET_TEXT_CONTENTS={ok}");
    if !ok {
        return Err("EditableText.SetTextContents returned false".into());
    }
    let count_after = text.character_count().await?;
    println!("ENTRY_CHAR_COUNT_AFTER={count_after}");
    let expect = value.chars().count() as i32;
    if count_after != expect {
        return Err(format!(
            "character count {count_after} != {expect} after SetTextContents; not confirming"
        )
        .into());
    }
    println!("STRATEGY=atspi-editable-text");
    Ok(())
}

async fn press(conn: &AccessibilityConnection, hit: &Hit) -> Res<()> {
    let acc = reopen(conn, hit).await?;
    let action = action_of(&acc).await?;
    let n = action.n_actions().await?;
    println!("CONFIRM_NACTIONS={n}");
    if n < 1 {
        return Err(format!(
            "confirm control {:?} has no AT-SPI action; refusing coordinate fallback",
            hit.name
        )
        .into());
    }
    let mut index = 0;
    let mut chosen = String::new();
    for i in 0..n {
        let name = action.get_name(i).await.unwrap_or_default();
        println!("CONFIRM_ACTION_{i}={name}");
        if name == "click" {
            index = i;
            chosen = name;
            break;
        }
        if chosen.is_empty() {
            chosen = name;
        }
    }
    let did = action.do_action(index).await?;
    println!("CONFIRM_DO_ACTION index={index} name={chosen} result={did}");
    if !did {
        return Err("Action.doAction returned false".into());
    }
    println!("STRATEGY=atspi-action");
    Ok(())
}

fn load_steps(path: &str) -> Res<serde_json::Value> {
    let raw = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw)?)
}

fn want_from_step(step: &serde_json::Value) -> Res<(String, Want)> {
    let os = step.get("os").ok_or("step missing os")?;
    let target = os.get("target").ok_or("step missing os.target")?;
    let app = target
        .get("app")
        .and_then(|v| v.as_str())
        .ok_or("os.target.app")?
        .to_string();
    let role = target
        .get("role")
        .and_then(|v| v.as_str())
        .ok_or("os.target.role")?
        .to_string();
    let name = target
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("os.target.name")?
        .to_string();
    Ok((app, Want { role, name }))
}

#[tokio::main]
async fn main() -> Res<()> {
    let opts = parse()?;
    if opts.cmd == "help" || opts.cmd == "--help" {
        eprintln!(
            "usage: bao-os-helper dump|record|confirm|replay|nodes|hit|focus|press|read\n  \
             record --value FILENAME --out workflow.json [--dump tree.txt]\n  \
             confirm|replay --workflow workflow.json\n  \
             hit --x N --y N\n  \
             press|read --app NAME --entry-role ROLE --entry-name NAME"
        );
        return Ok(());
    }

    let conn = AccessibilityConnection::new().await?;
    match opts.cmd.as_str() {
        "dump" => {
            let hits = wait_app(&conn, &opts.app).await?;
            let tree = render_tree(&hits);
            print!("{tree}");
            if let Some(path) = &opts.dump {
                fs::write(path, &tree)?;
            }
            println!("NODES={}", hits.len());
        }
        "record" => {
            let value = opts
                .value
                .clone()
                .ok_or("--value is required (basename only)")?;
            if value.contains('/') || value.contains('\\') {
                return Err("--value must be a basename, not a path".into());
            }
            let out = opts.out.clone().ok_or("--out is required")?;
            let hits = wait_app(&conn, &opts.app).await?;
            let tree = render_tree(&hits);
            print!("{tree}");
            if let Some(path) = &opts.dump {
                fs::write(path, &tree)?;
            }
            println!("NODES={}", hits.len());
            let entry = lookup(&hits, &opts.entry)?.clone();
            let confirm = lookup(&hits, &opts.confirm)?.clone();
            println!(
                "LOOKUP entry role={:?} name={:?} path_len={}",
                entry.role,
                entry.name,
                entry.path.len()
            );
            println!(
                "LOOKUP confirm role={:?} name={:?} path_len={}",
                confirm.role,
                confirm.name,
                confirm.path.len()
            );
            set_value(&conn, &entry, &value).await?;
            let entry_acc = reopen(&conn, &entry).await?;
            let confirm_acc = reopen(&conn, &confirm).await?;
            println!("ENTRY_ROLE_ENUM={:?}", entry_acc.get_role().await?);
            println!("CONFIRM_ROLE_ENUM={:?}", confirm_acc.get_role().await?);
            let ts = now_ms();
            let workflow = Workflow {
                id: "spike2-os-save".into(),
                name: "Spike 2 native save dialog".into(),
                version: 2,
                start_url: String::new(),
                variables: vec![],
                created_at: ts,
                steps: vec![
                    Step {
                        action: "osSetValue",
                        label: format!("Set filename to {value}"),
                        ts,
                        id: "os-set-filename".into(),
                        index: 0,
                        surface: "os",
                        os: OsBody {
                            target: target(&opts.app, &entry, extents(&entry_acc, opts.screen).await),
                            value: Some(value),
                        },
                    },
                    Step {
                        action: "osConfirm",
                        label: format!("Press {}", confirm.name),
                        ts,
                        id: "os-confirm".into(),
                        index: 1,
                        surface: "os",
                        os: OsBody {
                            target: target(
                                &opts.app,
                                &confirm,
                                extents(&confirm_acc, opts.screen).await,
                            ),
                            value: None,
                        },
                    },
                ],
            };
            fs::write(&out, serde_json::to_string_pretty(&workflow)?)?;
            println!("WROTE={out}");
            println!("RECORD_CONFIRM_DEFERRED=1");
        }
        "confirm" | "replay" => {
            let path = opts.workflow.clone().ok_or("--workflow is required")?;
            let doc = load_steps(&path)?;
            let steps = doc
                .get("steps")
                .and_then(|s| s.as_array())
                .ok_or("workflow.steps")?;
            if doc.get("version").and_then(|v| v.as_u64()) != Some(2) {
                return Err("workflow version is not 2".into());
            }
            let set = steps
                .iter()
                .find(|s| s.get("action").and_then(|a| a.as_str()) == Some("osSetValue"))
                .ok_or("missing osSetValue")?;
            let confirm = steps
                .iter()
                .find(|s| s.get("action").and_then(|a| a.as_str()) == Some("osConfirm"))
                .ok_or("missing osConfirm")?;
            let value = set
                .pointer("/os/value")
                .and_then(|v| v.as_str())
                .ok_or("osSetValue missing value")?
                .to_string();
            let (set_app, set_want) = want_from_step(set)?;
            let (confirm_app, confirm_want) = want_from_step(confirm)?;
            if set_app != confirm_app {
                return Err("os steps name different apps".into());
            }
            let hits = wait_app(&conn, &set_app).await?;
            if opts.cmd == "replay" {
                let entry = lookup(&hits, &set_want)?.clone();
                set_value(&conn, &entry, &value).await?;
                if opts.pause_ms > 0 {
                    println!("PAUSE_MS={}", opts.pause_ms);
                    tokio::time::sleep(std::time::Duration::from_millis(opts.pause_ms)).await;
                }
            }
            let hits = if opts.cmd == "replay" {
                wait_app(&conn, &set_app).await?
            } else {
                hits
            };
            let button = lookup(&hits, &confirm_want)?.clone();
            press(&conn, &button).await?;
            println!("APPLIED={}", opts.cmd);
        }
        "nodes" => {
            let geoms = collect_geoms(&conn, opts.screen).await?;
            println!("{}", serde_json::to_string(&geoms_json(&geoms))?);
        }
        "hit" => {
            let x = opts.x.ok_or("--x is required")?;
            let y = opts.y.ok_or("--y is required")?;
            let geoms = collect_geoms(&conn, opts.screen).await?;
            println!("{}", serde_json::to_string(&hit_test(&geoms, x, y))?);
        }
        "focus" => {
            let geoms = collect_geoms(&conn, opts.screen).await?;
            let focused = focused_geom(&conn, &geoms).await?;
            println!("{}", serde_json::to_string(&focused)?);
        }
        "press" => {
            let geoms = collect_geoms(&conn, opts.screen).await?;
            let geom = unique_geom(&geoms, &opts.app, &opts.entry)?;
            let hit = Hit {
                role: geom.role.clone(),
                name: geom.name.clone(),
                path: geom.path.clone(),
                dest: geom.dest.clone(),
                obj_path: geom.obj_path.clone(),
            };
            invoke_action(&conn, &hit).await?;
            let live = extents(&reopen(&conn, &hit).await?, opts.screen).await;
            println!(
                "{}",
                serde_json::to_string(&serde_json::json!({
                    "ok": true,
                    "strategy": "atspi-action",
                    "app": geom.app,
                    "role": geom.role,
                    "name": geom.name,
                    "bbox": live,
                }))?
            );
        }
        "read" => {
            let geoms = collect_geoms(&conn, opts.screen).await?;
            let names: Vec<&str> = geoms
                .iter()
                .filter(|g| g.app == opts.app && g.role == opts.entry.role && !g.name.is_empty())
                .map(|g| g.name.as_str())
                .collect();
            println!(
                "{}",
                serde_json::to_string(&serde_json::json!({ "ok": true, "names": names }))?
            );
        }
        other => return Err(format!("unknown command {other}").into()),
    }
    Ok(())
}

#[derive(Clone)]
struct Geom {
    app: String,
    role: String,
    name: String,
    path: Vec<Seg>,
    dest: String,
    obj_path: String,
    bbox: BBox,
    actions: i32,
}

fn geoms_json(geoms: &[Geom]) -> serde_json::Value {
    serde_json::json!(geoms
        .iter()
        .map(|g| serde_json::json!({
            "app": g.app,
            "role": g.role,
            "name": g.name,
            "path": g.path,
            "bbox": g.bbox,
            "actions": g.actions,
        }))
        .collect::<Vec<_>>())
}

fn contains_point(b: &BBox, x: i32, y: i32) -> bool {
    b.w > 0 && b.h > 0 && x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h
}

fn hit_test(geoms: &[Geom], x: i32, y: i32) -> serde_json::Value {
    let mut hits: Vec<&Geom> = geoms.iter().filter(|g| contains_point(&g.bbox, x, y)).collect();
    if hits.is_empty() {
        return serde_json::json!({
            "ok": false,
            "reason": "no accessible at point",
            "strategy": "extents",
        });
    }
    hits.sort_by_key(|g| (g.bbox.w as i64) * (g.bbox.h as i64));
    let best = (hits[0].bbox.w as i64) * (hits[0].bbox.h as i64);
    let smallest: Vec<&Geom> = hits
        .into_iter()
        .filter(|g| (g.bbox.w as i64) * (g.bbox.h as i64) == best)
        .collect();
    let same = smallest.iter().all(|g| g.role == smallest[0].role && g.name == smallest[0].name);
    if smallest.len() > 1 && !same {
        return serde_json::json!({
            "ok": false,
            "reason": "ambiguous geometry",
            "strategy": "extents",
            "candidates": smallest.len(),
        });
    }
    let winner = smallest[0];
    if winner.name.is_empty() || winner.actions < 1 {
        return serde_json::json!({
            "ok": false,
            "reason": format!(
                "no actionable accessible at point (role {}, name {:?})",
                winner.role, winner.name
            ),
            "strategy": "extents",
            "role": winner.role,
            "name": winner.name,
        });
    }
    serde_json::json!({
        "ok": true,
        "strategy": "extents",
        "app": winner.app,
        "role": winner.role,
        "name": winner.name,
        "path": winner.path,
        "bbox": winner.bbox,
        "actions": winner.actions,
    })
}

fn unique_geom<'a>(geoms: &'a [Geom], app: &str, want: &Want) -> Res<&'a Geom> {
    let matches: Vec<&Geom> = geoms
        .iter()
        .filter(|g| g.app == app && g.role == want.role && g.name == want.name)
        .collect();
    match matches.len() {
        1 => Ok(matches[0]),
        0 => Err(format!(
            "accessible lookup missed app={app:?} role={:?} name={:?}; refusing coordinate fallback",
            want.role, want.name
        )
        .into()),
        n => Err(format!("accessible lookup ambiguous ({n}); refusing coordinate fallback").into()),
    }
}

async fn invoke_action(conn: &AccessibilityConnection, hit: &Hit) -> Res<()> {
    let acc = reopen(conn, hit).await?;
    let action = action_of(&acc).await?;
    let n = action.n_actions().await?;
    if n < 1 {
        return Err(format!("{:?} has no AT-SPI action; refusing coordinate fallback", hit.name).into());
    }
    let mut index = 0;
    for i in 0..n {
        let name = action.get_name(i).await.unwrap_or_default();
        if name == "click" {
            index = i;
            break;
        }
    }
    let did = action.do_action(index).await?;
    if !did {
        return Err("Action.doAction returned false".into());
    }
    Ok(())
}

async fn focused_geom(conn: &AccessibilityConnection, geoms: &[Geom]) -> Res<serde_json::Value> {
    let mut found: Option<&Geom> = None;
    for geom in geoms {
        let acc = reopen(
            conn,
            &Hit {
                role: geom.role.clone(),
                name: geom.name.clone(),
                path: geom.path.clone(),
                dest: geom.dest.clone(),
                obj_path: geom.obj_path.clone(),
            },
        )
        .await?;
        let Ok(state) = acc.get_state().await else { continue };
        if state.contains(State::Focused) {
            found = Some(geom);
        }
    }
    let Some(geom) = found else {
        return Ok(serde_json::json!({ "ok": false, "reason": "nothing focused" }));
    };
    Ok(serde_json::json!({
        "ok": true,
        "app": geom.app,
        "role": geom.role,
        "name": geom.name,
        "path": geom.path,
        "actions": geom.actions,
    }))
}

async fn collect_geoms(conn: &AccessibilityConnection, screen: (i32, i32)) -> Res<Vec<Geom>> {
    let root = conn.root_accessible_on_registry().await?;
    let children = root.get_children().await?;
    let mut out = Vec::new();
    for child in children {
        if child.is_null() {
            continue;
        }
        let Some(child_name) = child.name() else { continue };
        let proxy = proxy_builder(conn.connection(), child_name.as_str(), child.path().as_str())?
            .build()
            .await?;
        let app_name = proxy.name().await.unwrap_or_default();
        let mut stack = vec![(
            child_name.to_string(),
            child.path().to_string(),
            Vec::<Seg>::new(),
            app_name,
        )];
        while let Some((dest, obj_path, ancestors, app)) = stack.pop() {
            if out.len() > 800 || ancestors.len() > 24 {
                continue;
            }
            let node = proxy_builder(conn.connection(), &dest, &obj_path)?.build().await?;
            let role = node.get_role_name().await.unwrap_or_else(|_| "?".into());
            let name = node.name().await.unwrap_or_default();
            let actions = match action_of(&node).await {
                Ok(action) => action.n_actions().await.unwrap_or(0),
                Err(_) => 0,
            };
            if let Some(bbox) = extents(&node, screen).await {
                out.push(Geom {
                    app: app.clone(),
                    role: role.clone(),
                    name: name.clone(),
                    path: ancestors.clone(),
                    dest: dest.clone(),
                    obj_path: obj_path.clone(),
                    bbox,
                    actions,
                });
            }
            let children = node.get_children().await.unwrap_or_default();
            let mut child_anc = ancestors;
            child_anc.push(Seg { role, name });
            for child in children.into_iter().rev() {
                if child.is_null() {
                    continue;
                }
                let Some(child_name) = child.name() else { continue };
                stack.push((
                    child_name.to_string(),
                    child.path().to_string(),
                    child_anc.clone(),
                    app.clone(),
                ));
            }
        }
    }
    Ok(out)
}
