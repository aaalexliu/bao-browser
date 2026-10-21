//! Points inside one app's window. SwiftUI Calculator leaves the keypad out of
//! AXChildren, but AXUIElementCopyElementAtPosition still returns each button.
//! Samples stay inside the allowed pid. A foreign hit is dropped before its
//! title is read.

use accessibility_sys::{kAXErrorSuccess, AXUIElementCopyElementAtPosition, AXUIElementCreateSystemWide, AXUIElementRef};

use crate::element::{parent, pid_of, El};
use crate::model::Geom;

pub fn sample_step(w: f64, h: f64) -> f64 {
    let mut step = 16.0;
    while w > 1.0 && h > 1.0 && (w / step) * (h / step) > 520.0 && step < 80.0 {
        step += 8.0;
    }
    step
}

fn element_at(sys: &El, x: f64, y: f64) -> Option<El> {
    let mut raw: AXUIElementRef = std::ptr::null_mut();
    let err = unsafe { AXUIElementCopyElementAtPosition(sys.0, x as f32, y as f32, &mut raw) };
    if err != kAXErrorSuccess || raw.is_null() {
        return None;
    }
    El::adopt(raw)
}

/// Grid of elements whose pid is `pid`. Coordinates are top-left screen points,
/// which is what AXUIElementCopyElementAtPosition accepts on this machine.
pub fn hits_in_window(pid: i32, geom: &Geom) -> Vec<El> {
    let Some(frame) = geom.ax_window.as_ref() else {
        return Vec::new();
    };
    let Some(sys) = El::adopt(unsafe { AXUIElementCreateSystemWide() }) else {
        return Vec::new();
    };
    sys.timeout_secs(0.35);
    let step = sample_step(frame.w, frame.h);
    let mut out = Vec::new();
    let mut y = step * 0.5;
    while y < frame.h {
        let mut x = step * 0.5;
        while x < frame.w {
            let (sx, sy) = geom.to_top_left(frame.x + x, frame.y + y, 0.0);
            if let Some(el) = element_at(&sys, sx, sy) {
                if pid_of(&el) == pid {
                    out.push(el);
                }
            }
            x += step;
        }
        y += step;
    }
    out
}

/// Leaf first becomes root first. Stops at a different pid so a foreign title
/// is never copied.
pub fn ancestor_chain(el: El, pid: i32) -> Vec<El> {
    let mut chain = Vec::new();
    let mut current = Some(el);
    for _ in 0..16 {
        let Some(node) = current else { break };
        if pid_of(&node) != pid {
            break;
        }
        let next = parent(&node);
        chain.push(node);
        current = next;
    }
    chain.reverse();
    chain
}

#[cfg(test)]
mod tests {
    use super::sample_step;

    #[test]
    fn calculator_window_stays_on_a_fine_grid() {
        assert_eq!(sample_step(230.0, 408.0), 16.0);
    }

    #[test]
    fn large_window_steps_up() {
        assert!(sample_step(2000.0, 1200.0) > 16.0);
        let step = sample_step(2000.0, 1200.0);
        assert!((2000.0 / step) * (1200.0 / step) < 700.0);
    }
}
