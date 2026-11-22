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
    /// Watched folder (root is `""`) → watch descriptor.
    watched: std::sync::Mutex<std::collections::HashMap<String, i32>>,
    root_wd: Arc<std::sync::atomic::AtomicI32>,
    /// Descriptors the kernel dropped (IN_IGNORED), whose paths must be watched afresh.
    dropped: Arc<std::sync::Mutex<Vec<i32>>>,
}

#[cfg(target_os = "linux")]
unsafe extern "C" {
    fn inotify_add_watch(fd: i32, path: *const std::ffi::c_char, mask: u32) -> i32;
    fn inotify_rm_watch(fd: i32, wd: i32) -> i32;
}

#[cfg(target_os = "linux")]
impl Watcher {
    pub fn start(_root: &Path, on_change: OnChange) -> Option<Watcher> {
        use std::sync::atomic::{AtomicI32, Ordering};
        unsafe extern "C" {
            fn inotify_init1(flags: i32) -> i32;
        }
        const IN_IGNORED: u32 = 0x8000;
        let fd = unsafe { inotify_init1(0o2000000) };
        if fd < 0 {
            return None;
        }
        let root_wd = Arc::new(AtomicI32::new(-2));
        let dropped: Arc<std::sync::Mutex<Vec<i32>>> = Default::default();
        let (root, dead) = (root_wd.clone(), dropped.clone());
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
                // struct inotify_event { int wd; u32 mask, cookie, len; char name[len]; }
                let (events, root_wd) = (&buf[..n as usize], root.load(Ordering::Relaxed));
                let (mut off, mut relevant) = (0, false);
                while off + 16 <= events.len() {
                    let word = |i: usize| u32::from_ne_bytes(events[off + i..off + i + 4].try_into().unwrap_or_default());
                    let (wd, mask, len) = (word(0) as i32, word(4), word(12) as usize);
                    let name = events.get(off + 16..off + 16 + len).unwrap_or_default();
                    let name = &name[..name.iter().position(|&b| b == 0).unwrap_or(name.len())];
                    if mask & IN_IGNORED != 0 {
                        dead.lock().unwrap_or_else(|e| e.into_inner()).push(wd);
                    }
                    relevant |= !(wd == root_wd && name == b".git");
                    off += 16 + len;
                }
                if relevant {
                    on_change();
                }
            }
        });
        Some(Watcher { fd, watched: Default::default(), root_wd, dropped })
    }

    /// Watches new folders and drops vanished ones, so an unchanged tree costs no syscalls.
    pub fn watch_dirs<'a>(&self, root: &Path, dirs: impl Iterator<Item = &'a str>) {
        use std::os::unix::ffi::OsStrExt;
        // CREATE | DELETE | MOVED_FROM | MOVED_TO | CLOSE_WRITE | ATTRIB | DELETE_SELF | ONLYDIR
        const MASK: u32 = 0x100 | 0x200 | 0x40 | 0x80 | 0x8 | 0x4 | 0x400 | 0x0100_0000;
        let mut watched = self.watched.lock().unwrap_or_else(|e| e.into_inner());
        let mut old = std::mem::take(&mut *watched);
        let dropped = std::mem::take(&mut *self.dropped.lock().unwrap_or_else(|e| e.into_inner()));
        old.retain(|_, wd| !dropped.contains(wd));
        for dir in std::iter::once("").chain(dirs) {
            let wd = match old.remove(dir) {
                Some(wd) => wd,
                None => {
                    let path = if dir.is_empty() { root.to_path_buf() } else { root.join(dir) };
                    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { continue };
                    let wd = unsafe { inotify_add_watch(self.fd, c.as_ptr(), MASK) };
                    if wd < 0 {
                        continue;
                    }
                    wd
                }
            };
            if dir.is_empty() {
                self.root_wd.store(wd, std::sync::atomic::Ordering::Relaxed);
            }
            watched.insert(dir.to_owned(), wd);
        }
        // A renamed folder keeps its inode and so its descriptor under the new path.
        let live: std::collections::HashSet<i32> = watched.values().copied().collect();
        for wd in old.into_values().filter(|wd| !live.contains(wd)) {
            unsafe { inotify_rm_watch(self.fd, wd) };
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
