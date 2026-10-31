//! Keyboard events posted to one app's accessibility element.
//! The combo is a name, not a screen coordinate.

use std::thread;
use std::time::Duration;

use accessibility_sys::{AXUIElementPerformAction, AXUIElementPostKeyboardEvent};
use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, EventField};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use foreign_types::ForeignType;

use crate::element::{ax_ok, copy_attr, element_list, set_bool, string_attr, El};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceSetLocalEventsSuppressionInterval(source: *mut std::ffi::c_void, seconds: f64);
    fn CGEventPost(tap: u32, event: *mut std::ffi::c_void);
    fn CGEventPostToPid(pid: i32, event: *mut std::ffi::c_void);
}

/// Where a CGEvent is posted. `hid` is the old path. `session` and `pid` are
/// for a Chrome that ignores Return posted at the HID tap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CgTap {
    Hid,
    Session,
    Pid,
}

fn pid_source(combined: bool) -> Result<CGEventSource, String> {
    let state = if combined { CGEventSourceStateID::CombinedSessionState } else { CGEventSourceStateID::HIDSystemState };
    let src = CGEventSource::new(state).map_err(|_| "CGEventSourceCreate failed".to_string())?;
    unsafe { CGEventSourceSetLocalEventsSuppressionInterval(src.as_ptr() as *mut _, 0.0) };
    Ok(src)
}

fn post_code_to_pid(pid: i32, code: u16, shift: bool, combined: bool, keyboard_type: Option<i64>) -> Result<(), String> {
    let src = pid_source(combined)?;
    let flags = if shift { CGEventFlags::CGEventFlagShift } else { CGEventFlags::empty() };
    for down in [true, false] {
        let event = CGEvent::new_keyboard_event(src.clone(), code, down).map_err(|_| "CGEventCreateKeyboardEvent failed".to_string())?;
        event.set_flags(flags);
        if down {
            event.set_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT, 0);
            if let Some(kind) = keyboard_type {
                event.set_integer_value_field(EventField::KEYBOARD_EVENT_KEYBOARD_TYPE, kind);
            }
        }
        unsafe { CGEventPostToPid(pid, event.as_ptr() as *mut _) };
    }
    Ok(())
}

/// One key to a pid. Does not raise the app.
pub fn post_pid_key(pid: i32, combo: &str, combined: bool, keyboard_type: Option<i64>) -> Result<(), String> {
    let (key, _mods) = parse_combo(combo)?;
    post_code_to_pid(pid, key, combo.to_ascii_lowercase().contains("shift+"), combined, keyboard_type)
}

/// One key to the session tap. Does not raise. Caller must already know the target is frontmost.
pub fn post_session_key(combo: &str, combined: bool, keyboard_type: Option<i64>) -> Result<(), String> {
    let (key, _mods) = parse_combo(combo)?;
    let src = pid_source(combined)?;
    let flags = if combo.to_ascii_lowercase().contains("shift+") { CGEventFlags::CGEventFlagShift } else { CGEventFlags::empty() };
    for down in [true, false] {
        let event = CGEvent::new_keyboard_event(src.clone(), key, down).map_err(|_| "CGEventCreateKeyboardEvent failed".to_string())?;
        event.set_flags(flags);
        if down {
            event.set_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT, 0);
            if let Some(kind) = keyboard_type {
                event.set_integer_value_field(EventField::KEYBOARD_EVENT_KEYBOARD_TYPE, kind);
            }
        }
        unsafe { CGEventPost(1, event.as_ptr() as *mut _) };
    }
    Ok(())
}

/// Text to a pid. Does not raise the app.
pub fn post_pid_text(pid: i32, text: &str, combined: bool, keyboard_type: Option<i64>) -> Result<(), String> {
    for ch in text.chars() {
        let (code, shift) = text_key(ch)?;
        post_code_to_pid(pid, code, shift, combined, keyboard_type)?;
        thread::sleep(Duration::from_millis(12));
    }
    Ok(())
}

pub fn parse_tap(raw: Option<&str>) -> Result<CgTap, String> {
    match raw {
        None | Some("hid") => Ok(CgTap::Hid),
        Some("session") => Ok(CgTap::Session),
        Some("pid") => Ok(CgTap::Pid),
        Some(other) => Err(format!("--tap must be hid, session, or pid, not {other}")),
    }
}
use crate::walk::{app_element, app_target};

const CMD: u16 = 0x37;
const SHIFT: u16 = 0x38;
const OPTION: u16 = 0x3A;
const CTRL: u16 = 0x3B;

fn is_modifier(name: &str) -> bool {
    matches!(name, "cmd" | "command" | "meta" | "shift" | "option" | "opt" | "alt" | "ctrl" | "control")
}

fn key_code(name: &str) -> Result<u16, String> {
    let code = match name {
        "a" => 0x00, "s" => 0x01, "d" => 0x02, "f" => 0x03, "h" => 0x04,
        "g" => 0x05, "z" => 0x06, "x" => 0x07, "c" => 0x08, "v" => 0x09,
        "b" => 0x0B, "q" => 0x0C, "w" => 0x0D, "e" => 0x0E, "r" => 0x0F,
        "y" => 0x10, "t" => 0x11, "1" => 0x12, "2" => 0x13, "3" => 0x14,
        "4" => 0x15, "6" => 0x16, "5" => 0x17, "9" => 0x19, "7" => 0x1A,
        "8" => 0x1C, "0" => 0x1D, "o" => 0x1F, "u" => 0x20, "i" => 0x22,
        "p" => 0x23, "return" | "enter" => 0x24, "keypad-enter" => 0x4C, "l" => 0x25, "j" => 0x26,
        "k" => 0x28, "n" => 0x2D, "m" => 0x2E, "tab" => 0x30, "space" => 0x31,
        "delete" | "backspace" => 0x33, "escape" | "esc" => 0x35,
        "plus" | "equals" => 0x18, "minus" | "hyphen" => 0x1B, "period" | "point" => 0x2F,
        "slash" => 0x2C, "semicolon" => 0x29, "comma" => 0x2B,
        "left" => 0x7B, "right" => 0x7C, "down" => 0x7D, "up" => 0x7E,
        "cmd" | "command" | "meta" => CMD,
        "shift" => SHIFT,
        "option" | "opt" | "alt" => OPTION,
        "ctrl" | "control" => CTRL,
        _ => return Err(format!("unsupported key {name}")),
    };
    Ok(code)
}

/// `cmd+a`, `return`, `7`. The last piece is the key. `+` is the word `plus`.
pub fn parse_combo(combo: &str) -> Result<(u16, Vec<u16>), String> {
    let parts: Vec<String> = combo.split('+').map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return Err("empty key combo".into());
    }
    let mut mods = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        let code = key_code(part)?;
        if i + 1 == parts.len() {
            if is_modifier(part) {
                return Err("combo needs a key".into());
            }
            return Ok((code, mods));
        }
        if !is_modifier(part) {
            return Err(format!("{part} is not a modifier"));
        }
        mods.push(code);
    }
    Err("empty key combo".into())
}

fn raise(app: &El) {
    let _ = set_bool(app, "AXFrontmost", true);
    let wins = copy_attr(app, "AXWindows").map(|v| element_list(&v)).unwrap_or_default();
    if let Some(win) = wins.first() {
        let action = CFString::new("AXRaise");
        let _ = unsafe { AXUIElementPerformAction(win.0, action.as_concrete_TypeRef()) };
    }
}

fn post(app: &El, code: u16, down: bool) -> Result<(), String> {
    ax_ok(unsafe { AXUIElementPostKeyboardEvent(app.0, 0, code, down) }, "AXUIElementPostKeyboardEvent")
}

/// US ANSI. `shift` is true when the character needs the shift modifier.
pub fn text_key(ch: char) -> Result<(u16, bool), String> {
    match ch {
        'a'..='z' | '0'..='9' => Ok((key_code(&ch.to_string())?, false)),
        'A'..='Z' => Ok((key_code(&ch.to_ascii_lowercase().to_string())?, true)),
        ' ' => Ok((key_code("space")?, false)),
        '.' => Ok((key_code("period")?, false)),
        '/' => Ok((key_code("slash")?, false)),
        '-' => Ok((key_code("hyphen")?, false)),
        '_' => Ok((key_code("hyphen")?, true)),
        '#' => Ok((key_code("3")?, true)),
        ':' => Ok((key_code("semicolon")?, true)),
        ';' => Ok((key_code("semicolon")?, false)),
        ',' => Ok((key_code("comma")?, false)),
        '\n' => Ok((key_code("return")?, false)),
        _ => Err(format!("unsupported text character {ch}")),
    }
}

pub fn post_text(bundle: &str, text: &str) -> Result<(), String> {
    let (_pid, app) = app_element(bundle)?;
    raise(&app);
    thread::sleep(Duration::from_millis(80));
    for ch in text.chars() {
        let (code, shift) = text_key(ch)?;
        if shift {
            post(&app, SHIFT, true)?;
        }
        post(&app, code, true)?;
        post(&app, code, false)?;
        if shift {
            post(&app, SHIFT, false)?;
        }
        thread::sleep(Duration::from_millis(12));
    }
    Ok(())
}

fn frontmost(app: &El) -> bool {
    matches!(string_attr(app, "AXFrontmost").as_str(), "true" | "1")
}

fn cg_source() -> Result<CGEventSource, String> {
    let src = CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| "CGEventSourceCreate failed".to_string())?;
    unsafe { CGEventSourceSetLocalEventsSuppressionInterval(src.as_ptr() as *mut _, 0.0) };
    Ok(src)
}

fn cg_flags(mods: &[u16]) -> CGEventFlags {
    let mut flags = CGEventFlags::empty();
    for modifier in mods {
        flags |= match *modifier {
            CMD => CGEventFlags::CGEventFlagCommand,
            SHIFT => CGEventFlags::CGEventFlagShift,
            OPTION => CGEventFlags::CGEventFlagAlternate,
            CTRL => CGEventFlags::CGEventFlagControl,
            _ => CGEventFlags::empty(),
        };
    }
    flags
}

fn cg_key(src: &CGEventSource, code: u16, down: bool, flags: CGEventFlags, tap: CgTap, pid: Option<i32>) -> Result<(), String> {
    let event = CGEvent::new_keyboard_event(src.clone(), code, down).map_err(|_| "CGEventCreateKeyboardEvent failed".to_string())?;
    event.set_flags(flags);
    if down {
        event.set_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT, 0);
    }
    match tap {
        CgTap::Hid => event.post(CGEventTapLocation::HID),
        CgTap::Session => unsafe { CGEventPost(1, event.as_ptr() as *mut _) },
        CgTap::Pid => {
            let pid = pid.ok_or("--tap pid requires --pid")?;
            unsafe { CGEventPostToPid(pid, event.as_ptr() as *mut _) };
        }
    }
    Ok(())
}

fn focus_for_cg(bundle: &str, pid: Option<i32>, what: &str) -> Result<El, String> {
    if matches!(crate::perms::screen_locked(), Ok(true)) {
        return Err("The screen is locked. Unlock it, then try again".into());
    }
    let (resolved, app) = app_target(bundle, pid)?;
    if pid.is_none() {
        raise(&app);
        thread::sleep(Duration::from_millis(150));
        if !frontmost(&app) {
            return Err(format!("app did not become frontmost; {what} was not posted"));
        }
        return Ok(app);
    }
    focus_pid(resolved, &app, what)?;
    Ok(app)
}

/// Bring this process forward before a HID key. Another Chrome with the same
/// bundle id must not be the frontmost process when the key is posted.
fn focus_pid(pid: i32, app: &El, what: &str) -> Result<(), String> {
    let mut why = String::new();
    for _ in 0..10 {
        why = match crate::apps::activate_pid(pid) {
            Ok(()) => String::new(),
            Err(err) => err,
        };
        raise(app);
        thread::sleep(Duration::from_millis(150));
        if !frontmost(app) {
            if why.is_empty() {
                why = "AXFrontmost stayed false".into();
            }
            continue;
        }
        match crate::apps::frontmost_pid() {
            Ok(front) if front == pid => return Ok(()),
            Ok(front) => why = format!("frontmost is {front}"),
            Err(err) => why = err,
        }
    }
    Err(format!("pid {pid} did not become frontmost ({why}); {what} was not posted"))
}

/// Posts a combo through CGEvent only after the target app is frontmost.
/// A key is not posted when AXFrontmost stays false.
/// `pid` selects that process when more than one shares the bundle id.
pub fn post_cg_combo(bundle: &str, combo: &str, pid: Option<i32>, tap: CgTap) -> Result<(), String> {
    let (key, mods) = parse_combo(combo)?;
    if matches!(tap, CgTap::Pid) && pid.is_none() {
        return Err("--tap pid requires --pid".into());
    }
    let _app = focus_for_cg(bundle, pid, "key")?;
    let src = cg_source()?;
    let flags = cg_flags(&mods);
    for modifier in &mods {
        cg_key(&src, *modifier, true, flags, tap, pid)?;
    }
    cg_key(&src, key, true, flags, tap, pid)?;
    cg_key(&src, key, false, flags, tap, pid)?;
    for modifier in mods.iter().rev() {
        cg_key(&src, *modifier, false, CGEventFlags::empty(), tap, pid)?;
    }
    Ok(())
}

pub fn post_cg_text(bundle: &str, text: &str, pid: Option<i32>) -> Result<(), String> {
    let _app = focus_for_cg(bundle, pid, "text")?;
    let src = cg_source()?;
    for ch in text.chars() {
        let (code, shift) = text_key(ch)?;
        let flags = if shift { CGEventFlags::CGEventFlagShift } else { CGEventFlags::empty() };
        if shift {
            cg_key(&src, SHIFT, true, flags, CgTap::Hid, pid)?;
        }
        cg_key(&src, code, true, flags, CgTap::Hid, pid)?;
        cg_key(&src, code, false, flags, CgTap::Hid, pid)?;
        if shift {
            cg_key(&src, SHIFT, false, CGEventFlags::empty(), CgTap::Hid, pid)?;
        }
        thread::sleep(Duration::from_millis(12));
    }
    Ok(())
}

pub fn post_combo(bundle: &str, combo: &str) -> Result<(), String> {
    let (key, mods) = parse_combo(combo)?;
    let (_pid, app) = app_element(bundle)?;
    raise(&app);
    thread::sleep(Duration::from_millis(80));
    for modifier in &mods {
        post(&app, *modifier, true)?;
    }
    post(&app, key, true)?;
    post(&app, key, false)?;
    for modifier in mods.iter().rev() {
        post(&app, *modifier, false)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_combo, parse_tap, CgTap};

    #[test]
    fn parses_plain_and_modified_keys() {
        assert_eq!(parse_combo("7").unwrap().0, 0x1A);
        assert_eq!(parse_combo("Return").unwrap().0, 0x24);
        let (key, mods) = parse_combo("cmd+shift+a").unwrap();
        assert_eq!(key, 0x00);
        assert_eq!(mods, vec![0x37, 0x38]);
        assert!(parse_combo("cmd").is_err());
        assert!(parse_combo("").is_err());
        assert_eq!(super::text_key('/').unwrap(), (0x2C, false));
        assert_eq!(super::text_key(':').unwrap(), (0x29, true));
        assert_eq!(super::text_key('#').unwrap(), (0x14, true));
        assert_eq!(super::text_key('-').unwrap(), (0x1B, false));
        assert_eq!(super::parse_combo("cmd+shift+g").unwrap().0, 0x05);
    }

    #[test]
    fn tap_defaults_to_hid_and_rejects_unknown() {
        assert_eq!(parse_tap(None).unwrap(), CgTap::Hid);
        assert_eq!(parse_tap(Some("hid")).unwrap(), CgTap::Hid);
        assert_eq!(parse_tap(Some("session")).unwrap(), CgTap::Session);
        assert_eq!(parse_tap(Some("pid")).unwrap(), CgTap::Pid);
        assert!(parse_tap(Some("annotated")).is_err());
    }
}
