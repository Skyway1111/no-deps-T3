#![cfg(target_os = "windows")]

use std::io;
use std::path::Path;
use std::process::Command;

use crate::platform::{ColorScheme, DesktopPlatform, WindowConfig};
use crate::server::ServerEndpoint;

/// Windows native shell backed by Win32 + WebView2 (`ICoreWebView2Controller`,
/// `window.chrome.webview.postMessage`, `IFileOpenDialog`, `ShellExecuteW`).
pub struct WindowsPlatform;

impl WindowsPlatform {
    pub fn detect_color_scheme() -> ColorScheme {
        let output = Command::new("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
                "/v",
                "AppsUseLightTheme",
            ])
            .output();
        match output {
            Ok(out) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout);
                if text.contains("0x0") {
                    ColorScheme::Dark
                } else {
                    ColorScheme::Light
                }
            }
            _ => ColorScheme::Light,
        }
    }

    pub fn open_external(url: &str) -> bool {
        Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
            .is_ok()
    }
}

impl DesktopPlatform for WindowsPlatform {
    fn run(
        window: WindowConfig,
        _state_dir: &Path,
        _local_endpoint: Option<ServerEndpoint>,
    ) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!(
                "Windows WebView2 COM host wiring pending native Windows build verification for `{}`",
                window.title
            ),
        ))
    }
}
