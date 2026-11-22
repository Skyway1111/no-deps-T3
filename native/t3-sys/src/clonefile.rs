//! `t3-sys clonefile SRC DST`: macOS clonefile(2), a copy-on-write clone of a file or a whole
//! folder in one kernel call. Exit 1 prints `{"errno":N}` to stderr; exit 2 means unsupported.

pub fn run(args: &[String]) -> i32 {
    let [source, destination] = args else {
        eprintln!("usage: t3-sys clonefile SRC DST");
        return 1;
    };
    match os::clone(source, destination) {
        Some(Ok(())) => 0,
        Some(Err(errno)) => {
            eprintln!("{}", crate::json::obj([("errno", errno.into())]));
            1
        }
        None => 2,
    }
}

#[cfg(target_os = "macos")]
mod os {
    use std::ffi::{CString, c_char, c_int};

    unsafe extern "C" {
        fn clonefile(src: *const c_char, dst: *const c_char, flags: u32) -> c_int;
    }
    /// Clone a symlink itself rather than its target.
    const CLONE_NOFOLLOW: u32 = 0x0001;
    const EINVAL: i32 = 22;

    pub fn clone(source: &str, destination: &str) -> Option<Result<(), i32>> {
        let (Ok(source), Ok(destination)) = (CString::new(source), CString::new(destination)) else {
            return Some(Err(EINVAL));
        };
        if unsafe { clonefile(source.as_ptr(), destination.as_ptr(), CLONE_NOFOLLOW) } == 0 {
            return Some(Ok(()));
        }
        Some(Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(0)))
    }
}

#[cfg(not(target_os = "macos"))]
mod os {
    pub fn clone(_: &str, _: &str) -> Option<Result<(), i32>> {
        None
    }
}
