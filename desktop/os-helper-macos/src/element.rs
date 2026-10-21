use std::ffi::c_void;

use accessibility_sys::{
    kAXErrorSuccess, kAXPositionAttribute, kAXPressAction, kAXRoleAttribute,
    kAXSizeAttribute, kAXValueTypeCGPoint, kAXValueTypeCGSize,     AXError, AXUIElementCopyActionNames, AXUIElementCopyAttributeNames,
    AXUIElementCopyAttributeValue, AXUIElementGetPid, AXUIElementGetTypeID, AXUIElementSetAttributeValue,
    AXUIElementSetMessagingTimeout, AXValueCreate, AXValueGetType, AXValueGetTypeID, AXValueGetValue,
    AXValueRef, AXUIElementRef,
};
use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFEqual, CFGetTypeID, CFRelease, CFRetain, CFType, CFTypeID, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::number::{CFNumber, CFNumberRef};
use core_foundation::string::{CFString, CFStringRef};

use crate::model::Frame;

pub const IDENTIFIER: &str = "AXIdentifier";

pub struct El(pub AXUIElementRef);

impl Drop for El {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0 as CFTypeRef) }
        }
    }
}

impl El {
    pub fn adopt(ptr: AXUIElementRef) -> Option<Self> {
        if ptr.is_null() { None } else { Some(El(ptr)) }
    }

    pub fn retain(ptr: AXUIElementRef) -> Option<Self> {
        if ptr.is_null() {
            None
        } else {
            unsafe { CFRetain(ptr as CFTypeRef) };
            Some(El(ptr))
        }
    }

    pub fn timeout(&self) {
        self.timeout_secs(4.0);
    }

    pub fn timeout_secs(&self, secs: f32) {
        unsafe { AXUIElementSetMessagingTimeout(self.0, secs) };
    }
}

pub fn ax_ok(err: AXError, what: &str) -> Result<(), String> {
    if err == kAXErrorSuccess {
        Ok(())
    } else if err == accessibility_sys::kAXErrorAPIDisabled {
        Err("accessibility is not trusted for this binary (kAXErrorAPIDisabled)".into())
    } else {
        Err(format!("{what} failed ({err})"))
    }
}

pub fn copy_attr(el: &El, name: &str) -> Option<CFType> {
    let attr = CFString::new(name);
    let mut value: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(el.0, attr.as_concrete_TypeRef(), &mut value) };
    if err != kAXErrorSuccess || value.is_null() {
        return None;
    }
    Some(unsafe { CFType::wrap_under_create_rule(value) })
}

fn type_is(value: &CFType, tid: CFTypeID) -> bool {
    unsafe { CFGetTypeID(value.as_CFTypeRef()) == tid }
}

fn cf_string(value: &CFType) -> Option<String> {
    if !type_is(value, CFString::type_id()) {
        return None;
    }
    let s = unsafe { CFString::wrap_under_get_rule(value.as_CFTypeRef() as CFStringRef) };
    Some(s.to_string())
}

fn format_number(n: f64) -> String {
    if n.fract().abs() < 0.000_1 {
        format!("{}", n.round() as i64)
    } else {
        format!("{n}")
    }
}

fn cf_number_string(value: &CFType) -> Option<String> {
    if !type_is(value, CFNumber::type_id()) {
        return None;
    }
    let n = unsafe { CFNumber::wrap_under_get_rule(value.as_CFTypeRef() as CFNumberRef) };
    if let (Some(i), Some(f)) = (n.to_i64(), n.to_f64()) {
        if (f - i as f64).abs() > 0.000_1 {
            return Some(format_number(f));
        }
        return Some(i.to_string());
    }
    n.to_i64().map(|i| i.to_string()).or_else(|| n.to_f64().map(format_number))
}

fn attributed(value: &CFType) -> Option<String> {
    let tid = unsafe { CFAttributedStringGetTypeID() };
    if !type_is(value, tid) {
        return None;
    }
    let sref = unsafe { CFAttributedStringGetString(value.as_CFTypeRef()) };
    if sref.is_null() {
        return None;
    }
    let s = unsafe { CFString::wrap_under_get_rule(sref) };
    Some(s.to_string())
}

pub fn stringify(value: &CFType) -> String {
    if let Some(s) = cf_string(value) {
        return s;
    }
    if let Some(s) = cf_number_string(value) {
        return s;
    }
    if type_is(value, CFBoolean::type_id()) {
        let b = unsafe { CFBoolean::wrap_under_get_rule(value.as_CFTypeRef() as _) };
        return if bool::from(b) { "true" } else { "false" }.to_string();
    }
    attributed(value).unwrap_or_default()
}

pub fn string_attr(el: &El, name: &str) -> String {
    copy_attr(el, name).map(|v| stringify(&v)).unwrap_or_default()
}

fn ax_value_point(value: &CFType) -> Option<(f64, f64)> {
    let tid = unsafe { AXValueGetTypeID() };
    if !type_is(value, tid) {
        return None;
    }
    let v = value.as_CFTypeRef() as AXValueRef;
    if unsafe { AXValueGetType(v) } != kAXValueTypeCGPoint {
        return None;
    }
    let mut pt = core_graphics::geometry::CGPoint::default();
    let ok = unsafe { AXValueGetValue(v, kAXValueTypeCGPoint, &mut pt as *mut _ as *mut c_void) };
    if ok { Some((pt.x, pt.y)) } else { None }
}

fn ax_value_size(value: &CFType) -> Option<(f64, f64)> {
    let tid = unsafe { AXValueGetTypeID() };
    if !type_is(value, tid) {
        return None;
    }
    let v = value.as_CFTypeRef() as AXValueRef;
    if unsafe { AXValueGetType(v) } != kAXValueTypeCGSize {
        return None;
    }
    let mut sz = core_graphics::geometry::CGSize::default();
    let ok = unsafe { AXValueGetValue(v, kAXValueTypeCGSize, &mut sz as *mut _ as *mut c_void) };
    if ok { Some((sz.width, sz.height)) } else { None }
}

pub fn raw_frame(el: &El) -> Option<Frame> {
    let (x, y) = copy_attr(el, kAXPositionAttribute).and_then(|v| ax_value_point(&v))?;
    let (w, h) = copy_attr(el, kAXSizeAttribute).and_then(|v| ax_value_size(&v))?;
    if w < 0.5 || h < 0.5 {
        return None;
    }
    Some(Frame { x, y, w, h })
}

pub fn element_list(value: &CFType) -> Vec<El> {
    if !type_is(value, CFArray::<*const c_void>::type_id()) {
        return Vec::new();
    }
    let arr: CFArray<*const c_void> = unsafe { CFArray::wrap_under_get_rule(value.as_CFTypeRef() as CFArrayRef) };
    let element_tid = unsafe { AXUIElementGetTypeID() };
    let mut out = Vec::new();
    for ptr in arr.get_all_values() {
        if ptr.is_null() {
            continue;
        }
        if unsafe { CFGetTypeID(ptr as CFTypeRef) } != element_tid {
            continue;
        }
        if let Some(el) = El::retain(ptr as AXUIElementRef) {
            out.push(el);
        }
    }
    out
}

pub fn same_element(a: &El, b: &El) -> bool {
    unsafe { CFEqual(a.0 as CFTypeRef, b.0 as CFTypeRef) != 0 }
}

pub fn element_attr(el: &El, name: &str) -> Option<El> {
    let value = copy_attr(el, name)?;
    let element_tid = unsafe { AXUIElementGetTypeID() };
    if !type_is(&value, element_tid) {
        return None;
    }
    El::retain(value.as_CFTypeRef() as AXUIElementRef)
}

pub fn parent(el: &El) -> Option<El> {
    let value = copy_attr(el, "AXParent")?;
    let element_tid = unsafe { AXUIElementGetTypeID() };
    if !type_is(&value, element_tid) {
        return None;
    }
    El::retain(value.as_CFTypeRef() as AXUIElementRef)
}

pub fn actions(el: &El) -> Vec<String> {
    let mut names: CFArrayRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyActionNames(el.0, &mut names) };
    if err != kAXErrorSuccess || names.is_null() {
        return Vec::new();
    }
    let arr: CFArray<*const c_void> = unsafe { CFArray::wrap_under_create_rule(names) };
    let mut out = Vec::new();
    for ptr in arr.get_all_values() {
        if ptr.is_null() || unsafe { CFGetTypeID(ptr as CFTypeRef) } != CFString::type_id() {
            continue;
        }
        let s = unsafe { CFString::wrap_under_get_rule(ptr as CFStringRef) };
        out.push(s.to_string());
    }
    out
}

pub fn pid_of(el: &El) -> i32 {
    let mut pid: i32 = 0;
    if unsafe { AXUIElementGetPid(el.0, &mut pid) } == kAXErrorSuccess {
        pid
    } else {
        0
    }
}

pub fn role_of(el: &El) -> String {
    string_attr(el, kAXRoleAttribute)
}

pub fn set_bool(el: &El, name: &str, on: bool) -> Result<(), String> {
    let attr = CFString::new(name);
    let value = CFBoolean::from(on);
    let err = unsafe {
        AXUIElementSetAttributeValue(el.0, attr.as_concrete_TypeRef(), value.as_CFTypeRef())
    };
    ax_ok(err, name)
}

pub fn set_string(el: &El, name: &str, text: &str) -> Result<(), String> {
    let attr = CFString::new(name);
    let value = CFString::new(text);
    let err = unsafe {
        AXUIElementSetAttributeValue(el.0, attr.as_concrete_TypeRef(), value.as_CFTypeRef())
    };
    ax_ok(err, name)
}

pub fn set_ax_point(el: &El, name: &str, x: f64, y: f64) -> Result<(), String> {
    let pt = core_graphics::geometry::CGPoint::new(x, y);
    let value = unsafe { AXValueCreate(kAXValueTypeCGPoint, &pt as *const _ as *const c_void) };
    if value.is_null() {
        return Err("AXValueCreate point failed".into());
    }
    let attr = CFString::new(name);
    let err = unsafe {
        AXUIElementSetAttributeValue(el.0, attr.as_concrete_TypeRef(), value as CFTypeRef)
    };
    unsafe { CFRelease(value as CFTypeRef) };
    ax_ok(err, name)
}

pub fn set_ax_size(el: &El, w: f64, h: f64) -> Result<(), String> {
    let sz = core_graphics::geometry::CGSize::new(w, h);
    let value = unsafe { AXValueCreate(kAXValueTypeCGSize, &sz as *const _ as *const c_void) };
    if value.is_null() {
        return Err("AXValueCreate size failed".into());
    }
    let attr = CFString::new("AXSize");
    let err = unsafe {
        AXUIElementSetAttributeValue(el.0, attr.as_concrete_TypeRef(), value as CFTypeRef)
    };
    unsafe { CFRelease(value as CFTypeRef) };
    ax_ok(err, "AXSize")
}

pub fn has_press(actions: &[String]) -> bool {
    actions.iter().any(|a| a == kAXPressAction || a == "AXConfirm")
}

pub fn attribute_names(el: &El) -> Vec<String> {
    let mut names: CFArrayRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeNames(el.0, &mut names) };
    if err != kAXErrorSuccess || names.is_null() {
        return Vec::new();
    }
    let arr: CFArray<*const c_void> = unsafe { CFArray::wrap_under_create_rule(names) };
    let mut out = Vec::new();
    for ptr in arr.get_all_values() {
        if ptr.is_null() || unsafe { CFGetTypeID(ptr as CFTypeRef) } != CFString::type_id() {
            continue;
        }
        let s = unsafe { CFString::wrap_under_get_rule(ptr as CFStringRef) };
        out.push(s.to_string());
    }
    out
}

/// A short numeric accessibility string, including a trailing dot (`12.`).
pub fn is_number_token(raw: &str) -> bool {
    let s = raw.trim();
    if s.is_empty() || s.len() > 24 {
        return false;
    }
    let bytes = s.as_bytes();
    let mut i = 0;
    if bytes[0] == b'-' || bytes[0] == b'+' {
        i = 1;
    }
    if i >= bytes.len() {
        return false;
    }
    let mut saw_digit = false;
    let mut saw_dot = false;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_digit() {
            saw_digit = true;
        } else if c == b'.' && !saw_dot {
            saw_dot = true;
        } else {
            return false;
        }
        i += 1;
    }
    saw_digit
}

fn strip_marks(raw: &str) -> String {
    raw.chars().filter(|c| !matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')).collect()
}

/// Numeric display text from value-like attributes only. Character counts are not the display.
pub fn numeric_attribute(el: &El) -> String {
    for name in ["AXValue", "AXTitle", "AXDescription", "AXHelp", "AXLabel", "AXValueDescription"] {
        let value = strip_marks(string_attr(el, name).trim());
        let value = value.trim();
        if is_number_token(value) {
            return value.to_string();
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::is_number_token;

    #[test]
    fn number_tokens() {
        assert!(is_number_token("12"));
        assert!(is_number_token("12."));
        assert!(is_number_token("0"));
        assert!(is_number_token("-3.5"));
        assert!(!is_number_token("Calculator"));
        assert!(!is_number_token("12.3.4"));
        assert!(!is_number_token("."));
    }
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFAttributedStringGetTypeID() -> CFTypeID;
    fn CFAttributedStringGetString(s: CFTypeRef) -> CFStringRef;
}
