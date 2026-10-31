//! Apple Events to one Chrome pid. Never by bundle id. Never prompts unless asked.

use std::ffi::c_void;

use serde_json::{json, Value};

const CORE: u32 = u32::from_be_bytes(*b"core");
const MAKE: u32 = u32::from_be_bytes(*b"crel");
const GET: u32 = u32::from_be_bytes(*b"getd");
const SET: u32 = u32::from_be_bytes(*b"setd");
const CLOSE: u32 = u32::from_be_bytes(*b"clos");
const WILD: u32 = u32::from_be_bytes(*b"****");
const KPID: u32 = u32::from_be_bytes(*b"kpid");
const TYPE: u32 = u32::from_be_bytes(*b"type");
const NULL: u32 = u32::from_be_bytes(*b"null");
const LONG: u32 = u32::from_be_bytes(*b"long");
const UTF8: u32 = u32::from_be_bytes(*b"utf8");
const WINDOW: u32 = u32::from_be_bytes(*b"cwin");
const TAB: u32 = u32::from_be_bytes(*b"CrTb");
const PROP: u32 = u32::from_be_bytes(*b"prop");
const INDX: u32 = u32::from_be_bytes(*b"indx");
const FORM_PROP: u32 = u32::from_be_bytes(*b"prop");
const FORM_ID: u32 = u32::from_be_bytes(*b"ID  ");
const ACTIVE_INDEX: u32 = u32::from_be_bytes(*b"acTI");
const TAB_ID: u32 = u32::from_be_bytes(*b"ID  ");
const URL_KEY: u32 = u32::from_be_bytes(*b"URL ");
const KOCL: u32 = u32::from_be_bytes(*b"kocl");
const PRDT: u32 = u32::from_be_bytes(*b"prdt");
const DIRECT: u32 = u32::from_be_bytes(*b"----");
const DATA: u32 = u32::from_be_bytes(*b"data");
const NOT_PERMITTED: i32 = -1743;
const WOULD_PROMPT: i32 = -1744;
const WAIT_REPLY: i32 = 3;
const INSPECT: &str = "chrome://inspect/#remote-debugging";

#[repr(C, packed(2))]
struct AEDesc {
    descriptor_type: u32,
    data_handle: *mut c_void,
}

impl Drop for AEDesc {
    fn drop(&mut self) {
        if !self.data_handle.is_null() {
            unsafe { AEDisposeDesc(self) };
        }
    }
}

impl AEDesc {
    fn null() -> Self {
        Self { descriptor_type: NULL, data_handle: std::ptr::null_mut() }
    }
}

#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn AECreateDesc(type_code: u32, data: *const c_void, size: isize, result: *mut AEDesc) -> i32;
    fn AECreateAppleEvent(class: u32, id: u32, target: *const AEDesc, return_id: i16, txn: i32, result: *mut AEDesc) -> i32;
    fn AEPutParamPtr(event: *mut AEDesc, key: u32, type_code: u32, data: *const c_void, size: isize) -> i32;
    fn AEPutParamDesc(event: *mut AEDesc, key: u32, desc: *const AEDesc) -> i32;
    fn AESendMessage(event: *const AEDesc, reply: *mut AEDesc, mode: i32, timeout: isize) -> i32;
    fn AEDisposeDesc(desc: *mut AEDesc) -> i32;
    fn AEDeterminePermissionToAutomateTarget(target: *const AEDesc, class: u32, id: u32, ask: u8) -> i32;
    fn CreateObjSpecifier(class: u32, container: *const AEDesc, form: u32, data: *const AEDesc, dispose: u8, result: *mut AEDesc) -> i32;
    fn AEGetParamPtr(event: *const AEDesc, key: u32, desired: u32, actual: *mut u32, data: *mut c_void, max: isize, actual_size: *mut isize) -> i32;
}

fn desc_bytes(type_code: u32, bytes: &[u8]) -> Result<AEDesc, i32> {
    let mut out = AEDesc::null();
    let err = unsafe { AECreateDesc(type_code, bytes.as_ptr() as *const c_void, bytes.len() as isize, &mut out) };
    if err != 0 { return Err(err); }
    Ok(out)
}

fn desc_type(code: u32) -> Result<AEDesc, i32> {
    desc_bytes(TYPE, &code.to_ne_bytes())
}

fn desc_i32(n: i32) -> Result<AEDesc, i32> {
    desc_bytes(LONG, &n.to_ne_bytes())
}

fn target(pid: i32) -> Result<AEDesc, i32> {
    desc_bytes(KPID, &pid.to_ne_bytes())
}

fn permission_status(pid: i32, ask: bool) -> Result<i32, i32> {
    let target = target(pid)?;
    Ok(unsafe { AEDeterminePermissionToAutomateTarget(&target, WILD, WILD, if ask { 1 } else { 0 }) })
}

pub fn permission(pid: i32, ask: bool) -> Result<Value, String> {
    let status = permission_status(pid, ask).map_err(explain)?;
    let permitted = status == 0;
    let would_prompt = status == WOULD_PROMPT;
    if status != 0 && !would_prompt && status != NOT_PERMITTED {
        return Err(explain(status));
    }
    Ok(json!({
        "ok": true,
        "permitted": permitted,
        "wouldPrompt": would_prompt,
        "denied": status == NOT_PERMITTED,
        "status": status,
        "targetBundle": crate::apps::bundle_id_for_pid(pid),
        "helperPid": std::process::id(),
        "helperParent": unsafe { getppid() },
    }))
}

extern "C" {
    fn getppid() -> i32;
}

fn explain(status: i32) -> String {
    if status == NOT_PERMITTED {
        "BaoOSHelper is not allowed to control Google Chrome. Turn it on in System Settings > Privacy & Security > Automation > BaoOSHelper > Google Chrome, then try again.".into()
    } else if status == WOULD_PROMPT {
        "Automation permission for Google Chrome has not yet been asked.".into()
    } else {
        format!("Apple Event failed ({status})")
    }
}

fn desc_enum(code: u32) -> Result<AEDesc, i32> {
    desc_bytes(u32::from_be_bytes(*b"enum"), &code.to_ne_bytes())
}

fn desc_ordinal(code: u32) -> Result<AEDesc, i32> {
    desc_bytes(u32::from_be_bytes(*b"abso"), &code.to_ne_bytes())
}

fn null_desc() -> Result<AEDesc, i32> {
    desc_bytes(NULL, &[])
}

fn window_one() -> Result<AEDesc, i32> {
    let mut rec = AEDesc::null();
    let err = unsafe { AECreateList(std::ptr::null(), 0, 1, &mut rec) };
    if err != 0 { return Err(err); }
    let want = desc_type(WINDOW)?;
    let err = unsafe { AEPutParamDesc(&mut rec, u32::from_be_bytes(*b"want"), &want) };
    if err != 0 { return Err(err); }
    let from = desc_bytes(NULL, &[])?;
    let err = unsafe { AEPutParamDesc(&mut rec, u32::from_be_bytes(*b"from"), &from) };
    if err != 0 { return Err(err); }
    let form = desc_bytes(u32::from_be_bytes(*b"enum"), &INDX.to_ne_bytes())?;
    let err = unsafe { AEPutParamDesc(&mut rec, u32::from_be_bytes(*b"form"), &form) };
    if err != 0 { return Err(err); }
    let seld = desc_i32(1)?;
    let err = unsafe { AEPutParamDesc(&mut rec, u32::from_be_bytes(*b"seld"), &seld) };
    if err != 0 { return Err(err); }
    let mut spec = AEDesc::null();
    let err = unsafe { AECoerceDesc(&rec, u32::from_be_bytes(*b"obj "), &mut spec) };
    if err != 0 { return Err(err); }
    Ok(spec)
}

fn property_of(container: &AEDesc, prop: u32) -> Result<AEDesc, i32> {
    let key = desc_type(prop)?;
    let mut spec = AEDesc::null();
    let err = unsafe { CreateObjSpecifier(PROP, container, FORM_PROP, &key, 0, &mut spec) };
    if err != 0 { return Err(err); }
    Ok(spec)
}

/// Every Apple Event goes through this. The no-prompt check uses the same pid target as the send.
/// A would-prompt or denied result refuses before AESendMessage, so a wrong target cannot raise a prompt.
fn send(pid: i32, class: u32, id: u32, fill: impl FnOnce(&mut AEDesc) -> Result<(), i32>) -> Result<AEDesc, i32> {
    let status = permission_status(pid, false)?;
    if status != 0 { return Err(status); }
    let target = target(pid)?;
    let mut event = AEDesc::null();
    let err = unsafe { AECreateAppleEvent(class, id, &target, -1, 0, &mut event) };
    if err != 0 { return Err(err); }
    fill(&mut event)?;
    let mut reply = AEDesc::null();
    let err = unsafe { AESendMessage(&event, &mut reply, WAIT_REPLY, 600) };
    if err != 0 { return Err(err); }
    let mut errn = 0i16;
    let mut actual = 0u32;
    let mut size = 0isize;
    let got = unsafe { AEGetParamPtr(&reply, u32::from_be_bytes(*b"errn"), u32::from_be_bytes(*b"shor"), &mut actual, &mut errn as *mut i16 as *mut c_void, 2, &mut size) };
    if got == 0 && errn != 0 {
        return Err(errn as i32);
    }
    Ok(reply)
}

fn get_i32(pid: i32, spec: &AEDesc) -> Result<i32, i32> {
    let reply = send(pid, CORE, GET, |event| {
        let err = unsafe { AEPutParamDesc(event, DIRECT, spec) };
        if err != 0 { Err(err) } else { Ok(()) }
    })?;
    let mut actual = 0u32;
    let mut size = 0isize;
    let mut value = 0i32;
    let err = unsafe { AEGetParamPtr(&reply, DIRECT, LONG, &mut actual, &mut value as *mut i32 as *mut c_void, 4, &mut size) };
    if err != 0 { return Err(err); }
    Ok(value)
}

fn active_index(pid: i32) -> Result<i32, String> {
    let window = window_one().map_err(explain)?;
    let spec = property_of(&window, ACTIVE_INDEX).map_err(explain)?;
    get_i32(pid, &spec).map_err(explain)
}

fn set_active_index(pid: i32, index: i32, window_id: Option<&str>) -> Result<(), String> {
    let window = match window_id {
        Some(id) if !id.is_empty() => window_by_id(id).map_err(explain)?,
        _ => window_one().map_err(explain)?,
    };
    let spec = property_of(&window, ACTIVE_INDEX).map_err(explain)?;
    send(pid, CORE, SET, |event| {
        let err = unsafe { AEPutParamDesc(event, DIRECT, &spec) };
        if err != 0 { return Err(err); }
        let err = unsafe { AEPutParamPtr(event, DATA, LONG, &index.to_ne_bytes() as *const u8 as *const c_void, 4) };
        if err != 0 { Err(err) } else { Ok(()) }
    }).map_err(explain)?;
    Ok(())
}

fn window_uid(pid: i32) -> Result<String, String> {
    let window = window_one().map_err(explain)?;
    let spec = property_of(&window, TAB_ID).map_err(explain)?;
    get_text(pid, &spec).map_err(explain)
}

pub fn window_frame(pid: i32, id: &str) -> Result<(f64, f64, f64, f64), String> {
    let window = window_by_id(id).map_err(explain)?;
    let spec = property_of(&window, u32::from_be_bytes(*b"pbnd")).map_err(explain)?;
    let reply = send(pid, CORE, GET, |event| {
        let err = unsafe { AEPutParamDesc(event, DIRECT, &spec) };
        if err != 0 { Err(err) } else { Ok(()) }
    }).map_err(explain)?;
    let mut rect = [0i16; 4];
    let mut actual = 0u32;
    let mut size = 0isize;
    let err = unsafe { AEGetParamPtr(&reply, DIRECT, u32::from_be_bytes(*b"qdrt"), &mut actual, rect.as_mut_ptr() as *mut c_void, 8, &mut size) };
    if err != 0 { return Err(explain(err)); }
    // Measured qdrt order is top, left, bottom, right. That converts to the AX frame.
    // Reading the four shorts as left, top, right, bottom swaps width and height and matches nothing.
    let top = rect[0] as f64;
    let left = rect[1] as f64;
    let bottom = rect[2] as f64;
    let right = rect[3] as f64;
    Ok((left, top, (right - left).abs(), (bottom - top).abs()))
}

fn window_by_id(id: &str) -> Result<AEDesc, i32> {
    let null = null_desc()?;
    let key = desc_bytes(UTF8, id.as_bytes())?;
    let mut spec = AEDesc::null();
    let err = unsafe { CreateObjSpecifier(WINDOW, &null, FORM_ID, &key, 0, &mut spec) };
    if err != 0 { return Err(err); }
    Ok(spec)
}

fn tabs_of(window: &AEDesc) -> Result<AEDesc, i32> {
    let all = desc_ordinal(u32::from_be_bytes(*b"all "))?;
    let mut spec = AEDesc::null();
    let err = unsafe { CreateObjSpecifier(TAB, window, INDX, &all, 0, &mut spec) };
    if err != 0 { return Err(err); }
    Ok(spec)
}

fn insertion_at_end(container: &AEDesc) -> Result<AEDesc, i32> {
    let mut rec = AEDesc::null();
    let err = unsafe { AECreateList(std::ptr::null(), 0, 1, &mut rec) };
    if err != 0 { return Err(err); }
    let err = unsafe { AEPutParamDesc(&mut rec, u32::from_be_bytes(*b"kobj"), container) };
    if err != 0 { return Err(err); }
    let pos = desc_enum(u32::from_be_bytes(*b"end "))?;
    let err = unsafe { AEPutParamDesc(&mut rec, u32::from_be_bytes(*b"kpos"), &pos) };
    if err != 0 { return Err(err); }
    let mut spec = AEDesc::null();
    let err = unsafe { AECoerceDesc(&rec, u32::from_be_bytes(*b"insl"), &mut spec) };
    if err != 0 { return Err(err); }
    Ok(spec)
}

fn properties_url() -> Result<AEDesc, i32> {
    let mut props = AEDesc::null();
    let err = unsafe { AECreateList(std::ptr::null(), 0, 1, &mut props) };
    if err != 0 { return Err(err); }
    let err = unsafe { AEPutParamPtr(&mut props, URL_KEY, UTF8, INSPECT.as_ptr() as *const c_void, INSPECT.len() as isize) };
    if err != 0 { return Err(err); }
    Ok(props)
}

/// The pid to activate again when `make` or `close` left Chrome in front of another app.
#[cfg_attr(not(test), allow(dead_code))]
pub fn front_to_restore(before: i32, chrome: i32, after: i32) -> Option<i32> {
    if before > 0 && before != chrome && after == chrome { Some(before) } else { None }
}

fn put_front_back(before: i32, chrome: i32) -> Result<Option<i32>, String> {
    if before <= 0 || before == chrome { return Ok(None); }
    let start = std::time::Instant::now();
    let mut restored = None;
    // make_tab's activate lands after the reply. Watch long enough to catch it.
    while start.elapsed() < std::time::Duration::from_millis(900) {
        let after = crate::apps::frontmost_pid().unwrap_or(0);
        if front_to_restore(before, chrome, after).is_some() {
            crate::apps::activate_pid(before)?;
            restored = Some(before);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
    Ok(restored)
}

fn make_tab(pid: i32, window_id: &str) -> Result<(), i32> {
    let window = window_by_id(window_id)?;
    let tabs = tabs_of(&window)?;
    let loc = insertion_at_end(&tabs)?;
    let props = properties_url()?;
    send(pid, CORE, MAKE, |event| {
        let class = desc_type(TAB)?;
        let err = unsafe { AEPutParamDesc(event, KOCL, &class) };
        if err != 0 { return Err(err); }
        let err = unsafe { AEPutParamDesc(event, u32::from_be_bytes(*b"insh"), &loc) };
        if err != 0 { return Err(err); }
        let err = unsafe { AEPutParamDesc(event, PRDT, &props) };
        if err != 0 { Err(err) } else { Ok(()) }
    })?;
    Ok(())
}

pub fn active_url(pid: i32) -> Result<Value, String> {
    let index = active_index(pid)?;
    let url = tab_url(pid, index, None)?;
    Ok(json!({"ok": true, "pid": pid, "index": index, "url": url}))
}

fn tab_url(pid: i32, index: i32, window_id: Option<&str>) -> Result<String, String> {
    let tab = tab_at(index, window_id).map_err(explain)?;
    let spec = property_of(&tab, URL_KEY).map_err(explain)?;
    get_text(pid, &spec).map_err(explain)
}

fn set_tab_url(pid: i32, index: i32, window_id: Option<&str>) -> Result<(), String> {
    let tab = tab_at(index, window_id).map_err(explain)?;
    let spec = property_of(&tab, URL_KEY).map_err(explain)?;
    send(pid, CORE, SET, |event| {
        let err = unsafe { AEPutParamDesc(event, DIRECT, &spec) };
        if err != 0 { return Err(err); }
        let err = unsafe { AEPutParamPtr(event, DATA, UTF8, INSPECT.as_ptr() as *const c_void, INSPECT.len() as isize) };
        if err != 0 { Err(err) } else { Ok(()) }
    }).map_err(explain)?;
    Ok(())
}

/// Opens the inspect page as a new tab of window id of this pid. Chrome may come forward; Bao puts the previous app back.
pub fn open_inspect(pid: i32) -> Result<Value, String> {
    let status = permission_status(pid, false).map_err(explain)?;
    if status != 0 { return Err(explain(status)); }
    let previous = active_index(pid)?;
    let window_id = window_uid(pid)?;
    let front_before = crate::apps::frontmost_pid().unwrap_or(0);
    let flash_start = std::time::Instant::now();
    make_tab(pid, &window_id).map_err(explain)?;
    let created = active_index(pid)?;
    let mut url = String::new();
    for _ in 0..8 {
        url = tab_url(pid, created, Some(&window_id)).unwrap_or_default();
        if url == INSPECT { break; }
        let _ = set_tab_url(pid, created, Some(&window_id));
        url = tab_url(pid, created, Some(&window_id)).unwrap_or_default();
        if url == INSPECT { break; }
    }
    if url != INSPECT {
        return Err(format!("the new tab URL is {url:?}, not {INSPECT}"));
    }
    let id = tab_id(pid, created, Some(&window_id))?;
    let frame = window_frame(pid, &window_id).ok();
    let ready = std::time::Instant::now();
    let mut found = false;
    while ready.elapsed() < std::time::Duration::from_secs(10) {
        if let Ok(value) = crate::act::checkbox_read(pid, "Allow remote debugging for this browser instance", frame) {
            if value.get("found").and_then(|v| v.as_bool()) == Some(true) {
                found = true;
                break;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let restored_front = put_front_back(front_before, pid).ok().flatten();
    let flash_ms = if restored_front.is_some() { flash_start.elapsed().as_millis() as u64 } else { 0 };
    if !found {
        return Err("inspect checkbox was not found before focus was handed back".into());
    }
    Ok(json!({"ok": true, "pid": pid, "windowId": window_id, "tabIndex": created, "tabId": id, "url": url, "restored": previous, "restoredFront": restored_front, "flashMs": flash_ms, "frame": frame, "raised": restored_front.is_some()}))
}

fn tab_at(index: i32, window_id: Option<&str>) -> Result<AEDesc, i32> {
    let window = match window_id {
        Some(id) if !id.is_empty() => window_by_id(id)?,
        _ => window_one()?,
    };
    let which = desc_i32(index)?;
    let mut spec = AEDesc::null();
    let err = unsafe { CreateObjSpecifier(TAB, &window, INDX, &which, 0, &mut spec) };
    if err != 0 { return Err(err); }
    Ok(spec)
}

fn get_text(pid: i32, spec: &AEDesc) -> Result<String, i32> {
    let reply = send(pid, CORE, GET, |event| {
        let err = unsafe { AEPutParamDesc(event, DIRECT, spec) };
        if err != 0 { Err(err) } else { Ok(()) }
    })?;
    let mut buf = [0u8; 512];
    let mut actual = 0u32;
    let mut size = 0isize;
    let err = unsafe { AEGetParamPtr(&reply, DIRECT, UTF8, &mut actual, buf.as_mut_ptr() as *mut c_void, buf.len() as isize, &mut size) };
    if err != 0 { return Err(err); }
    let n = size.max(0) as usize;
    let n = n.min(buf.len());
    Ok(String::from_utf8_lossy(&buf[..n]).into_owned())
}

pub fn tab_id(pid: i32, index: i32, window_id: Option<&str>) -> Result<String, String> {
    let tab = tab_at(index, window_id).map_err(explain)?;
    let spec = property_of(&tab, TAB_ID).map_err(explain)?;
    get_text(pid, &spec).map_err(explain)
}

pub fn close_tab_id(pid: i32, id: &str, restore: Option<i32>, window_id: Option<&str>) -> Result<Value, String> {
    let front_before = crate::apps::frontmost_pid().unwrap_or(0);
    let gate = permission(pid, false)?;
    if gate["wouldPrompt"] == true || gate["denied"] == true {
        return Err(explain(if gate["denied"] == true { NOT_PERMITTED } else { WOULD_PROMPT }));
    }
    if let Some(index) = restore {
        let _ = set_active_index(pid, index, window_id);
    }
    let window = match window_id {
        Some(id) if !id.is_empty() => window_by_id(id).map_err(explain)?,
        _ => window_one().map_err(explain)?,
    };
    let key = desc_bytes(UTF8, id.as_bytes()).map_err(explain)?;
    let mut spec = AEDesc::null();
    let err = unsafe { CreateObjSpecifier(TAB, &window, FORM_ID, &key, 0, &mut spec) };
    if err != 0 { return Err(explain(err)); }
    send(pid, CORE, CLOSE, |event| {
        let err = unsafe { AEPutParamDesc(event, DIRECT, &spec) };
        if err != 0 { Err(err) } else { Ok(()) }
    }).map_err(explain)?;
    let restored_front = put_front_back(front_before, pid)?;
    Ok(json!({"ok": true, "pid": pid, "tabId": id, "restoredFront": restored_front}))
}

extern "C" {
    fn AECreateList(factor: *const c_void, size: isize, is_record: u8, result: *mut AEDesc) -> i32;
    fn AECoerceDesc(from: *const AEDesc, to: u32, result: *mut AEDesc) -> i32;
}

#[cfg(test)]
mod tests {
    #[test]
    fn restore_call_targets_the_app_chrome_covered() {
        assert_eq!(super::front_to_restore(75976, 80385, 80385), Some(75976));
        assert_eq!(super::front_to_restore(75976, 80385, 75976), None);
        assert_eq!(super::front_to_restore(80385, 80385, 80385), None);
        assert_eq!(super::front_to_restore(0, 80385, 80385), None);
    }

    #[test]
    fn denied_automation_names_the_settings_path() {
        let text = super::explain(-1743);
        assert!(text.contains("System Settings > Privacy & Security > Automation > BaoOSHelper > Google Chrome"));
        assert_eq!(super::explain(-1744), "Automation permission for Google Chrome has not yet been asked.");
        assert_eq!(super::explain(-600), "Apple Event failed (-600)");
        assert_eq!(super::explain(-1708), "Apple Event failed (-1708)");
    }
}
