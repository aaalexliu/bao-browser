use std::ffi::c_void;

use accessibility_sys::{kAXTrustedCheckOptionPrompt, AXIsProcessTrustedWithOptions};
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use serde_json::{json, Value};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[link(name = "proc", kind = "dylib")]
extern "C" {
    fn proc_pidpath(pid: i32, buffer: *mut c_void, buffersize: u32) -> i32;
}

pub fn ax_trusted(prompt: bool) -> bool {
    let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
    let value = CFBoolean::from(prompt);
    let dict = CFDictionary::from_CFType_pairs(&[(key, value)]);
    unsafe { AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef()) }
}

pub fn screen_trusted() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

/// Shows the system prompt at most once per call. A denial is not retried.
pub fn screen_prompt_once() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}

fn pid_path(pid: i32) -> String {
    let mut buf = vec![0u8; 4096];
    let n = unsafe { proc_pidpath(pid, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
    if n <= 0 {
        return String::new();
    }
    String::from_utf8_lossy(&buf[..n as usize]).trim_end_matches('\0').to_string()
}

pub fn report(prompt: bool) -> Value {
    let accessibility = if prompt { ax_trusted(true) } else { ax_trusted(false) };
    let screen_before = screen_trusted();
    let screen_capture = if prompt && !screen_before {
        let _ = screen_prompt_once();
        screen_trusted()
    } else {
        screen_before
    };
    let pid = std::process::id() as i32;
    let ppid = unsafe { libc::getppid() };
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
    let parent = pid_path(ppid);
    json!({
        "ok": true,
        "prompted": prompt,
        "accessibility": accessibility,
        "screenCapture": screen_capture,
        "exe": exe,
        "pid": pid,
        "ppid": ppid,
        "parentExe": parent,
    })
}
