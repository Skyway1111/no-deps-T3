use std::io::{self, BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::json::Json;

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
}

impl ServerConfig {
    pub fn new(program: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            program: program.into(),
            args,
            cwd: None,
            env: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerEndpoint {
    pub http_base_url: String,
    pub ws_base_url: String,
    pub bootstrap_token: Option<String>,
}

#[derive(Default)]
struct SharedState {
    endpoint: Option<ServerEndpoint>,
    exited: bool,
    exit_code: Option<i32>,
}

/// Supervises a local `t3` backend process, captures its listening URL/token,
/// and performs graceful shutdown (`SIGTERM` with `SIGKILL` fallback).
pub struct ServerSupervisor {
    child: Mutex<Option<Child>>,
    state: Arc<(Mutex<SharedState>, Condvar)>,
    readers: Mutex<Vec<thread::JoinHandle<()>>>,
}

impl ServerSupervisor {
    pub fn spawn(config: &ServerConfig) -> io::Result<Self> {
        let mut cmd = Command::new(&config.program);
        cmd.args(&config.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &config.cwd {
            cmd.current_dir(cwd);
        }
        for (k, v) in &config.env {
            cmd.env(k, v);
        }

        let mut child = cmd.spawn()?;
        let state = Arc::new((Mutex::new(SharedState::default()), Condvar::new()));
        let mut readers = Vec::new();

        if let Some(stdout) = child.stdout.take() {
            readers.push(spawn_log_reader("t3-server-stdout", stdout, Arc::clone(&state)));
        }
        if let Some(stderr) = child.stderr.take() {
            readers.push(spawn_log_reader("t3-server-stderr", stderr, Arc::clone(&state)));
        }

        Ok(Self {
            child: Mutex::new(Some(child)),
            state,
            readers: Mutex::new(readers),
        })
    }

    pub fn endpoint(&self) -> Option<ServerEndpoint> {
        let (lock, _) = &*self.state;
        lock.lock().unwrap_or_else(|e| e.into_inner()).endpoint.clone()
    }

    pub fn wait_ready(&self, timeout: Duration) -> io::Result<ServerEndpoint> {
        let deadline = Instant::now() + timeout;
        let (lock, cvar) = &*self.state;
        let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(endpoint) = guard.endpoint.clone() {
                return Ok(endpoint);
            }
            if guard.exited {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    format!(
                        "t3 backend exited before announcing a listening URL (code: {:?})",
                        guard.exit_code
                    ),
                ));
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "timed out waiting for t3 backend listening URL",
                ));
            }
            let remaining = deadline.saturating_duration_since(now).min(Duration::from_millis(50));
            let (next_guard, _) = cvar
                .wait_timeout(guard, remaining)
                .unwrap_or_else(|e| e.into_inner());
            guard = next_guard;

            if guard.endpoint.is_none() {
                // `is_running` takes this lock itself when it records an exit.
                drop(guard);
                let running = self.is_running();
                guard = lock.lock().unwrap_or_else(|e| e.into_inner());
                guard.exited |= !running;
            }
        }
    }

    pub fn is_running(&self) -> bool {
        let mut child_guard = self.child.lock().unwrap_or_else(|e| e.into_inner());
        let Some(child) = child_guard.as_mut() else {
            return false;
        };
        match child.try_wait() {
            Ok(None) => true,
            Ok(Some(status)) => {
                let (lock, cvar) = &*self.state;
                let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
                state.exited = true;
                state.exit_code = status.code();
                cvar.notify_all();
                false
            }
            Err(_) => false,
        }
    }

    pub fn shutdown(&self, grace: Duration) {
        let mut child_guard = self.child.lock().unwrap_or_else(|e| e.into_inner());
        let Some(mut child) = child_guard.take() else {
            return;
        };

        #[cfg(unix)]
        {
            extern "C" {
                fn kill(pid: i32, sig: i32) -> i32;
            }
            const SIGTERM: i32 = 15;
            let pid = child.id() as i32;
            if pid > 0 {
                unsafe {
                    kill(pid, SIGTERM);
                }
            }
        }

        let deadline = Instant::now() + grace;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(20));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
        }

        let (lock, cvar) = &*self.state;
        {
            let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
            state.exited = true;
        }
        cvar.notify_all();

        let mut readers = self.readers.lock().unwrap_or_else(|e| e.into_inner());
        for handle in readers.drain(..) {
            let _ = handle.join();
        }
    }
}

impl Drop for ServerSupervisor {
    fn drop(&mut self) {
        self.shutdown(Duration::from_secs(2));
    }
}

fn spawn_log_reader<R: io::Read + Send + 'static>(
    name: &str,
    stream: R,
    state: Arc<(Mutex<SharedState>, Condvar)>,
) -> thread::JoinHandle<()> {
    thread::Builder::new()
        .name(name.to_string())
        .spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(endpoint) = parse_endpoint_from_line(&line) {
                    let (lock, cvar) = &*state;
                    let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
                    if guard.endpoint.is_none() {
                        guard.endpoint = Some(endpoint);
                        cvar.notify_all();
                    }
                }
            }
        })
        .expect("failed to spawn server reader thread")
}

pub fn parse_endpoint_from_line(line: &str) -> Option<ServerEndpoint> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    // 1. Structured JSON bootstrap line: {"httpBaseUrl": "...", "wsBaseUrl": "...", "bootstrapToken": "..."}
    if trimmed.starts_with('{') {
        if let Ok(parsed) = Json::parse(trimmed) {
            if let Some(http) = parsed
                .get("httpBaseUrl")
                .or_else(|| parsed.get("http_base_url"))
                .or_else(|| parsed.get("url"))
                .and_then(Json::as_str)
            {
                let ws = parsed
                    .get("wsBaseUrl")
                    .or_else(|| parsed.get("ws_base_url"))
                    .and_then(Json::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| http_to_ws(http));
                let token = parsed
                    .get("bootstrapToken")
                    .or_else(|| parsed.get("bootstrap_token"))
                    .or_else(|| parsed.get("token"))
                    .and_then(Json::as_str)
                    .map(ToOwned::to_owned);
                return Some(ServerEndpoint {
                    http_base_url: http.trim_end_matches('/').to_string(),
                    ws_base_url: ws.trim_end_matches('/').to_string(),
                    bootstrap_token: token,
                });
            }
        }
    }

    // 2. Plain HTTP(S) URL embedded in server startup log output.
    for scheme in ["http://", "https://"] {
        if let Some(idx) = trimmed.find(scheme) {
            let candidate = &trimmed[idx..];
            let end = candidate
                .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ')' | ']' | ',' | ';'))
                .unwrap_or(candidate.len());
            let url = candidate[..end].trim_end_matches('/');
            if url.len() > scheme.len() && url[scheme.len()..].contains(':') {
                return Some(ServerEndpoint {
                    http_base_url: url.to_string(),
                    ws_base_url: http_to_ws(url),
                    bootstrap_token: None,
                });
            }
        }
    }

    None
}

fn http_to_ws(http_url: &str) -> String {
    if let Some(rest) = http_url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = http_url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        http_url.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_and_json_server_lines() {
        let plain = parse_endpoint_from_line("T3 server listening on http://127.0.0.1:3773/ ready")
            .expect("should parse http url");
        assert_eq!(plain.http_base_url, "http://127.0.0.1:3773");
        assert_eq!(plain.ws_base_url, "ws://127.0.0.1:3773");
        assert_eq!(plain.bootstrap_token, None);

        let json = parse_endpoint_from_line(
            r#"{"httpBaseUrl":"http://127.0.0.1:4123","wsBaseUrl":"ws://127.0.0.1:4123","bootstrapToken":"tok_abc"}"#,
        )
        .expect("should parse json bootstrap");
        assert_eq!(json.http_base_url, "http://127.0.0.1:4123");
        assert_eq!(json.ws_base_url, "ws://127.0.0.1:4123");
        assert_eq!(json.bootstrap_token.as_deref(), Some("tok_abc"));
    }

    #[cfg(unix)]
    #[test]
    fn supervisor_spawns_captures_endpoint_and_shuts_down() {
        let cfg = ServerConfig::new(
            "/bin/sh",
            vec![
                "-c".to_string(),
                r#"echo '{"httpBaseUrl":"http://127.0.0.1:39123","bootstrapToken":"secret"}'; exec sleep 30"#.to_string(),
            ],
        );
        let sup = ServerSupervisor::spawn(&cfg).expect("spawn should succeed");
        let ep = sup
            .wait_ready(Duration::from_secs(3))
            .expect("should capture endpoint");
        assert_eq!(ep.http_base_url, "http://127.0.0.1:39123");
        assert_eq!(ep.ws_base_url, "ws://127.0.0.1:39123");
        assert_eq!(ep.bootstrap_token.as_deref(), Some("secret"));
        assert!(sup.is_running());

        sup.shutdown(Duration::from_secs(2));
        assert!(!sup.is_running());
    }

    #[cfg(unix)]
    #[test]
    fn wait_ready_returns_when_the_backend_exits_early() {
        let sup = Arc::new(ServerSupervisor::spawn(&ServerConfig::new("/bin/sh", vec!["-c".into(), "exit 3".into()])).expect("spawn"));
        let (tx, rx) = std::sync::mpsc::channel();
        let waiter = Arc::clone(&sup);
        thread::spawn(move || {
            let _ = tx.send(waiter.wait_ready(Duration::from_secs(10)).map_err(|e| e.kind()));
        });
        let result = rx.recv_timeout(Duration::from_secs(3)).expect("wait_ready deadlocked");
        assert_eq!(result, Err(io::ErrorKind::BrokenPipe));
    }
}
