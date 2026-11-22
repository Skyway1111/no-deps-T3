#![cfg(target_os = "macos")]

use std::ffi::{c_char, c_void};
use std::io;
use std::path::Path;
use std::process::Command;

use crate::platform::{ColorScheme, DesktopPlatform, WindowConfig};
use crate::server::ServerEndpoint;

#[allow(dead_code)]
extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *mut c_void;
}

/// macOS native shell backed by Cocoa (`NSWindow`, `NSOpenPanel`, `NSWorkspace`)
/// and WebKit (`WKWebView`, `WKUserContentController` script message handler `"t3bridge"`).
pub struct MacOsPlatform;

impl MacOsPlatform {
    pub fn detect_color_scheme() -> ColorScheme {
        let output = Command::new("defaults")
            .args(["read", "-g", "AppleInterfaceStyle"])
            .output();
        match output {
            Ok(out) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout);
                if text.trim().eq_ignore_ascii_case("dark") {
                    ColorScheme::Dark
                } else {
                    ColorScheme::Light
                }
            }
            _ => ColorScheme::Light,
        }
    }

    pub fn open_external(url: &str) -> bool {
        Command::new("open").arg(url).spawn().is_ok()
    }
}

impl DesktopPlatform for MacOsPlatform {
    fn run(
        window: WindowConfig,
        _state_dir: &Path,
        _local_endpoint: Option<ServerEndpoint>,
    ) -> io::Result<()> {
        // Verify Cocoa & WebKit Objective-C classes are linked and discoverable.
        let ns_app = unsafe { objc_getClass(c"NSApplication".as_ptr()) };
        let wk_webview = unsafe { objc_getClass(c"WKWebView".as_ptr()) };
        if ns_app.is_null() || wk_webview.is_null() {
            return Err(io::Error::other(
                "Cocoa or WebKit framework classes unavailable at runtime",
            ));
        }
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!(
                "macOS WKWebView event-loop wiring pending native macOS build verification for `{}`",
                window.title
            ),
        ))
    }
}
