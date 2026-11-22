use std::io;
use std::path::Path;

use crate::json::Json;
use crate::server::ServerEndpoint;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorScheme {
    Light,
    Dark,
}

impl ColorScheme {
    pub fn as_str(self) -> &'static str {
        match self {
            ColorScheme::Light => "light",
            ColorScheme::Dark => "dark",
        }
    }
}

#[derive(Debug, Clone)]
pub struct WindowConfig {
    pub title: String,
    pub url: String,
    pub icon_path: Option<String>,
    pub width: i32,
    pub height: i32,
    pub devtools: bool,
}

impl Default for WindowConfig {
    fn default() -> Self {
        Self {
            title: "no-deps-T3".to_string(),
            url: "http://127.0.0.1:3773".to_string(),
            icon_path: None,
            width: 1400,
            height: 900,
            devtools: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct FileDialogOptions {
    pub title: String,
    pub initial_path: Option<String>,
    pub multiple: bool,
}

#[derive(Debug, Clone)]
pub struct PreviewTabSnapshot {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub zoom_factor: f64,
    pub color_scheme: String,
    pub audio_muted: bool,
}

impl PreviewTabSnapshot {
    pub fn to_json(&self) -> Json {
        let nav_status = if self.url.is_empty() {
            Json::object([("kind", Json::from("Idle"))])
        } else {
            Json::object([
                ("kind", Json::from("Success")),
                ("url", Json::from(self.url.clone())),
                ("title", Json::from(self.title.clone())),
            ])
        };
        Json::object([
            ("tabId", Json::from(self.tab_id.clone())),
            ("webContentsId", Json::Null),
            ("navStatus", nav_status),
            ("canGoBack", Json::Bool(self.can_go_back)),
            ("canGoForward", Json::Bool(self.can_go_forward)),
            ("zoomFactor", Json::from(self.zoom_factor)),
            ("pictureInPicture", Json::Bool(false)),
            ("colorScheme", Json::from(self.color_scheme.clone())),
            ("audioMuted", Json::Bool(self.audio_muted)),
            ("audible", Json::Bool(false)),
            ("controller", Json::from("human")),
            ("capturing", Json::Bool(false)),
            ("updatedAt", Json::from("1970-01-01T00:00:00.000Z")),
        ])
    }
}

/// Cross-platform native desktop WebView host contract.
pub trait DesktopPlatform {
    fn run(
        window: WindowConfig,
        state_dir: &Path,
        local_endpoint: Option<ServerEndpoint>,
    ) -> io::Result<()>;
}

pub fn run_app(
    window: WindowConfig,
    state_dir: &Path,
    local_endpoint: Option<ServerEndpoint>,
) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        linux::LinuxPlatform::run(window, state_dir, local_endpoint)
    }
    #[cfg(target_os = "macos")]
    {
        macos::MacOsPlatform::run(window, state_dir, local_endpoint)
    }
    #[cfg(target_os = "windows")]
    {
        windows::WindowsPlatform::run(window, state_dir, local_endpoint)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (window, state_dir, local_endpoint);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "native desktop shell is not implemented for this OS",
        ))
    }
}
