use std::env;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use t3_desktop::ipc::APP_VERSION;
use t3_desktop::json::Json;
use t3_desktop::lock::{SingleInstanceAcquire, SingleInstanceLock};
use t3_desktop::platform::{self, WindowConfig};
use t3_desktop::server::{ServerConfig, ServerEndpoint, ServerSupervisor};

struct CliOptions {
    url: Option<String>,
    state_dir: PathBuf,
    server_cmd: Option<Vec<String>>,
    title: String,
    icon_path: Option<String>,
    width: i32,
    height: i32,
    devtools: bool,
    show_version: bool,
    show_help: bool,
}

fn default_state_dir() -> PathBuf {
    if let Ok(dir) = env::var("T3_STATE_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Ok(xdg) = env::var("XDG_STATE_HOME") {
        if !xdg.trim().is_empty() {
            return PathBuf::from(xdg).join("no-deps-t3");
        }
    }
    if let Ok(home) = env::var("HOME") {
        return PathBuf::from(home).join(".no-deps-t3");
    }
    env::temp_dir().join("no-deps-t3")
}

fn default_icon_path() -> Option<String> {
    if let Ok(home) = env::var("HOME") {
        let p = PathBuf::from(home).join(".local/share/icons/no-deps-t3.png");
        if p.exists() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    None
}

fn parse_args(args: &[String]) -> Result<CliOptions, String> {
    let mut opts = CliOptions {
        url: None,
        state_dir: default_state_dir(),
        server_cmd: None,
        title: "no-deps-T3".to_string(),
        icon_path: default_icon_path(),
        width: 1400,
        height: 900,
        devtools: env::var("T3_DEVTOOLS").is_ok_and(|v| v == "1" || v == "true"),
        show_version: false,
        show_help: false,
    };

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--version" | "-v" => opts.show_version = true,
            "--help" | "-h" => opts.show_help = true,
            "--devtools" => opts.devtools = true,
            "--url" => {
                i += 1;
                opts.url = Some(args.get(i).ok_or("--url requires a value")?.clone());
            }
            "--state-dir" => {
                i += 1;
                opts.state_dir = PathBuf::from(args.get(i).ok_or("--state-dir requires a value")?);
            }
            "--title" => {
                i += 1;
                opts.title = args.get(i).ok_or("--title requires a value")?.clone();
            }
            "--icon" => {
                i += 1;
                opts.icon_path = Some(args.get(i).ok_or("--icon requires a value")?.clone());
            }
            "--width" => {
                i += 1;
                opts.width = args
                    .get(i)
                    .ok_or("--width requires a value")?
                    .parse::<i32>()
                    .map_err(|_| "--width must be an integer")?;
            }
            "--height" => {
                i += 1;
                opts.height = args
                    .get(i)
                    .ok_or("--height requires a value")?
                    .parse::<i32>()
                    .map_err(|_| "--height must be an integer")?;
            }
            "--server-cmd" => {
                i += 1;
                let cmd = args.get(i).ok_or("--server-cmd requires a command")?;
                let parts: Vec<String> = cmd.split_whitespace().map(ToOwned::to_owned).collect();
                if parts.is_empty() {
                    return Err("--server-cmd cannot be empty".to_string());
                }
                opts.server_cmd = Some(parts);
            }
            _ => {}
        }
        i += 1;
    }
    Ok(opts)
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    let opts = match parse_args(&args) {
        Ok(o) => o,
        Err(err) => {
            eprintln!("error: {err}");
            return ExitCode::from(2);
        }
    };

    if opts.show_version {
        println!("{APP_VERSION}");
        return ExitCode::SUCCESS;
    }
    if opts.show_help {
        println!(
            "t3-desktop {APP_VERSION}\n\
             Usage: t3-desktop [--url URL] [--state-dir DIR] [--server-cmd \"CMD ARGS\"] \
             [--title TITLE] [--width PX] [--height PX] [--devtools] [--version]"
        );
        return ExitCode::SUCCESS;
    }

    let _single_instance = match SingleInstanceLock::acquire(&opts.state_dir, &args, |forwarded| {
        #[cfg(target_os = "linux")]
        {
            platform::linux::reveal_window_from_any_thread();
            for arg in forwarded.iter().skip(1) {
                if arg.starts_with("t3code://") || arg.starts_with("https://") || arg.starts_with("http://") {
                    platform::linux::emit_event_from_any_thread("desktop:web-link-open", &Json::from(arg.as_str()));
                }
            }
        }
        #[cfg(not(target_os = "linux"))]
        let _ = forwarded;
    }) {
        Ok(SingleInstanceAcquire::Primary(lock)) => lock,
        Ok(SingleInstanceAcquire::SecondaryForwarded) => return ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("failed to acquire single-instance lock: {err}");
            return ExitCode::FAILURE;
        }
    };

    let mut supervisor: Option<ServerSupervisor> = None;
    let mut local_endpoint: Option<ServerEndpoint> = None;

    if let Some(cmd_parts) = opts.server_cmd {
        let cfg = ServerConfig::new(cmd_parts[0].clone(), cmd_parts[1..].to_vec());
        match ServerSupervisor::spawn(&cfg) {
            Ok(sup) => match sup.wait_ready(Duration::from_secs(15)) {
                Ok(ep) => {
                    local_endpoint = Some(ep);
                    supervisor = Some(sup);
                }
                Err(err) => {
                    eprintln!("local t3 backend failed to become ready: {err}");
                    sup.shutdown(Duration::from_secs(2));
                    return ExitCode::FAILURE;
                }
            },
            Err(err) => {
                eprintln!("failed to spawn local t3 backend: {err}");
                return ExitCode::FAILURE;
            }
        }
    }

    let target_url = opts
        .url
        .or_else(|| local_endpoint.as_ref().map(|e| e.http_base_url.clone()))
        .unwrap_or_else(|| "http://127.0.0.1:3773".to_string());

    if local_endpoint.is_none() && target_url.starts_with("http") {
        let ws = if let Some(rest) = target_url.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = target_url.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            target_url.clone()
        };
        local_endpoint = Some(ServerEndpoint {
            http_base_url: target_url.trim_end_matches('/').to_string(),
            ws_base_url: ws.trim_end_matches('/').to_string(),
            bootstrap_token: None,
        });
    }

    let window = WindowConfig {
        title: opts.title,
        url: target_url,
        icon_path: opts.icon_path,
        width: opts.width,
        height: opts.height,
        devtools: opts.devtools,
    };

    let result = platform::run_app(window, &opts.state_dir, local_endpoint);

    if let Some(sup) = supervisor {
        sup.shutdown(Duration::from_secs(3));
    }

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("t3-desktop error: {err}");
            ExitCode::FAILURE
        }
    }
}
