use std::path::Path;
use std::process::Command;

use core_foundation::base::{CFGetTypeID, CFTypeRef, TCFType};
use core_foundation::dictionary::{CFDictionary, CFDictionaryGetValue, CFDictionaryRef};
use core_foundation::number::{CFNumber, CFNumberRef};
use core_foundation::string::CFString;
use core_graphics::geometry::CGRect;
use core_graphics::window::{
    copy_window_info, kCGNullWindowID, kCGWindowBounds, kCGWindowLayer,
    kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly, kCGWindowNumber,
    kCGWindowOwnerPID,
};

use crate::model::Frame;

#[derive(Clone)]
pub struct CgWin {
    pub id: u32,
    pub layer: i64,
    pub frame: Frame,
}

fn dict_i64(dict: &CFDictionary, key: core_foundation::string::CFStringRef) -> Option<i64> {
    if key.is_null() {
        return None;
    }
    let key = unsafe { CFString::wrap_under_get_rule(key) };
    let value = unsafe {
        CFDictionaryGetValue(dict.as_concrete_TypeRef(), key.as_concrete_TypeRef() as *const std::ffi::c_void)
    };
    if value.is_null() || unsafe { CFGetTypeID(value as CFTypeRef) } != CFNumber::type_id() {
        return None;
    }
    unsafe { CFNumber::wrap_under_get_rule(value as CFNumberRef) }.to_i64()
}

pub fn windows_for_pid(pid: i32) -> Vec<CgWin> {
    let Some(arr) = copy_window_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID,
    ) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for ptr in arr.get_all_values() {
        if ptr.is_null() {
            continue;
        }
        let dict = unsafe { CFDictionary::wrap_under_get_rule(ptr as CFDictionaryRef) };
        if dict_i64(&dict, unsafe { kCGWindowOwnerPID }).unwrap_or(0) as i32 != pid {
            continue;
        }
        let id = dict_i64(&dict, unsafe { kCGWindowNumber }).unwrap_or(0) as u32;
        let layer = dict_i64(&dict, unsafe { kCGWindowLayer }).unwrap_or(0);
        let bounds_ptr = unsafe {
            let key = CFString::wrap_under_get_rule(kCGWindowBounds);
            CFDictionaryGetValue(dict.as_concrete_TypeRef(), key.as_concrete_TypeRef() as *const std::ffi::c_void)
        };
        if bounds_ptr.is_null() || id == 0 {
            continue;
        }
        let bounds = unsafe { CFDictionary::wrap_under_get_rule(bounds_ptr as CFDictionaryRef) };
        let Some(rect) = CGRect::from_dict_representation(&bounds) else { continue };
        if rect.size.width < 2.0 || rect.size.height < 2.0 {
            continue;
        }
        out.push(CgWin {
            id,
            layer,
            frame: Frame { x: rect.origin.x, y: rect.origin.y, w: rect.size.width, h: rect.size.height },
        });
    }
    out
}

pub fn main_window(pid: i32) -> Result<CgWin, String> {
    windows_for_pid(pid)
        .into_iter()
        .filter(|w| w.layer == 0)
        .max_by(|a, b| (a.frame.w * a.frame.h).partial_cmp(&(b.frame.w * b.frame.h)).unwrap_or(std::cmp::Ordering::Equal))
        .ok_or_else(|| format!("no on-screen window for pid {pid}"))
}

/// One window id. This is not a full-screen grab.
pub fn capture_window(window_id: u32, out: &Path) -> Result<(u32, u32), String> {
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let path = out.to_str().ok_or("screenshot path is not utf-8")?;
    let status = Command::new("/usr/sbin/screencapture")
        .args(["-l", &window_id.to_string(), "-o", "-x", path])
        .status()
        .map_err(|e| format!("screencapture failed to start: {e}"))?;
    if !status.success() {
        return Err(format!("screencapture -l {window_id} exited {status}"));
    }
    let (w, h) = png_size(out).unwrap_or((0, 0));
    if w < 10 || h < 10 {
        return Err("window capture was empty. Screen Recording is not granted for the process that ran screencapture".into());
    }
    Ok((w, h))
}

fn png_size(path: &Path) -> Option<(u32, u32)> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() < 24 || &bytes[0..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    Some((
        u32::from_be_bytes(bytes[16..20].try_into().ok()?),
        u32::from_be_bytes(bytes[20..24].try_into().ok()?),
    ))
}
