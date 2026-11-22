//! The libc surface t3-sys uses, declared by hand (Linux and macOS).
#![allow(non_camel_case_types)]

use std::ffi::{c_char, c_int, c_short, c_ulong, c_void};

pub type pid_t = i32;

#[repr(C)]
pub struct pollfd {
    pub fd: c_int,
    pub events: c_short,
    pub revents: c_short,
}

#[repr(C)]
pub struct winsize {
    pub ws_row: u16,
    pub ws_col: u16,
    pub ws_xpixel: u16,
    pub ws_ypixel: u16,
}

unsafe extern "C" {
    pub fn posix_openpt(flags: c_int) -> c_int;
    pub fn grantpt(fd: c_int) -> c_int;
    pub fn unlockpt(fd: c_int) -> c_int;
    pub fn ptsname(fd: c_int) -> *mut c_char;
    pub fn open(path: *const c_char, flags: c_int, ...) -> c_int;
    pub fn close(fd: c_int) -> c_int;
    pub fn read(fd: c_int, buf: *mut c_void, n: usize) -> isize;
    pub fn write(fd: c_int, buf: *const c_void, n: usize) -> isize;
    pub fn dup2(src: c_int, dst: c_int) -> c_int;
    pub fn pipe(fds: *mut c_int) -> c_int;
    pub fn fcntl(fd: c_int, cmd: c_int, ...) -> c_int;
    pub fn ioctl(fd: c_int, req: c_ulong, ...) -> c_int;
    pub fn poll(fds: *mut pollfd, n: c_ulong, timeout: c_int) -> c_int;
    pub fn fork() -> pid_t;
    pub fn setsid() -> pid_t;
    pub fn chdir(path: *const c_char) -> c_int;
    pub fn execve(path: *const c_char, argv: *const *const c_char, envp: *const *const c_char) -> c_int;
    pub fn _exit(code: c_int) -> !;
    pub fn waitpid(pid: pid_t, status: *mut c_int, options: c_int) -> pid_t;
    pub fn kill(pid: pid_t, sig: c_int) -> c_int;
    pub fn signal(sig: c_int, handler: usize) -> usize;
    pub fn sigprocmask(how: c_int, set: *const c_void, old: *mut c_void) -> c_int;
    pub fn flock(fd: c_int, op: c_int) -> c_int;
}

pub const O_RDWR: c_int = 2;
pub const F_GETFL: c_int = 3;
pub const F_SETFL: c_int = 4;
pub const F_SETFD: c_int = 2;
pub const FD_CLOEXEC: c_int = 1;
pub const POLLIN: c_short = 1;
pub const POLLOUT: c_short = 4;
pub const POLLERR: c_short = 8;
pub const POLLHUP: c_short = 0x10;
pub const WNOHANG: c_int = 1;
pub const SIG_DFL: usize = 0;
pub const SIG_SETMASK: c_int = 2;
pub const SIGCHLD: c_int = if cfg!(target_os = "linux") { 17 } else { 20 };
pub const SIGPIPE: c_int = 13;
pub const LOCK_EX: c_int = 2;
pub const LOCK_NB: c_int = 4;
pub const EINTR: i32 = 4;
pub const EIO: i32 = 5;

#[cfg(target_os = "linux")]
mod os {
    use std::ffi::{c_int, c_ulong};
    pub const O_NOCTTY: c_int = 0x100;
    pub const O_NONBLOCK: c_int = 0x800;
    pub const TIOCSWINSZ: c_ulong = 0x5414;
    pub const TIOCSCTTY: c_ulong = 0x540E;
    pub const EAGAIN: i32 = 11;
    pub const SIGSET_BYTES: usize = 128;
}
#[cfg(target_os = "macos")]
mod os {
    use std::ffi::{c_int, c_ulong};
    pub const O_NOCTTY: c_int = 0x20000;
    pub const O_NONBLOCK: c_int = 0x4;
    pub const TIOCSWINSZ: c_ulong = 0x80087467;
    pub const TIOCSCTTY: c_ulong = 0x20007461;
    pub const EAGAIN: i32 = 35;
    pub const SIGSET_BYTES: usize = 4;
}
pub use os::*;

pub const SIGNALS: [(&str, c_int); 15] = [
    ("SIGHUP", 1),
    ("SIGINT", 2),
    ("SIGQUIT", 3),
    ("SIGKILL", 9),
    ("SIGUSR1", if cfg!(target_os = "linux") { 10 } else { 30 }),
    ("SIGUSR2", if cfg!(target_os = "linux") { 12 } else { 31 }),
    ("SIGPIPE", 13),
    ("SIGALRM", 14),
    ("SIGTERM", 15),
    ("SIGCHLD", SIGCHLD),
    ("SIGCONT", if cfg!(target_os = "linux") { 18 } else { 19 }),
    ("SIGSTOP", if cfg!(target_os = "linux") { 19 } else { 17 }),
    ("SIGTSTP", if cfg!(target_os = "linux") { 20 } else { 18 }),
    ("SIGWINCH", 28),
    ("SIGABRT", 6),
];

pub fn signal_number(name: &str) -> Option<c_int> {
    let upper = name.to_ascii_uppercase();
    let full = if upper.starts_with("SIG") { upper } else { format!("SIG{upper}") };
    SIGNALS.iter().find(|(n, _)| *n == full).map(|(_, v)| *v).or_else(|| name.parse().ok())
}

pub fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

pub fn set_flags(fd: c_int, nonblock: bool, cloexec: bool) {
    unsafe {
        if nonblock {
            let flags = fcntl(fd, F_GETFL);
            fcntl(fd, F_SETFL, flags | O_NONBLOCK);
        }
        if cloexec {
            fcntl(fd, F_SETFD, FD_CLOEXEC);
        }
    }
}

/// Writes all of `buf`, retrying on EINTR; for blocking descriptors.
pub fn write_all(fd: c_int, mut buf: &[u8]) -> bool {
    while !buf.is_empty() {
        let n = unsafe { write(fd, buf.as_ptr().cast(), buf.len()) };
        if n < 0 {
            if errno() == EINTR {
                continue;
            }
            return false;
        }
        buf = &buf[n as usize..];
    }
    true
}
