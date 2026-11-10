//! Start the helper as its own TCC responsible process without LaunchServices.
//!
//! A plain child inherits its parent's TCC identity, so Bao used to launch the
//! helper with `open -a`. That path stalls when LaunchServices cannot resume the
//! stopped app it spawned. Instead the helper respawns itself with the
//! disclaim spawn attribute, so TCC checks the helper's own grant, and the
//! caller keeps a real pid, real pipes, and a real exit code.

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;

const MARK: &str = "BAO_HELPER_DISCLAIMED";

extern "C" {
    fn responsibility_spawnattrs_setdisclaim(attrs: *mut libc::posix_spawnattr_t, disclaim: libc::c_int) -> libc::c_int;
}

/// `None` in the disclaimed child, which runs the command. `Some(code)` in the
/// first process, which only waits for that child.
pub fn respawn() -> Option<Result<i32, String>> {
    if std::env::var_os(MARK).is_some() {
        exit_with_parent();
        return None;
    }
    Some(spawn_self())
}

fn cstring(raw: &[u8]) -> Result<CString, String> {
    CString::new(raw).map_err(|_| "argument contains a NUL byte".to_string())
}

fn spawn_self() -> Result<i32, String> {
    let exe = std::env::current_exe().map_err(|e| format!("helper path: {e}"))?;
    let exe = cstring(exe.as_os_str().as_bytes())?;
    let argv: Vec<CString> = std::env::args_os().map(|a| cstring(a.as_bytes())).collect::<Result<_, _>>()?;
    let mut envp: Vec<CString> = std::env::vars_os()
        .map(|(mut pair, v)| {
            pair.push("=");
            pair.push(v);
            cstring(pair.as_bytes())
        })
        .collect::<Result<_, _>>()?;
    envp.push(cstring(format!("{MARK}=1").as_bytes())?);
    let mut argv_ptrs: Vec<*mut libc::c_char> = argv.iter().map(|a| a.as_ptr() as *mut _).collect();
    argv_ptrs.push(std::ptr::null_mut());
    let mut envp_ptrs: Vec<*mut libc::c_char> = envp.iter().map(|e| e.as_ptr() as *mut _).collect();
    envp_ptrs.push(std::ptr::null_mut());

    unsafe {
        let mut attr: libc::posix_spawnattr_t = std::ptr::null_mut();
        if libc::posix_spawnattr_init(&mut attr) != 0 {
            return Err("posix_spawnattr_init failed".into());
        }
        let disclaimed = responsibility_spawnattrs_setdisclaim(&mut attr, 1);
        let mut pid: libc::pid_t = 0;
        let spawned = if disclaimed == 0 {
            libc::posix_spawn(&mut pid, exe.as_ptr(), std::ptr::null(), &attr, argv_ptrs.as_ptr(), envp_ptrs.as_ptr())
        } else {
            disclaimed
        };
        libc::posix_spawnattr_destroy(&mut attr);
        if disclaimed != 0 {
            return Err(format!("could not disclaim responsibility for the helper: errno {disclaimed}"));
        }
        if spawned != 0 {
            return Err(format!("could not start the helper: errno {spawned}"));
        }
        let mut status: libc::c_int = 0;
        loop {
            if libc::waitpid(pid, &mut status, 0) == pid {
                break;
            }
            if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                return Err("lost the helper child".into());
            }
        }
        if libc::WIFEXITED(status) {
            Ok(libc::WEXITSTATUS(status))
        } else if libc::WIFSIGNALED(status) {
            Ok(128 + libc::WTERMSIG(status))
        } else {
            Ok(1)
        }
    }
}

/// The child must not outlive the process its caller is waiting on.
fn exit_with_parent() {
    let parent = unsafe { libc::getppid() };
    if parent == 1 {
        unsafe { libc::_exit(1) };
    }
    std::thread::spawn(move || unsafe {
        let queue = libc::kqueue();
        if queue < 0 {
            return;
        }
        let watch = libc::kevent {
            ident: parent as libc::uintptr_t,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_ONESHOT,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        let mut event: libc::kevent = std::mem::zeroed();
        let registered = libc::kevent(queue, &watch, 1, std::ptr::null_mut(), 0, std::ptr::null());
        if registered < 0 || libc::getppid() != parent {
            libc::_exit(1);
        }
        loop {
            let n = libc::kevent(queue, std::ptr::null(), 0, &mut event, 1, std::ptr::null());
            if n > 0 {
                libc::_exit(1);
            }
            if n < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                return;
            }
        }
    });
}
