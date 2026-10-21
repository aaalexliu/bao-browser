//! Synthetic left-button drag via CGEvent.
//! The caller passes top-left screen points, the same space as an AX frame.
//! Quartz mouse events on some displays use a bottom-left origin. This posts a
//! move, reads the cursor back, and records whether the pointer actually moved.
//! A drag that moves the pointer still may not start a file-drag session.

use std::thread;
use std::time::Duration;

use core_graphics::event::{CGEvent, CGEventTapLocation, CGEventType, CGMouseButton, EventField};
use foreign_types::ForeignType;
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;
use serde_json::{json, Value};

use crate::walk::screen_size;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceSetLocalEventsSuppressionInterval(source: *mut std::ffi::c_void, seconds: f64);
}

fn source() -> Result<CGEventSource, String> {
    let src = CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| "CGEventSourceCreate failed".to_string())?;
    unsafe { CGEventSourceSetLocalEventsSuppressionInterval(src.as_ptr() as *mut _, 0.0) };
    Ok(src)
}

fn cursor(src: &CGEventSource) -> Result<(f64, f64), String> {
    let event = CGEvent::new(src.clone()).map_err(|_| "CGEventCreate failed".to_string())?;
    let point = event.location();
    Ok((point.x, point.y))
}

fn post_mouse(src: &CGEventSource, kind: CGEventType, x: f64, y: f64, down: bool) -> Result<(), String> {
    let event = CGEvent::new_mouse_event(src.clone(), kind, CGPoint::new(x, y), CGMouseButton::Left)
        .map_err(|_| "CGEventCreateMouseEvent failed".to_string())?;
    event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, if down { 1 } else { 0 });
    event.set_double_value_field(EventField::MOUSE_EVENT_PRESSURE, if down { 1.0 } else { 0.0 });
    event.post(CGEventTapLocation::HID);
    Ok(())
}

fn dist(a: (f64, f64), b: (f64, f64)) -> f64 {
    let dx = a.0 - b.0;
    let dy = a.1 - b.1;
    (dx * dx + dy * dy).sqrt()
}

fn point(p: (f64, f64)) -> Value {
    json!({"x": p.0.round() as i64, "y": p.1.round() as i64})
}

/// `screen_h - top_y` when the event origin is the bottom of the main display.
pub fn bottom_left_y(screen_h: f64, top_y: f64) -> f64 {
    screen_h - top_y
}

pub fn drag(from_x: f64, from_y: f64, to_x: f64, to_y: f64) -> Result<Value, String> {
    let (screen_w, screen_h) = screen_size();
    let src = source()?;
    let before = cursor(&src)?;
    post_mouse(&src, CGEventType::MouseMoved, from_x, from_y, false)?;
    thread::sleep(Duration::from_millis(80));
    let after_top = cursor(&src)?;
    let top_ok = dist(after_top, (from_x, from_y)) < 24.0;
    let mut space = "top-left";
    let mut posted_from = (from_x, from_y);
    let mut posted_to = (to_x, to_y);
    if !top_ok {
        let flipped_from = (from_x, bottom_left_y(screen_h, from_y));
        let flipped_to = (to_x, bottom_left_y(screen_h, to_y));
        post_mouse(&src, CGEventType::MouseMoved, flipped_from.0, flipped_from.1, false)?;
        thread::sleep(Duration::from_millis(80));
        let after_flip = cursor(&src)?;
        let flip_ok = dist(after_flip, flipped_from) < 24.0;
        if !flip_ok {
            let _ = post_mouse(&src, CGEventType::MouseMoved, before.0, before.1, false);
            return Ok(json!({
                "ok": true,
                "delivered": false,
                "blocked": true,
                "reason": "cursor did not move to the posted point",
                "coordinateSpace": "unresolved",
                "screen": {"w": screen_w.round() as i64, "h": screen_h.round() as i64},
                "cursorBefore": point(before),
                "cursorAfterTopLeftPost": point(after_top),
                "cursorAfterBottomLeftPost": point(after_flip),
                "button": "up",
            }));
        }
        space = "bottom-left";
        posted_from = flipped_from;
        posted_to = flipped_to;
    }
    post_mouse(&src, CGEventType::LeftMouseDown, posted_from.0, posted_from.1, true)?;
    thread::sleep(Duration::from_millis(40));
    for step in 1..=8 {
        let t = step as f64 / 8.0;
        let x = posted_from.0 + (posted_to.0 - posted_from.0) * t;
        let y = posted_from.1 + (posted_to.1 - posted_from.1) * t;
        post_mouse(&src, CGEventType::LeftMouseDragged, x, y, true)?;
        thread::sleep(Duration::from_millis(20));
    }
    post_mouse(&src, CGEventType::LeftMouseUp, posted_to.0, posted_to.1, false)?;
    thread::sleep(Duration::from_millis(80));
    let after = cursor(&src)?;
    let landed = dist(after, posted_to) < 24.0;
    let _ = post_mouse(&src, CGEventType::MouseMoved, before.0, before.1, false);
    Ok(json!({
        "ok": true,
        "delivered": true,
        "blocked": false,
        "landed": landed,
        "coordinateSpace": space,
        "screen": {"w": screen_w.round() as i64, "h": screen_h.round() as i64},
        "cursorBefore": point(before),
        "cursorAfter": point(after),
        "from": {"x": from_x.round() as i64, "y": from_y.round() as i64},
        "to": {"x": to_x.round() as i64, "y": to_y.round() as i64},
        "note": "A moved cursor is not a Finder file drag. The destination value has to change before the drag counts as opening the file.",
    }))
}

#[cfg(test)]
mod tests {
    use super::bottom_left_y;

    #[test]
    fn flips_a_top_origin_against_the_display_height() {
        assert_eq!(bottom_left_y(1117.0, 0.0), 1117.0);
        assert_eq!(bottom_left_y(1117.0, 100.0), 1017.0);
    }
}
