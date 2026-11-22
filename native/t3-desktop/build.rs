use std::env;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_PATH");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_LIBDIR");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG");

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    match target_os.as_str() {
        "linux" => link_linux_webkit(),
        "macos" => link_macos_webkit(),
        "windows" => link_windows_webview2(),
        _ => {}
    }
}

fn link_linux_webkit() {
    // Interposed over GDK/libdrm for WebKit's vblank pacing; see src/platform/refresh.rs.
    for sym in [
        "drmWaitVBlank",
        "gdk_monitor_get_width_mm",
        "gdk_monitor_get_height_mm",
    ] {
        println!("cargo:rustc-link-arg-bins=-Wl,--export-dynamic-symbol={sym}");
    }
    let pkg_config = env::var("PKG_CONFIG").unwrap_or_else(|_| "pkg-config".to_string());
    let packages = ["gtk+-3.0", "webkit2gtk-4.1", "javascriptcoregtk-4.1"];

    let output = Command::new(&pkg_config)
        .arg("--libs")
        .args(packages)
        .output()
        .unwrap_or_else(|err| {
            panic!("failed to execute `{pkg_config}` for Linux WebKitGTK linking: {err}")
        });

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        panic!(
            "`{pkg_config} --libs {}` failed ({}): {}",
            packages.join(" "),
            output.status,
            stderr.trim()
        );
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for token in stdout.split_whitespace() {
        if let Some(dir) = token.strip_prefix("-L") {
            if !dir.is_empty() {
                println!("cargo:rustc-link-search=native={dir}");
            }
        } else if let Some(lib) = token.strip_prefix("-l") {
            if !lib.is_empty() {
                println!("cargo:rustc-link-lib={lib}");
            }
        }
    }
}

fn link_macos_webkit() {
    println!("cargo:rustc-link-lib=framework=Cocoa");
    println!("cargo:rustc-link-lib=framework=WebKit");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=objc");
}

fn link_windows_webview2() {
    for lib in ["user32", "shell32", "ole32", "comdlg32", "advapi32"] {
        println!("cargo:rustc-link-lib={lib}");
    }
}
