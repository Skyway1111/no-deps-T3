//! Change notification: each platform only reports that something changed; the index rescans
//! and diffs. Linux watches every indexed folder with inotify, macOS uses FSEvents, Windows
//! a recursive ReadDirectoryChangesW.

use std::path::Path;
use std::sync::Arc;

pub type OnChange = Arc<dyn Fn() + Send + Sync>;

pub fn is_git_internal(path: &str) -> bool {
    path.split(['/', '\\']).any(|segment| segment == ".git")
}

#[cfg(target_os = "linux")]
pub struct Watcher {
    fd: i32,
}

#[cfg(target_os = "linux")]
impl Watcher {
    pub fn start(_root: &Path, on_change: OnChange) -> Option<Watcher> {
        unsafe extern "C" {
            fn inotify_init1(flags: i32) -> i32;
        }
        let fd = unsafe { inotify_init1(0o2000000) };
        if fd < 0 {
            return None;
        }
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = unsafe { crate::posix::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
                if n < 0 && crate::posix::errno() == crate::posix::EINTR {
                    continue;
                }
                if n <= 0 {
                    return;
                }
                on_change();
            }
        });
        Some(Watcher { fd })
    }

    /// Watches each folder; re-adding one already watched is a no-op in the kernel.
    pub fn watch_dirs<'a>(&self, root: &Path, dirs: impl Iterator<Item = &'a str>) {
        use std::os::unix::ffi::OsStrExt;
        unsafe extern "C" {
            fn inotify_add_watch(fd: i32, path: *const std::ffi::c_char, mask: u32) -> i32;
        }
        // CREATE | DELETE | MOVED_FROM | MOVED_TO | CLOSE_WRITE | ATTRIB | DELETE_SELF | ONLYDIR
        const MASK: u32 = 0x100 | 0x200 | 0x40 | 0x80 | 0x8 | 0x4 | 0x400 | 0x0100_0000;
        for dir in std::iter::once("").chain(dirs) {
            let path = if dir.is_empty() { root.to_path_buf() } else { root.join(dir) };
            if let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) {
                unsafe { inotify_add_watch(self.fd, c.as_ptr(), MASK) };
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub struct Watcher;

#[cfg(target_os = "macos")]
impl Watcher {
    pub fn start(root: &Path, on_change: OnChange) -> Option<Watcher> {
        use std::ffi::{c_char, c_void};
        type Callback = extern "C" fn(*const c_void, *mut c_void, usize, *mut c_void, *const u32, *const u64);
        #[repr(C)]
        struct Context {
            version: isize,
            info: *mut c_void,
            retain: *const c_void,
            release: *const c_void,
            copy_description: *const c_void,
        }
        #[link(name = "CoreServices", kind = "framework")]
        unsafe extern "C" {
            fn FSEventStreamCreate(
                alloc: *const c_void,
                cb: Callback,
                ctx: *const Context,
                paths: *const c_void,
                since: u64,
                latency: f64,
                flags: u32,
            ) -> *mut c_void;
            fn FSEventStreamSetDispatchQueue(stream: *mut c_void, queue: *mut c_void);
            fn FSEventStreamStart(stream: *mut c_void) -> u8;
        }
        #[link(name = "CoreFoundation", kind = "framework")]
        unsafe extern "C" {
            fn CFStringCreateWithCString(alloc: *const c_void, s: *const c_char, encoding: u32) -> *const c_void;
            fn CFArrayCreate(alloc: *const c_void, values: *const *const c_void, n: isize, cbs: *const c_void) -> *const c_void;
            static kCFTypeArrayCallBacks: c_void;
        }
        unsafe extern "C" {
            fn dispatch_queue_create(label: *const c_char, attr: *const c_void) -> *mut c_void;
        }
        extern "C" fn callback(_: *const c_void, info: *mut c_void, n: usize, paths: *mut c_void, _: *const u32, _: *const u64) {
            // Without kFSEventStreamCreateFlagUseCFTypes, paths is a C array of C strings.
            let paths = paths as *const *const c_char;
            let relevant = (0..n).any(|i| {
                let p = unsafe { std::ffi::CStr::from_ptr(*paths.add(i)) };
                !super::watch::is_git_internal(&p.to_string_lossy())
            });
            if relevant {
                let on_change = unsafe { &*(info as *const OnChange) };
                on_change();
            }
        }
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(root.as_os_str().as_bytes()).ok()?;
        let info = Box::into_raw(Box::new(on_change)) as *mut c_void;
        unsafe {
            let cf_path = CFStringCreateWithCString(std::ptr::null(), path.as_ptr(), 0x0800_0100);
            let array = CFArrayCreate(std::ptr::null(), &cf_path, 1, &raw const kCFTypeArrayCallBacks);
            let ctx = Context { version: 0, info, retain: std::ptr::null(), release: std::ptr::null(), copy_description: std::ptr::null() };
            // kFSEventStreamCreateFlagNoDefer | FileEvents
            let stream = FSEventStreamCreate(std::ptr::null(), callback, &ctx, array, u64::MAX, 0.05, 0x2 | 0x10);
            if stream.is_null() {
                return None;
            }
            FSEventStreamSetDispatchQueue(stream, dispatch_queue_create(c"t3-sys.fsevents".as_ptr(), std::ptr::null()));
            (FSEventStreamStart(stream) != 0).then_some(Watcher)
        }
    }
    pub fn watch_dirs<'a>(&self, _root: &Path, _dirs: impl Iterator<Item = &'a str>) {}
}

#[cfg(windows)]
pub struct Watcher;

#[cfg(windows)]
impl Watcher {
    pub fn start(root: &Path, on_change: OnChange) -> Option<Watcher> {
        use std::ffi::c_void;
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CreateFileW(name: *const u16, access: u32, share: u32, sa: *const c_void, disp: u32, flags: u32, tmpl: isize) -> isize;
            fn ReadDirectoryChangesW(
                h: isize,
                buf: *mut u8,
                len: u32,
                subtree: i32,
                filter: u32,
                ret: *mut u32,
                ov: *mut c_void,
                cb: *const c_void,
            ) -> i32;
        }
        let wide: Vec<u16> = root.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        // FILE_LIST_DIRECTORY, share all, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS
        let h = unsafe { CreateFileW(wide.as_ptr(), 1, 7, std::ptr::null(), 3, 0x0200_0000, 0) };
        if h == -1 {
            return None;
        }
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let mut n = 0u32;
                // FILE_NAME | DIR_NAME | SIZE | LAST_WRITE
                let ok = unsafe {
                    ReadDirectoryChangesW(h, buf.as_mut_ptr(), buf.len() as u32, 1, 0x1 | 0x2 | 0x8 | 0x10, &mut n, std::ptr::null_mut(), std::ptr::null())
                };
                if ok == 0 {
                    return;
                }
                let mut relevant = n == 0;
                let mut off = 0usize;
                while (off + 12) <= n as usize {
                    let next = u32::from_le_bytes(buf[off..off + 4].try_into().unwrap_or_default()) as usize;
                    let len = u32::from_le_bytes(buf[off + 8..off + 12].try_into().unwrap_or_default()) as usize;
                    let name: Vec<u16> = buf[off + 12..(off + 12 + len).min(n as usize)]
                        .as_chunks::<2>()
                        .0
                        .iter()
                        .map(|c| u16::from_le_bytes(*c))
                        .collect();
                    relevant |= !is_git_internal(&String::from_utf16_lossy(&name));
                    if next == 0 {
                        break;
                    }
                    off += next;
                }
                if relevant {
                    on_change();
                }
            }
        });
        Some(Watcher)
    }
    pub fn watch_dirs<'a>(&self, _root: &Path, _dirs: impl Iterator<Item = &'a str>) {}
}
