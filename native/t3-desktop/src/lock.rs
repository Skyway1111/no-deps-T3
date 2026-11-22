use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use crate::json::Json;

#[cfg(unix)]
mod unix_flock {
    use std::ffi::c_int;
    use std::fs::File;
    use std::io;
    use std::os::unix::io::AsRawFd;

    pub const LOCK_SH: c_int = 1;
    pub const LOCK_EX: c_int = 2;
    pub const LOCK_NB: c_int = 4;
    pub const LOCK_UN: c_int = 8;

    extern "C" {
        fn flock(fd: c_int, operation: c_int) -> c_int;
    }

    pub fn apply(file: &File, op: c_int) -> io::Result<()> {
        let rc = unsafe { flock(file.as_raw_fd(), op) };
        if rc == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

/// Advisory file lock backed by POSIX `flock(2)`.
///
/// Unlike polling-based `proper-lockfile` implementations, the kernel releases
/// the lock automatically if the owning process crashes or exits unexpectedly.
pub struct FileLock {
    file: File,
    path: PathBuf,
}

impl FileLock {
    pub fn try_lock_exclusive(path: impl AsRef<Path>) -> io::Result<Option<Self>> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;

        #[cfg(unix)]
        {
            match unix_flock::apply(&file, unix_flock::LOCK_EX | unix_flock::LOCK_NB) {
                Ok(()) => Ok(Some(Self { file, path })),
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => Ok(None),
                Err(err) => Err(err),
            }
        }
        #[cfg(not(unix))]
        {
            Ok(Some(Self { file, path }))
        }
    }

    pub fn lock_exclusive(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;

        #[cfg(unix)]
        unix_flock::apply(&file, unix_flock::LOCK_EX)?;

        Ok(Self { file, path })
    }

    pub fn try_lock_shared(path: impl AsRef<Path>) -> io::Result<Option<Self>> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;

        #[cfg(unix)]
        {
            match unix_flock::apply(&file, unix_flock::LOCK_SH | unix_flock::LOCK_NB) {
                Ok(()) => Ok(Some(Self { file, path })),
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => Ok(None),
                Err(err) => Err(err),
            }
        }
        #[cfg(not(unix))]
        {
            Ok(Some(Self { file, path }))
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        let _ = unix_flock::apply(&self.file, unix_flock::LOCK_UN);
    }
}

pub enum SingleInstanceAcquire {
    Primary(SingleInstanceLock),
    SecondaryForwarded,
}

/// Process-wide single-instance lock with Unix domain socket argv forwarding.
pub struct SingleInstanceLock {
    _file_lock: FileLock,
    socket_path: PathBuf,
    shutdown: Arc<AtomicBool>,
    listener_thread: Option<thread::JoinHandle<()>>,
}

fn resolve_socket_path(state_dir: &Path) -> PathBuf {
    const MAX_UNIX_SOCKET_BYTES: usize = 100;
    let direct = state_dir.join("t3-desktop.sock");
    if direct.as_os_str().len() <= MAX_UNIX_SOCKET_BYTES {
        return direct;
    }

    // Derive a short, deterministic socket path within SUN_LEN using FNV-1a.
    let canonical = fs::canonicalize(state_dir).unwrap_or_else(|_| state_dir.to_path_buf());
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in canonical.as_os_str().as_encoded_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }

    let file_name = format!("t3-{hash:016x}.sock");
    if let Ok(runtime_dir) = std::env::var("XDG_RUNTIME_DIR") {
        let candidate = PathBuf::from(runtime_dir).join(&file_name);
        if candidate.as_os_str().len() <= MAX_UNIX_SOCKET_BYTES {
            return candidate;
        }
    }
    PathBuf::from("/tmp").join(file_name)
}

impl SingleInstanceLock {
    pub fn acquire<F>(
        state_dir: impl AsRef<Path>,
        argv: &[String],
        on_second_instance: F,
    ) -> io::Result<SingleInstanceAcquire>
    where
        F: Fn(Vec<String>) + Send + Sync + 'static,
    {
        let state_dir = state_dir.as_ref();
        fs::create_dir_all(state_dir)?;
        let lock_path = state_dir.join("t3-desktop.lock");
        let socket_path = resolve_socket_path(state_dir);

        match FileLock::try_lock_exclusive(&lock_path)? {
            Some(mut file_lock) => {
                let _ = file_lock.file.set_len(0);
                let _ = writeln!(file_lock.file, "{}", std::process::id());
                let _ = file_lock.file.flush();

                let shutdown = Arc::new(AtomicBool::new(false));
                let listener_thread = start_socket_listener(
                    &socket_path,
                    Arc::clone(&shutdown),
                    Arc::new(on_second_instance),
                )?;

                Ok(SingleInstanceAcquire::Primary(Self {
                    _file_lock: file_lock,
                    socket_path,
                    shutdown,
                    listener_thread,
                }))
            }
            None => {
                forward_to_primary(&socket_path, argv)?;
                Ok(SingleInstanceAcquire::SecondaryForwarded)
            }
        }
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }
}

impl Drop for SingleInstanceLock {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        #[cfg(unix)]
        {
            // Wake the blocking accept() loop cleanly.
            let _ = std::os::unix::net::UnixStream::connect(&self.socket_path);
        }
        if let Some(handle) = self.listener_thread.take() {
            let _ = handle.join();
        }
        let _ = fs::remove_file(&self.socket_path);
    }
}

#[cfg(unix)]
fn start_socket_listener(
    socket_path: &Path,
    shutdown: Arc<AtomicBool>,
    callback: Arc<dyn Fn(Vec<String>) + Send + Sync>,
) -> io::Result<Option<thread::JoinHandle<()>>> {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    if socket_path.exists() {
        let _ = fs::remove_file(socket_path);
    }
    let listener = UnixListener::bind(socket_path)?;
    let _ = fs::set_permissions(socket_path, fs::Permissions::from_mode(0o600));

    let handle = thread::Builder::new()
        .name("t3-single-instance".to_string())
        .spawn(move || {
            for stream in listener.incoming() {
                if shutdown.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(mut stream) = stream else {
                    continue;
                };
                let mut payload = String::new();
                if stream.read_to_string(&mut payload).is_ok() && !payload.trim().is_empty() {
                    if let Ok(parsed) = Json::parse(&payload) {
                        let args = parsed
                            .get("argv")
                            .and_then(Json::as_array)
                            .map(|items| {
                                items
                                    .iter()
                                    .filter_map(Json::as_str)
                                    .map(ToOwned::to_owned)
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default();
                        callback(args);
                    }
                }
            }
        })?;
    Ok(Some(handle))
}

#[cfg(not(unix))]
fn start_socket_listener(
    _socket_path: &Path,
    _shutdown: Arc<AtomicBool>,
    _callback: Arc<dyn Fn(Vec<String>) + Send + Sync>,
) -> io::Result<Option<thread::JoinHandle<()>>> {
    Ok(None)
}

#[cfg(unix)]
fn forward_to_primary(socket_path: &Path, argv: &[String]) -> io::Result<()> {
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    let mut last_err = None;
    for _ in 0..10 {
        match UnixStream::connect(socket_path) {
            Ok(mut stream) => {
                let payload = Json::object([("argv", Json::from(argv.to_vec()))]);
                stream.write_all(payload.to_json_string().as_bytes())?;
                stream.flush()?;
                return Ok(());
            }
            Err(err) => {
                last_err = Some(err);
                thread::sleep(Duration::from_millis(25));
            }
        }
    }
    Err(last_err.unwrap_or_else(|| io::Error::other("failed to connect to primary instance")))
}

#[cfg(not(unix))]
fn forward_to_primary(_socket_path: &Path, _argv: &[String]) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn advisory_flock_blocks_second_exclusive_holder() {
        let dir = temp_dir("t3-flock");
        let lock_file = dir.join("test.lock");

        let guard = FileLock::try_lock_exclusive(&lock_file)
            .expect("first lock should succeed")
            .expect("lock should be acquired");
        assert!(FileLock::try_lock_exclusive(&lock_file)
            .expect("second try_lock should not error")
            .is_none());

        drop(guard);

        let reacquired = FileLock::try_lock_exclusive(&lock_file)
            .expect("reacquire should succeed")
            .expect("lock should be free after drop");
        drop(reacquired);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn single_instance_forwards_argv_over_unix_socket() {
        let dir = temp_dir("t3-single");
        let (tx, rx) = mpsc::channel();

        let primary = match SingleInstanceLock::acquire(&dir, &[], move |args| {
            let _ = tx.send(args);
        })
        .expect("primary acquire should succeed")
        {
            SingleInstanceAcquire::Primary(lock) => lock,
            SingleInstanceAcquire::SecondaryForwarded => panic!("expected primary"),
        };

        let forwarded_args = vec![
            "t3-desktop".to_string(),
            "t3code://open?thread=123".to_string(),
        ];
        let second = SingleInstanceLock::acquire(&dir, &forwarded_args, |_| {})
            .expect("secondary acquire should forward");
        assert!(matches!(second, SingleInstanceAcquire::SecondaryForwarded));

        let received = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("primary should receive forwarded argv");
        assert_eq!(received, forwarded_args);

        drop(primary);
        let _ = fs::remove_dir_all(&dir);
    }
}
