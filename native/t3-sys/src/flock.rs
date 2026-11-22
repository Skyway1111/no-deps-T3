//! `t3-sys flock PATH [--wait-ms N]`: takes an exclusive advisory lock on PATH (created if
//! missing), prints `locked`, and holds it until stdin closes. The kernel drops the lock when
//! this process dies, so a crashed owner never leaves a stale lock. Exit 3 means still busy.

use std::fs::File;
use std::io::Read;
use std::sync::mpsc;
use std::time::Duration;

pub const BUSY: i32 = 3;

pub enum Outcome {
    Locked(File),
    Busy,
}

/// Locks `path`, waiting up to `wait` in a blocking kernel call rather than polling.
pub fn acquire(path: &str, wait: Duration) -> std::io::Result<Outcome> {
    let file = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)?;
    if os::try_lock(&file)? {
        return Ok(Outcome::Locked(file));
    }
    if wait.is_zero() {
        return Ok(Outcome::Busy);
    }
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = os::lock(&file).map(|_| file);
        let _ = tx.send(result);
    });
    match rx.recv_timeout(wait) {
        Ok(result) => result.map(Outcome::Locked),
        Err(_) => Ok(Outcome::Busy),
    }
}

pub fn run(args: &[String]) -> i32 {
    let Some(path) = args.first() else {
        eprintln!("usage: t3-sys flock PATH [--wait-ms N]");
        return 2;
    };
    let wait_ms = match args.get(1).map(String::as_str) {
        Some("--wait-ms") => args.get(2).and_then(|v| v.parse().ok()).unwrap_or(0),
        _ => 0,
    };
    match acquire(path, Duration::from_millis(wait_ms)) {
        Ok(Outcome::Locked(_file)) => {
            println!("locked");
            let _ = std::io::stdin().read_to_end(&mut Vec::new());
            0
        }
        Ok(Outcome::Busy) => {
            println!("busy");
            BUSY
        }
        Err(error) => {
            eprintln!("t3-sys flock: {path}: {error}");
            1
        }
    }
}

#[cfg(unix)]
mod os {
    use crate::posix::{EINTR, LOCK_EX, LOCK_NB, errno, flock};
    use std::fs::File;
    use std::os::fd::AsRawFd;

    pub fn try_lock(file: &File) -> std::io::Result<bool> {
        if unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) } == 0 {
            return Ok(true);
        }
        let err = std::io::Error::last_os_error();
        if err.kind() == std::io::ErrorKind::WouldBlock { Ok(false) } else { Err(err) }
    }

    pub fn lock(file: &File) -> std::io::Result<()> {
        loop {
            if unsafe { flock(file.as_raw_fd(), LOCK_EX) } == 0 {
                return Ok(());
            }
            if errno() != EINTR {
                return Err(std::io::Error::last_os_error());
            }
        }
    }
}

#[cfg(windows)]
mod os {
    use std::ffi::c_void;
    use std::fs::File;
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    struct Overlapped([usize; 3], isize);

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LockFileEx(h: *mut c_void, flags: u32, reserved: u32, low: u32, high: u32, ov: *mut Overlapped) -> i32;
    }
    const EXCLUSIVE: u32 = 2;
    const FAIL_IMMEDIATELY: u32 = 1;
    const ERROR_LOCK_VIOLATION: i32 = 33;

    fn lock_with(file: &File, flags: u32) -> std::io::Result<bool> {
        let mut ov = Overlapped([0; 3], 0);
        if unsafe { LockFileEx(file.as_raw_handle(), flags, 0, u32::MAX, u32::MAX, &mut ov) } != 0 {
            return Ok(true);
        }
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(ERROR_LOCK_VIOLATION) { Ok(false) } else { Err(err) }
    }
    pub fn try_lock(file: &File) -> std::io::Result<bool> {
        lock_with(file, EXCLUSIVE | FAIL_IMMEDIATELY)
    }
    pub fn lock(file: &File) -> std::io::Result<()> {
        lock_with(file, EXCLUSIVE).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn second_lock_is_busy_until_first_drops() {
        let path = std::env::temp_dir().join(format!("t3-sys-flock-{}", std::process::id()));
        let path = path.to_str().unwrap();
        let Outcome::Locked(first) = acquire(path, Duration::ZERO).unwrap() else { panic!() };
        assert!(matches!(acquire(path, Duration::from_millis(30)).unwrap(), Outcome::Busy));
        let waiter = std::thread::spawn({
            let path = path.to_owned();
            move || matches!(acquire(&path, Duration::from_secs(5)).unwrap(), Outcome::Locked(_))
        });
        std::thread::sleep(Duration::from_millis(20));
        drop(first);
        assert!(waiter.join().unwrap());
        let _ = std::fs::remove_file(path);
    }
}
