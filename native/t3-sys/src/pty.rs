//! `t3-sys pty --cols C --rows R --cwd DIR -- FILE [ARGS...]`
//!
//! stdin carries raw input and stdout raw output. fd 3 is a JSON-line control socket: the
//! helper sends `{"pid":N}`, `{"error":"..."}` or `{"exit":C,"signal":S}`; it accepts
//! `{"resize":[cols,rows]}` and `{"kill":"SIGTERM"}`. When fd 3 closes the PTY closes too.

use crate::json::{self, Value};

pub struct Options {
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<String>,
    pub file: String,
    pub args: Vec<String>,
}

pub fn parse_args(args: &[String]) -> Result<Options, String> {
    let mut opts = Options { cols: 80, rows: 24, cwd: None, file: String::new(), args: Vec::new() };
    let mut i = 0;
    while i < args.len() {
        let value = || args.get(i + 1).cloned().ok_or_else(|| format!("{} needs a value", args[i]));
        match args[i].as_str() {
            "--cols" => opts.cols = value()?.parse().map_err(|_| "bad --cols")?,
            "--rows" => opts.rows = value()?.parse().map_err(|_| "bad --rows")?,
            "--cwd" => opts.cwd = Some(value()?),
            "--" => {
                opts.file = args.get(i + 1).cloned().ok_or("missing program")?;
                opts.args = args[i + 2..].to_vec();
                return Ok(opts);
            }
            other => return Err(format!("unknown pty option {other}")),
        }
        i += 2;
    }
    Err("missing -- PROGRAM".into())
}

pub enum Command {
    Resize(u16, u16),
    Kill(Option<String>),
}

pub fn parse_command(line: &str) -> Option<Command> {
    let v = json::parse(line).ok()?;
    if let Some([c, r]) = v.get("resize").and_then(Value::arr) {
        return Some(Command::Resize(c.num()?.clamp(1.0, 65535.0) as u16, r.num()?.clamp(1.0, 65535.0) as u16));
    }
    v.get("kill").map(|s| Command::Kill(s.str().map(str::to_owned)))
}

/// Splits complete lines off `buf`, leaving a partial tail.
pub fn take_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = buf.drain(..=pos).collect();
        lines.push(String::from_utf8_lossy(&line[..pos]).into_owned());
    }
    lines
}

pub fn exit_message(code: i64, signal: Option<i64>) -> String {
    json::obj([("exit", code.into()), ("signal", signal.map_or(Value::Null, Value::from))]).to_string()
}

#[cfg(unix)]
pub use unix::run;
#[cfg(windows)]
pub use windows::run;

#[cfg(unix)]
mod unix {
    use super::*;
    use crate::posix::*;
    use std::ffi::{CString, c_int};
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    const CTRL: c_int = 3;
    static mut SIGNAL_PIPE: c_int = -1;

    extern "C" fn on_sigchld(_: c_int) {
        let byte = 1u8;
        unsafe { write(SIGNAL_PIPE, (&raw const byte).cast(), 1) };
    }

    fn send(ctrl: bool, message: &str) {
        if ctrl {
            write_all(CTRL, format!("{message}\n").as_bytes());
        }
    }

    /// Finds `file` on PATH; relative entries (and a relative `file`) resolve against `cwd`.
    pub fn resolve_program(file: &str, path_var: Option<&std::ffi::OsStr>, cwd: &Path) -> Option<PathBuf> {
        if file.contains('/') {
            return Some(cwd.join(file));
        }
        let is_exec = |p: &Path| {
            use std::os::unix::fs::PermissionsExt;
            p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        };
        std::env::split_paths(path_var?).map(|dir| cwd.join(dir).join(file)).find(|p| is_exec(p))
    }

    fn cstr(bytes: &[u8]) -> Result<CString, String> {
        CString::new(bytes).map_err(|_| "argument contains a NUL byte".to_string())
    }

    pub fn run(args: &[String]) -> i32 {
        let ctrl = unsafe { fcntl(CTRL, F_SETFD, FD_CLOEXEC) } == 0;
        match spawn(args, ctrl) {
            Ok(code) => code,
            Err(error) => {
                send(ctrl, &json::obj([("error", error.clone().into())]).to_string());
                eprintln!("t3-sys pty: {error}");
                1
            }
        }
    }

    fn spawn(args: &[String], ctrl: bool) -> Result<i32, String> {
        let opts = parse_args(args)?;
        let cwd = opts.cwd.as_deref().map_or_else(|| std::env::current_dir().unwrap_or_default(), PathBuf::from);
        let program = resolve_program(&opts.file, std::env::var_os("PATH").as_deref(), &cwd)
            .ok_or_else(|| format!("{}: command not found", opts.file))?;
        let path = cstr(program.as_os_str().as_bytes())?;
        let argv_owned = std::iter::once(opts.file.as_str())
            .chain(opts.args.iter().map(String::as_str))
            .map(|a| cstr(a.as_bytes()))
            .collect::<Result<Vec<_>, _>>()?;
        let envp_owned = std::env::vars_os()
            .map(|(k, v)| cstr(&[k.as_bytes(), b"=", v.as_bytes()].concat()))
            .collect::<Result<Vec<_>, _>>()?;
        let mut argv: Vec<*const i8> = argv_owned.iter().map(|a| a.as_ptr()).collect();
        argv.push(std::ptr::null());
        let mut envp: Vec<*const i8> = envp_owned.iter().map(|a| a.as_ptr()).collect();
        envp.push(std::ptr::null());
        let cwd = opts.cwd.as_deref().map(|c| cstr(c.as_bytes())).transpose()?;

        unsafe {
            let master = posix_openpt(O_RDWR | O_NOCTTY);
            if master < 0 || grantpt(master) != 0 || unlockpt(master) != 0 {
                return Err(format!("openpty failed: {}", std::io::Error::last_os_error()));
            }
            let slave_name = std::ffi::CStr::from_ptr(ptsname(master)).to_owned();
            let ws = winsize { ws_row: opts.rows, ws_col: opts.cols, ws_xpixel: 0, ws_ypixel: 0 };
            ioctl(master, TIOCSWINSZ, &raw const ws);
            set_flags(master, false, true);

            let mut sig = [0; 2];
            let mut err = [0; 2];
            if pipe(sig.as_mut_ptr()) != 0 || pipe(err.as_mut_ptr()) != 0 {
                return Err("pipe failed".into());
            }
            for fd in [sig[0], sig[1], err[0], err[1]] {
                set_flags(fd, false, true);
            }
            set_flags(sig[0], true, true);
            set_flags(sig[1], true, true);
            SIGNAL_PIPE = sig[1];
            signal(SIGCHLD, on_sigchld as *const () as usize);

            let pid = fork();
            if pid < 0 {
                return Err(format!("fork failed: {}", std::io::Error::last_os_error()));
            }
            if pid == 0 {
                // Only async-signal-safe calls from here to exec.
                signal(SIGPIPE, SIG_DFL);
                signal(SIGCHLD, SIG_DFL);
                let empty = [0u8; SIGSET_BYTES];
                sigprocmask(SIG_SETMASK, empty.as_ptr().cast(), std::ptr::null_mut());
                let fail = |stage: u8| -> ! {
                    let code = errno();
                    let mut msg = [stage, 0, 0, 0, 0];
                    msg[1..].copy_from_slice(&code.to_ne_bytes());
                    write(err[1], msg.as_ptr().cast(), msg.len());
                    _exit(127)
                };
                setsid();
                let slave = open(slave_name.as_ptr(), O_RDWR);
                if slave < 0 {
                    fail(b's');
                }
                ioctl(slave, TIOCSCTTY, 0);
                for fd in 0..3 {
                    dup2(slave, fd);
                }
                if slave > 2 {
                    close(slave);
                }
                if let Some(cwd) = &cwd
                    && chdir(cwd.as_ptr()) != 0
                {
                    fail(b'c');
                }
                execve(path.as_ptr(), argv.as_ptr(), envp.as_ptr());
                fail(b'e');
            }

            close(err[1]);
            let mut msg = [0u8; 5];
            let n = loop {
                let n = read(err[0], msg.as_mut_ptr().cast(), msg.len());
                if n >= 0 || errno() != EINTR {
                    break n;
                }
            };
            close(err[0]);
            if n == 5 {
                waitpid(pid, std::ptr::null_mut(), 0);
                let code = i32::from_ne_bytes([msg[1], msg[2], msg[3], msg[4]]);
                let what = match msg[0] {
                    b's' => "open terminal",
                    b'c' => "change directory",
                    _ => "exec",
                };
                return Err(format!(
                    "{what} failed for {}: {}",
                    opts.file,
                    std::io::Error::from_raw_os_error(code)
                ));
            }
            send(ctrl, &json::obj([("pid", pid.into())]).to_string());
            Ok(bridge(master, sig[0], pid, ctrl))
        }
    }

    fn decode_status(status: c_int) -> (i64, Option<i64>) {
        if status & 0x7f == 0 { (((status >> 8) & 0xff) as i64, None) } else { (0, Some((status & 0x7f) as i64)) }
    }

    fn bridge(master: c_int, sig: c_int, pid: pid_t, ctrl: bool) -> i32 {
        unsafe { bridge_loop(master, sig, pid, ctrl) }
    }

    /// Bytes held each way before the bridge stops reading that side, so a flood or a stalled
    /// reader applies backpressure instead of growing memory, and control stays responsive.
    const BUFFER_CAP: usize = 256 * 1024;

    /// Moves bytes from `from` into `queue`, reading at most the room left under the cap.
    /// Returns false at EOF or on an error other than EAGAIN/EINTR.
    unsafe fn fill(from: c_int, queue: &mut std::collections::VecDeque<u8>, buf: &mut [u8]) -> bool {
        let room = BUFFER_CAP.saturating_sub(queue.len()).min(buf.len());
        let n = unsafe { read(from, buf.as_mut_ptr().cast(), room) };
        if n > 0 {
            queue.extend(&buf[..n as usize]);
        }
        n > 0 || (n < 0 && matches!(errno(), EAGAIN | EINTR))
    }

    /// Writes what `to` takes from the front of `queue`; false on an error other than EAGAIN/EINTR.
    unsafe fn flush(to: c_int, queue: &mut std::collections::VecDeque<u8>) -> bool {
        while !queue.is_empty() {
            let front = queue.as_slices().0;
            let n = unsafe { write(to, front.as_ptr().cast(), front.len()) };
            if n <= 0 {
                return n < 0 && matches!(errno(), EAGAIN | EINTR);
            }
            queue.drain(..n as usize);
        }
        true
    }

    unsafe fn bridge_loop(master: c_int, sig: c_int, pid: pid_t, ctrl: bool) -> i32 {
        unsafe {
        set_flags(master, true, true);
        set_flags(0, true, false);
        set_flags(1, true, false);
        let mut buf = vec![0u8; 64 * 1024];
        let (mut input, mut output) = (std::collections::VecDeque::new(), std::collections::VecDeque::new());
        let mut ctrl_buf: Vec<u8> = Vec::new();
        let (mut stdin_open, ctrl_open, mut master_open, mut stdout_open) = (true, ctrl, true, true);
        let mut status: Option<c_int> = None;
        loop {
            if let Some(status) = status {
                // Hand over the rest of the output before the exit; EAGAIN means only other
                // holders of the terminal remain.
                set_flags(1, false, false);
                while stdout_open && master_open {
                    master_open = fill(master, &mut output, &mut buf) && !output.is_empty();
                    stdout_open = flush(1, &mut output);
                }
                if stdout_open {
                    flush(1, &mut output);
                }
                let (code, signal) = decode_status(status);
                send(ctrl, &exit_message(code, signal));
                return 0;
            }
            let room = output.len() < BUFFER_CAP;
            let mut fds = [
                pollfd { fd: sig, events: POLLIN, revents: 0 },
                pollfd {
                    fd: if master_open { master } else { -1 },
                    events: if room { POLLIN } else { 0 } | if input.is_empty() { 0 } else { POLLOUT },
                    revents: 0,
                },
                pollfd { fd: if stdin_open && input.len() < BUFFER_CAP { 0 } else { -1 }, events: POLLIN, revents: 0 },
                pollfd { fd: if ctrl_open { CTRL } else { -1 }, events: POLLIN, revents: 0 },
                pollfd { fd: if stdout_open && !output.is_empty() { 1 } else { -1 }, events: POLLOUT, revents: 0 },
            ];
            if poll(fds.as_mut_ptr(), fds.len() as _, -1) < 0 {
                if errno() == EINTR {
                    continue;
                }
                return 1;
            }
            if fds[0].revents != 0 {
                while read(sig, buf.as_mut_ptr().cast(), buf.len()) > 0 {}
                let mut st = 0;
                if waitpid(pid, &raw mut st, WNOHANG) == pid {
                    status = Some(st);
                    continue;
                }
            }
            if fds[1].revents & POLLOUT != 0 {
                flush(master, &mut input);
            }
            if fds[2].revents != 0 {
                stdin_open = fill(0, &mut input, &mut buf);
            }
            if stdout_open && !output.is_empty() {
                stdout_open = flush(1, &mut output);
            }
            if room && fds[1].revents & (POLLIN | POLLHUP | POLLERR) != 0 {
                // Pass output straight through while stdout keeps up; a few rounds per poll
                // keep control commands prompt. EIO/EOF means every slave closed.
                for _ in 0..16 {
                    let n = read(master, buf.as_mut_ptr().cast(), buf.len());
                    if n <= 0 {
                        master_open = n < 0 && matches!(errno(), EAGAIN | EINTR);
                        break;
                    }
                    let chunk = &buf[..n as usize];
                    let written = if stdout_open && output.is_empty() { write(1, chunk.as_ptr().cast(), chunk.len()) } else { 0 };
                    if written < 0 && !matches!(errno(), EAGAIN | EINTR) {
                        stdout_open = false;
                    }
                    output.extend(&chunk[written.max(0) as usize..]);
                    if !output.is_empty() {
                        break;
                    }
                }
            }
            if !stdout_open {
                // Nobody reads the output any more; keep the program from blocking on it.
                output.clear();
            }
            if fds[3].revents != 0 {
                let n = read(CTRL, buf.as_mut_ptr().cast(), buf.len());
                if n <= 0 && !(n < 0 && (errno() == EAGAIN || errno() == EINTR)) {
                    // The owner is gone: closing the master hangs up the session like a closed terminal.
                    close(master);
                    return 0;
                }
                ctrl_buf.extend_from_slice(&buf[..n.max(0) as usize]);
                for line in take_lines(&mut ctrl_buf) {
                    match parse_command(&line) {
                        Some(Command::Resize(cols, rows)) => {
                            let ws = winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
                            ioctl(master, TIOCSWINSZ, &raw const ws);
                        }
                        Some(Command::Kill(name)) => {
                            let signal = name.as_deref().map_or(Some(1), signal_number);
                            if let Some(signal) = signal {
                                kill(pid, signal);
                            }
                        }
                        None => {}
                    }
                }
            }
        }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn resolves_from_path() {
            let root = Path::new("/");
            assert!(resolve_program("sh", Some(std::ffi::OsStr::new("/usr/bin:/bin")), root).is_some());
            assert!(resolve_program("sh", Some(std::ffi::OsStr::new("bin")), Path::new("/usr")).is_some());
            assert!(resolve_program("definitely-not-a-program", Some(std::ffi::OsStr::new("/bin")), root).is_none());
            assert_eq!(decode_status(3 << 8), (3, None));
            assert_eq!(decode_status(9), (0, Some(9)));
        }
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::ffi::c_void;
    use std::io::{Read, Write};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicIsize, Ordering};

    type Handle = isize;
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Coord {
        x: i16,
        y: i16,
    }
    #[repr(C)]
    struct StartupInfoExW {
        cb: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        dw: [u32; 8],
        show_window: u16,
        cb_reserved2: u16,
        reserved2: *mut u8,
        std_input: Handle,
        std_output: Handle,
        std_error: Handle,
        attribute_list: *mut c_void,
    }
    #[repr(C)]
    struct ProcessInformation {
        process: Handle,
        thread: Handle,
        pid: u32,
        tid: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreatePipe(read: *mut Handle, write: *mut Handle, attrs: *const c_void, size: u32) -> i32;
        fn CreatePseudoConsole(size: Coord, input: Handle, output: Handle, flags: u32, pc: *mut Handle) -> i32;
        fn ResizePseudoConsole(pc: Handle, size: Coord) -> i32;
        fn ClosePseudoConsole(pc: Handle);
        fn InitializeProcThreadAttributeList(list: *mut c_void, count: u32, flags: u32, size: *mut usize) -> i32;
        fn UpdateProcThreadAttribute(
            list: *mut c_void,
            flags: u32,
            attr: usize,
            value: *const c_void,
            size: usize,
            prev: *mut c_void,
            ret: *mut usize,
        ) -> i32;
        fn CreateProcessW(
            app: *const u16,
            cmd: *mut u16,
            pattrs: *const c_void,
            tattrs: *const c_void,
            inherit: i32,
            flags: u32,
            env: *const c_void,
            cwd: *const u16,
            si: *const StartupInfoExW,
            pi: *mut ProcessInformation,
        ) -> i32;
        fn WaitForSingleObject(h: Handle, ms: u32) -> u32;
        fn GetExitCodeProcess(h: Handle, code: *mut u32) -> i32;
        fn TerminateProcess(h: Handle, code: u32) -> i32;
        fn CloseHandle(h: Handle) -> i32;
        fn ReadFile(h: Handle, buf: *mut u8, n: u32, read: *mut u32, ov: *mut c_void) -> i32;
        fn WriteFile(h: Handle, buf: *const u8, n: u32, written: *mut u32, ov: *mut c_void) -> i32;
    }
    unsafe extern "C" {
        fn _get_osfhandle(fd: i32) -> isize;
    }

    const PSEUDOCONSOLE_ATTR: usize = 0x0002_0016;
    const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
    const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Quotes one argument the way CommandLineToArgvW parses it back.
    pub fn quote_arg(arg: &str, out: &mut String) {
        if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
            out.push_str(arg);
            return;
        }
        out.push('"');
        let mut backslashes = 0;
        for c in arg.chars() {
            match c {
                '\\' => backslashes += 1,
                '"' => {
                    out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                    out.push('"');
                    backslashes = 0;
                }
                c => {
                    out.extend(std::iter::repeat_n('\\', backslashes));
                    out.push(c);
                    backslashes = 0;
                }
            }
        }
        out.extend(std::iter::repeat_n('\\', backslashes * 2));
        out.push('"');
    }

    struct Pipe(Handle);
    impl Read for Pipe {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let mut n = 0;
            if unsafe { ReadFile(self.0, buf.as_mut_ptr(), buf.len() as u32, &mut n, std::ptr::null_mut()) } == 0 {
                return Ok(0);
            }
            Ok(n as usize)
        }
    }
    impl Write for Pipe {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let mut n = 0;
            if unsafe { WriteFile(self.0, buf.as_ptr(), buf.len() as u32, &mut n, std::ptr::null_mut()) } == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(n as usize)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    pub fn run(args: &[String]) -> i32 {
        let ctrl_handle = unsafe { _get_osfhandle(3) };
        let ctrl = (ctrl_handle != -1 && ctrl_handle != 0).then_some(ctrl_handle);
        let send = move |m: &str| {
            if let Some(h) = ctrl {
                let _ = Pipe(h).write_all(format!("{m}\n").as_bytes());
            }
        };
        match spawn(args, ctrl, &send) {
            Ok(code) => code,
            Err(error) => {
                send(&json::obj([("error", error.clone().into())]).to_string());
                1
            }
        }
    }

    fn spawn(args: &[String], ctrl: Option<Handle>, send: &dyn Fn(&str)) -> Result<i32, String> {
        let opts = parse_args(args)?;
        unsafe {
            let (mut in_read, mut in_write, mut out_read, mut out_write) = (0, 0, 0, 0);
            if CreatePipe(&mut in_read, &mut in_write, std::ptr::null(), 0) == 0
                || CreatePipe(&mut out_read, &mut out_write, std::ptr::null(), 0) == 0
            {
                return Err("CreatePipe failed".into());
            }
            let mut pc: Handle = 0;
            let size = Coord { x: opts.cols as i16, y: opts.rows as i16 };
            let hr = CreatePseudoConsole(size, in_read, out_write, 0, &mut pc);
            if hr < 0 {
                return Err(format!("CreatePseudoConsole failed: 0x{hr:08x}"));
            }
            CloseHandle(in_read);
            CloseHandle(out_write);

            let mut list_size = 0usize;
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut list_size);
            let mut list = vec![0u8; list_size];
            let list_ptr = list.as_mut_ptr().cast::<c_void>();
            if InitializeProcThreadAttributeList(list_ptr, 1, 0, &mut list_size) == 0
                || UpdateProcThreadAttribute(
                    list_ptr,
                    0,
                    PSEUDOCONSOLE_ATTR,
                    pc as *const c_void,
                    std::mem::size_of::<Handle>(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                ) == 0
            {
                return Err("UpdateProcThreadAttribute failed".into());
            }
            let si = StartupInfoExW {
                cb: std::mem::size_of::<StartupInfoExW>() as u32,
                reserved: std::ptr::null_mut(),
                desktop: std::ptr::null_mut(),
                title: std::ptr::null_mut(),
                dw: [0; 8],
                show_window: 0,
                cb_reserved2: 0,
                reserved2: std::ptr::null_mut(),
                std_input: 0,
                std_output: 0,
                std_error: 0,
                attribute_list: list_ptr,
            };
            let mut command = String::new();
            for (i, a) in std::iter::once(&opts.file).chain(&opts.args).enumerate() {
                if i > 0 {
                    command.push(' ');
                }
                quote_arg(a, &mut command);
            }
            let mut command = wide(&command);
            let mut env: Vec<u16> = Vec::new();
            for (k, v) in std::env::vars() {
                env.extend(format!("{k}={v}").encode_utf16());
                env.push(0);
            }
            env.push(0);
            let cwd = opts.cwd.as_deref().map(wide);
            let mut pi = ProcessInformation { process: 0, thread: 0, pid: 0, tid: 0 };
            if CreateProcessW(
                std::ptr::null(),
                command.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                env.as_ptr().cast(),
                cwd.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
                &si,
                &mut pi,
            ) == 0
            {
                ClosePseudoConsole(pc);
                return Err(format!("CreateProcess failed for {}: {}", opts.file, std::io::Error::last_os_error()));
            }
            CloseHandle(pi.thread);
            send(&json::obj([("pid", pi.pid.into())]).to_string());

            let output = std::thread::spawn(move || {
                let _ = std::io::copy(&mut Pipe(out_read), &mut std::io::stdout().lock());
            });
            std::thread::spawn(move || {
                let _ = std::io::copy(&mut std::io::stdin().lock(), &mut Pipe(in_write));
            });
            let pc_shared = Arc::new(AtomicIsize::new(pc));
            let process = pi.process;
            if let Some(ctrl) = ctrl {
                let pc_shared = pc_shared.clone();
                std::thread::spawn(move || {
                    let mut pipe = Pipe(ctrl);
                    let (mut buf, mut chunk) = (Vec::new(), [0u8; 4096]);
                    loop {
                        let n = pipe.read(&mut chunk).unwrap_or(0);
                        if n == 0 {
                            TerminateProcess(process, 1);
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        for line in take_lines(&mut buf) {
                            match parse_command(&line) {
                                Some(Command::Resize(c, r)) => {
                                    ResizePseudoConsole(pc_shared.load(Ordering::SeqCst), Coord { x: c as i16, y: r as i16 });
                                }
                                Some(Command::Kill(_)) => {
                                    TerminateProcess(process, 1);
                                }
                                None => {}
                            }
                        }
                    }
                });
            }
            WaitForSingleObject(process, u32::MAX);
            let mut code = 0u32;
            GetExitCodeProcess(process, &mut code);
            ClosePseudoConsole(pc);
            let _ = output.join();
            CloseHandle(process);
            send(&exit_message(code as i64, None));
            Ok(0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_options_and_commands() {
        let args: Vec<String> = ["--cols", "100", "--rows", "30", "--cwd", "/tmp", "--", "sh", "-c", "echo"]
            .map(String::from)
            .to_vec();
        let o = parse_args(&args).unwrap();
        assert_eq!((o.cols, o.rows, o.file.as_str(), o.args.len()), (100, 30, "sh", 2));
        assert!(matches!(parse_command(r#"{"resize":[120,40]}"#), Some(Command::Resize(120, 40))));
        assert!(matches!(parse_command(r#"{"kill":"SIGINT"}"#), Some(Command::Kill(Some(_)))));
        let mut buf = b"a\nb\nc".to_vec();
        assert_eq!(take_lines(&mut buf), vec!["a", "b"]);
        assert_eq!(buf, b"c");
    }
}
