use objc2::msg_send;
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::{AnyClass, AnyObject};
use objc2_foundation::{NSArray, NSString};

pub fn bundle_id_for_pid(pid: i32) -> String {
    unsafe {
        let Some(cls) = AnyClass::get(c"NSRunningApplication") else {
            return String::new();
        };
        let app: Option<Retained<AnyObject>> =
            msg_send![cls, runningApplicationWithProcessIdentifier: pid];
        let Some(app) = app else {
            return String::new();
        };
        let bid: Option<Retained<NSString>> = msg_send![&*app, bundleIdentifier];
        let Some(bid) = bid else {
            return String::new();
        };
        autoreleasepool(|pool| bid.to_str(pool).to_string())
    }
}

/// Bring this pid's app forward. AXPosition on a background Chrome window is ignored.
pub fn activate_pid(pid: i32) -> Result<(), String> {
    unsafe {
        let Some(cls) = AnyClass::get(c"NSRunningApplication") else {
            return Err("NSRunningApplication is missing".into());
        };
        let app: Option<Retained<AnyObject>> =
            msg_send![cls, runningApplicationWithProcessIdentifier: pid];
        let Some(app) = app else {
            return Err(format!("no running application for pid {pid}"));
        };
        let _: () = msg_send![&*app, unhide];
        // NSApplicationActivateIgnoringOtherApps | NSApplicationActivateAllWindows
        let ok: bool = msg_send![&*app, activateWithOptions: 3usize];
        if !ok {
            return Err(format!("activate failed for pid {pid}"));
        }
        Ok(())
    }
}

/// NSWorkspace keeps a stale front app until this process runs its loop.
fn pump_workspace() {
    let _ = core_foundation::runloop::CFRunLoop::run_in_mode(
        unsafe { core_foundation::runloop::kCFRunLoopDefaultMode },
        std::time::Duration::from_millis(50),
        true,
    );
}

pub fn frontmost_pid() -> Result<i32, String> {
    pump_workspace();
    unsafe {
        let Some(cls) = AnyClass::get(c"NSWorkspace") else {
            return Err("NSWorkspace is missing".into());
        };
        let workspace: Option<Retained<AnyObject>> = msg_send![cls, sharedWorkspace];
        let Some(workspace) = workspace else {
            return Err("NSWorkspace is missing".into());
        };
        let app: Option<Retained<AnyObject>> = msg_send![&*workspace, frontmostApplication];
        let Some(app) = app else {
            return Err("no frontmost application".into());
        };
        let pid: i32 = msg_send![&*app, processIdentifier];
        if pid <= 0 {
            return Err("frontmost application has no pid".into());
        }
        Ok(pid)
    }
}

pub fn pids_for_bundle(bundle: &str) -> Vec<i32> {
    unsafe {
        let Some(cls) = AnyClass::get(c"NSRunningApplication") else {
            return Vec::new();
        };
        let ns = NSString::from_str(bundle);
        let apps: Option<Retained<NSArray<AnyObject>>> =
            msg_send![cls, runningApplicationsWithBundleIdentifier: &*ns];
        let Some(apps) = apps else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for i in 0..apps.len() {
            let app = apps.objectAtIndex_unchecked(i);
            let pid: i32 = msg_send![app, processIdentifier];
            if pid > 0 {
                out.push(pid);
            }
        }
        out
    }
}
