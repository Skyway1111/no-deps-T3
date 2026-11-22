//! `t3-sys win foreground|activate HWND|watch-keys VK1 VK2 [INTERVAL_MS]`: Windows foreground
//! window queries and activation, and a poll for two keys held together that prints `ready` then
//! `trigger` on each press until stdin closes. Exit 3 means not Windows.

pub fn run(args: &[String]) -> i32 {
    let arg = |i: usize| args.get(i).map(String::as_str);
    let result = match (arg(0), arg(1), arg(2)) {
        (Some("foreground"), _, _) => os::foreground().map(|window| println!("{window}")),
        (Some("activate"), Some(hwnd), _) => {
            let hwnd = hwnd.strip_prefix("0x").map_or_else(|| hwnd.parse(), |hex| usize::from_str_radix(hex, 16));
            let Ok(hwnd) = hwnd else {
                eprintln!("invalid window handle");
                return 1;
            };
            os::activate(hwnd).map(|activated| println!("{}", crate::json::obj([("activated", activated.into())])))
        }
        (Some("watch-keys"), Some(first), Some(second)) => {
            let (Ok(first), Ok(second)) = (first.parse(), second.parse()) else {
                eprintln!("invalid virtual key");
                return 1;
            };
            let interval = arg(3).and_then(|ms| ms.parse().ok()).unwrap_or(50);
            os::watch_keys(first, second, std::time::Duration::from_millis(interval))
        }
        _ => {
            eprintln!("usage: t3-sys win foreground|activate HWND|watch-keys VK1 VK2 [INTERVAL_MS]");
            return 1;
        }
    };
    if result.is_some() { 0 } else { 3 }
}

#[cfg(windows)]
mod os {
    use crate::json::{Value, obj};
    use std::ffi::c_void;
    use std::io::{Read, Write};

    type Hwnd = *mut c_void;

    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetForegroundWindow() -> Hwnd;
        fn GetClassNameW(hwnd: Hwnd, name: *mut u16, chars: i32) -> i32;
        fn GetWindowThreadProcessId(hwnd: Hwnd, pid: *mut u32) -> u32;
        fn GetWindowTextW(hwnd: Hwnd, text: *mut u16, chars: i32) -> i32;
        fn GetWindowRect(hwnd: Hwnd, rect: *mut Rect) -> i32;
        fn AttachThreadInput(from: u32, to: u32, attach: i32) -> i32;
        fn SetForegroundWindow(hwnd: Hwnd) -> i32;
        fn GetAsyncKeyState(key: i32) -> i16;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentThreadId() -> u32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn QueryFullProcessImageNameW(process: isize, flags: u32, path: *mut u16, chars: *mut u32) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    fn text(read: impl FnOnce(*mut u16, i32) -> i32, capacity: usize) -> String {
        let mut buffer = vec![0u16; capacity];
        let len = read(buffer.as_mut_ptr(), capacity as i32);
        String::from_utf16_lossy(&buffer[..len.clamp(0, capacity as i32) as usize])
    }

    fn image_path(pid: u32) -> String {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process == 0 {
            return String::new();
        }
        let mut chars = 32_768u32;
        let mut path = vec![0u16; chars as usize];
        let ok = unsafe { QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut chars) };
        unsafe { CloseHandle(process) };
        if ok == 0 { String::new() } else { String::from_utf16_lossy(&path[..chars as usize]) }
    }

    pub fn foreground() -> Option<Value> {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() {
            return Some(Value::Null);
        }
        let mut pid = 0u32;
        let tid = unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        let mut r = Rect::default();
        let rect = if unsafe { GetWindowRect(hwnd, &mut r) } == 0 {
            Value::Null
        } else {
            obj([("left", r.left.into()), ("top", r.top.into()), ("right", r.right.into()), ("bottom", r.bottom.into())])
        };
        Some(obj([
            ("hwnd", format!("{:#x}", hwnd as usize).into()),
            ("className", text(|p, n| unsafe { GetClassNameW(hwnd, p, n) }, 256).into()),
            ("pid", pid.into()),
            ("tid", tid.into()),
            ("title", text(|p, n| unsafe { GetWindowTextW(hwnd, p, n) }, 1024).into()),
            ("rect", rect),
            ("imagePath", if pid == 0 { String::new() } else { image_path(pid) }.into()),
        ]))
    }

    /// Windows only lets the foreground thread move the foreground, so borrow its input state.
    pub fn activate(target: usize) -> Option<bool> {
        let target = target as Hwnd;
        let foreground = unsafe { GetForegroundWindow() };
        if target == foreground {
            return Some(true);
        }
        let current = unsafe { GetCurrentThreadId() };
        let owner = if foreground.is_null() { 0 } else { unsafe { GetWindowThreadProcessId(foreground, std::ptr::null_mut()) } };
        let attached = current != 0 && owner != 0 && current != owner && unsafe { AttachThreadInput(current, owner, 1) } != 0;
        let activated = unsafe { SetForegroundWindow(target) } != 0;
        if attached {
            unsafe { AttachThreadInput(current, owner, 0) };
        }
        Some(activated)
    }

    pub fn watch_keys(first: i32, second: i32, interval: std::time::Duration) -> Option<()> {
        std::thread::spawn(|| {
            let _ = std::io::stdin().read_to_end(&mut Vec::new());
            std::process::exit(0);
        });
        let mut out = std::io::stdout();
        let mut emit = |line: &[u8]| out.write_all(line).and_then(|_| out.flush()).is_ok();
        if !emit(b"ready\n") {
            return Some(());
        }
        let mut held = false;
        loop {
            let pressed = unsafe { GetAsyncKeyState(first) < 0 && GetAsyncKeyState(second) < 0 };
            if pressed && !held && !emit(b"trigger\n") {
                return Some(());
            }
            held = pressed;
            std::thread::sleep(interval);
        }
    }
}

#[cfg(not(windows))]
mod os {
    pub fn foreground() -> Option<crate::json::Value> {
        None
    }
    pub fn activate(_: usize) -> Option<bool> {
        None
    }
    pub fn watch_keys(_: i32, _: i32, _: std::time::Duration) -> Option<()> {
        None
    }
}
