//! Keyboard events posted to one app's accessibility element.
//! The combo is a name, not a screen coordinate.

use std::thread;
use std::time::Duration;

use accessibility_sys::{AXUIElementPerformAction, AXUIElementPostKeyboardEvent};
use core_foundation::base::TCFType;
use core_foundation::string::CFString;

use crate::element::{ax_ok, copy_attr, element_list, set_bool, El};
use crate::walk::app_element;

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
        "p" => 0x23, "return" | "enter" => 0x24, "l" => 0x25, "j" => 0x26,
        "k" => 0x28, "n" => 0x2D, "m" => 0x2E, "tab" => 0x30, "space" => 0x31,
        "delete" | "backspace" => 0x33, "escape" | "esc" => 0x35,
        "plus" | "equals" => 0x18, "minus" => 0x1B, "period" | "point" => 0x2F,
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
    use super::parse_combo;

    #[test]
    fn parses_plain_and_modified_keys() {
        assert_eq!(parse_combo("7").unwrap().0, 0x1A);
        assert_eq!(parse_combo("Return").unwrap().0, 0x24);
        let (key, mods) = parse_combo("cmd+shift+a").unwrap();
        assert_eq!(key, 0x00);
        assert_eq!(mods, vec![0x37, 0x38]);
        assert!(parse_combo("cmd").is_err());
        assert!(parse_combo("").is_err());
    }
}
