use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::json::{escape_json_string, Json};
use crate::platform::{ColorScheme, FileDialogOptions, PreviewTabSnapshot};
use crate::server::ServerEndpoint;
use crate::store::AtomicJsonStore;

pub const APP_BASE_NAME: &str = "no-deps-T3";
pub const APP_STAGE_LABEL: &str = "Zero-Dep";
pub const APP_DISPLAY_NAME: &str = "no-deps-T3";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Platform capabilities invoked by `IpcDispatcher`.
///
/// Implemented by the real OS WebView host (`platform::linux::LinuxHost`, etc.)
/// and by mock hosts in unit tests.
pub trait HostActions: Send + Sync {
    fn pick_folder(&self, options: FileDialogOptions) -> Option<String>;
    fn pick_file(&self, options: FileDialogOptions) -> Vec<String>;
    fn open_external(&self, url: &str) -> bool;
    fn reveal_window(&self);
    fn set_theme(&self, theme: &str);
    fn get_color_scheme(&self) -> ColorScheme;
    fn get_primary_paste_enabled(&self) -> bool;
    fn get_window_fullscreen(&self) -> bool;
    fn set_html_fullscreen(&self, fullscreen: bool);
    fn get_zoom_factor(&self) -> f64;
    fn set_notification_badge(&self, count: i64);

    fn preview_create_tab(&self, tab_id: &str, zoom_factor: Option<f64>, color_scheme: Option<&str>);
    fn preview_close_tab(&self, tab_id: &str);
    fn preview_navigate(&self, tab_id: &str, url: &str);
    fn preview_go_back(&self, tab_id: &str);
    fn preview_go_forward(&self, tab_id: &str);
    fn preview_refresh(&self, tab_id: &str, bypass_cache: bool);
    fn preview_stop_loading(&self, tab_id: &str);
    fn preview_set_zoom(&self, tab_id: &str, zoom_factor: f64);
    fn preview_get_zoom(&self, tab_id: &str) -> f64;
    fn preview_set_muted(&self, tab_id: &str, muted: bool);
    fn preview_set_color_scheme(&self, tab_id: &str, color_scheme: &str);
    fn preview_set_shown(&self, tab_id: &str, shown: bool);
    fn preview_find_in_page(&self, tab_id: &str, text: &str, forward: bool, new_session: bool);
    fn preview_stop_find_in_page(&self, tab_id: &str);
    fn preview_open_devtools(&self, tab_id: &str);
    fn preview_tab_snapshot(&self, tab_id: &str) -> Option<PreviewTabSnapshot>;
}

#[derive(Debug, Clone)]
pub struct PreloadBootstrap {
    pub platform: String,
    pub branding: Json,
    pub system_locale: Option<String>,
    pub preferred_languages: Vec<String>,
    pub primary_paste_enabled: bool,
    pub local_environment_enabled: bool,
    pub local_bootstraps: Vec<Json>,
    pub fullscreen: bool,
    pub zoom_factor: f64,
    pub color_scheme: ColorScheme,
}

struct DispatcherState {
    local_environment_enabled: bool,
    local_endpoint: Option<ServerEndpoint>,
    host_environment_id: Option<String>,
    web_links_ready: bool,
    app_activation_ready: bool,
    preview_zooms: BTreeMap<String, f64>,
}

pub struct IpcDispatcher {
    settings_store: AtomicJsonStore,
    catalog_store: AtomicJsonStore,
    state: Mutex<DispatcherState>,
    host: Arc<dyn HostActions>,
}

impl IpcDispatcher {
    pub fn new(
        state_dir: &Path,
        local_endpoint: Option<ServerEndpoint>,
        host: Arc<dyn HostActions>,
    ) -> Self {
        let settings_store = AtomicJsonStore::new(state_dir.join("client-settings.json"));
        let catalog_store = AtomicJsonStore::new(state_dir.join("connection-catalog.json"));
        Self {
            settings_store,
            catalog_store,
            state: Mutex::new(DispatcherState {
                local_environment_enabled: true,
                local_endpoint,
                host_environment_id: Some("primary".to_string()),
                web_links_ready: false,
                app_activation_ready: false,
                preview_zooms: BTreeMap::new(),
            }),
            host,
        }
    }

    pub fn set_local_endpoint(&self, endpoint: Option<ServerEndpoint>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.local_endpoint = endpoint;
    }

    pub fn preload_bootstrap(&self) -> PreloadBootstrap {
        let locale = detect_system_locale();
        let preferred = detect_preferred_languages(locale.as_deref());
        let (local_enabled, local_bootstraps) = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            (
                state.local_environment_enabled,
                build_local_bootstraps(state.local_endpoint.as_ref()),
            )
        };
        PreloadBootstrap {
            platform: node_platform_name().to_string(),
            branding: app_branding_json(),
            system_locale: locale,
            preferred_languages: preferred,
            primary_paste_enabled: self.host.get_primary_paste_enabled(),
            local_environment_enabled: local_enabled,
            local_bootstraps,
            fullscreen: self.host.get_window_fullscreen(),
            zoom_factor: self.host.get_zoom_factor(),
            color_scheme: self.host.get_color_scheme(),
        }
    }

    /// Handles a raw JSON-RPC message `{"id": 1, "method": "...", "params": ...}`
    /// and returns `(id, ok, result_or_error_json)`.
    pub fn handle_raw_message(&self, raw: &str) -> (u64, bool, Json) {
        let parsed = match Json::parse(raw) {
            Ok(v) => v,
            Err(err) => {
                return (0, false, Json::from(format!("invalid IPC JSON: {err}")));
            }
        };

        let id = parsed.get("id").and_then(Json::as_u64).unwrap_or(0);
        let Some(method) = parsed.get("method").and_then(Json::as_str) else {
            return (id, false, Json::from("missing IPC method"));
        };
        let params = parsed.get("params").cloned().unwrap_or(Json::Null);

        match self.dispatch(method, params) {
            Ok(result) => (id, true, result),
            Err(message) => (id, false, Json::from(message)),
        }
    }

    pub fn dispatch(&self, method: &str, params: Json) -> Result<Json, String> {
        match method {
            // --- Identity & environment metadata ---
            "desktop:get-app-branding" | "getAppBranding" => Ok(app_branding_json()),
            "desktop:get-relay-telemetry-enabled" | "getRelayTelemetryEnabled" => Ok(Json::Bool(false)),
            "desktop:get-system-locale" | "getSystemLocale" => {
                Ok(Json::from(detect_system_locale()))
            }
            "desktop:get-preferred-system-languages" | "getPreferredSystemLanguages" => {
                let locale = detect_system_locale();
                Ok(Json::from(detect_preferred_languages(locale.as_deref())))
            }
            "desktop:get-primary-paste-enabled" | "getPrimaryPasteEnabled" => {
                Ok(Json::Bool(self.host.get_primary_paste_enabled()))
            }
            "desktop:get-local-environment-bootstraps" | "getLocalEnvironmentBootstraps" => {
                let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                Ok(Json::Array(build_local_bootstraps(
                    state.local_endpoint.as_ref(),
                )))
            }
            "desktop:get-local-environment-enabled" | "getLocalEnvironmentEnabled" => {
                let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                Ok(Json::Bool(state.local_environment_enabled))
            }
            "desktop:set-local-environment-enabled" | "setLocalEnvironmentEnabled" => {
                let enabled = params
                    .as_bool()
                    .or_else(|| params.get("enabled").and_then(Json::as_bool))
                    .unwrap_or(true);
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                state.local_environment_enabled = enabled;
                Ok(Json::Null)
            }
            "desktop:get-host-environment-id" | "getHostEnvironmentId" => {
                let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                Ok(Json::from(state.host_environment_id.clone()))
            }
            "desktop:get-local-environment-bearer-token" | "getLocalEnvironmentBearerToken" => {
                let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                let token = state
                    .local_endpoint
                    .as_ref()
                    .and_then(|e| e.bootstrap_token.clone())
                    .unwrap_or_default();
                Ok(Json::from(token))
            }

            // --- Persistent stores ---
            "desktop:get-client-settings" | "getClientSettings" => {
                match self.settings_store.load_json() {
                    Ok(Some(v)) => Ok(v),
                    Ok(None) => Ok(Json::Null),
                    Err(err) => Err(format!("failed to load client settings: {err}")),
                }
            }
            "desktop:set-client-settings" | "setClientSettings" => {
                self.settings_store
                    .save_json(&params)
                    .map_err(|err| format!("failed to save client settings: {err}"))?;
                Ok(Json::Null)
            }
            "desktop:get-connection-catalog" | "getConnectionCatalog" => {
                match self.catalog_store.get_key("catalog") {
                    Ok(Some(v)) => Ok(v),
                    Ok(None) => Ok(Json::Null),
                    Err(err) => Err(format!("failed to load connection catalog: {err}")),
                }
            }
            "desktop:set-connection-catalog" | "setConnectionCatalog" => {
                let catalog = params
                    .as_str()
                    .or_else(|| params.get("catalog").and_then(Json::as_str))
                    .ok_or_else(|| "connection catalog must be a string".to_string())?;
                self.catalog_store
                    .set_key("catalog", Json::from(catalog))
                    .map_err(|err| format!("failed to save connection catalog: {err}"))?;
                Ok(Json::Bool(true))
            }

            // --- Native dialogs & OS shell ---
            "desktop:pick-folder" | "pickFolder" => {
                let initial_path = params
                    .get("initialPath")
                    .and_then(Json::as_str)
                    .map(ToOwned::to_owned);
                let chosen = self.host.pick_folder(FileDialogOptions {
                    title: "Select Folder".to_string(),
                    initial_path,
                    multiple: false,
                });
                Ok(Json::from(chosen))
            }
            "desktop:pick-project-favicon" | "pickProjectFavicon" => {
                let initial_path = params
                    .as_str()
                    .or_else(|| params.get("initialPath").and_then(Json::as_str))
                    .map(ToOwned::to_owned);
                let chosen = self
                    .host
                    .pick_file(FileDialogOptions {
                        title: "Select Project Icon".to_string(),
                        initial_path,
                        multiple: false,
                    })
                    .into_iter()
                    .next();
                Ok(Json::from(chosen))
            }
            "desktop:pick-theme-files" | "pickThemeFiles" => {
                let paths = self.host.pick_file(FileDialogOptions {
                    title: "Select Theme Files".to_string(),
                    initial_path: None,
                    multiple: true,
                });
                if paths.is_empty() {
                    return Ok(Json::Null);
                }
                const MAX_THEME_BYTES: u64 = 1_048_576;
                let mut picked = Vec::with_capacity(paths.len());
                for path_str in paths {
                    let path = Path::new(&path_str);
                    let name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(&path_str)
                        .to_string();
                    let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                    let text = if size <= MAX_THEME_BYTES {
                        fs::read_to_string(path).unwrap_or_default()
                    } else {
                        String::new()
                    };
                    picked.push(Json::object([
                        ("name", Json::from(name)),
                        ("size", Json::from(size)),
                        ("text", Json::from(text)),
                    ]));
                }
                Ok(Json::Array(picked))
            }
            "desktop:open-external" | "openExternal" => {
                let url = params
                    .as_str()
                    .or_else(|| params.get("url").and_then(Json::as_str))
                    .ok_or_else(|| "openExternal requires a URL string".to_string())?;
                if !is_safe_external_url(url) {
                    return Ok(Json::Bool(false));
                }
                Ok(Json::Bool(self.host.open_external(url)))
            }
            "desktop:set-theme" | "setTheme" => {
                let theme = params
                    .as_str()
                    .or_else(|| params.get("theme").and_then(Json::as_str))
                    .unwrap_or("system");
                self.host.set_theme(theme);
                Ok(Json::Null)
            }
            "desktop:get-color-scheme" | "getColorScheme" => {
                Ok(Json::from(self.host.get_color_scheme().as_str()))
            }
            "desktop:reveal-window" | "revealWindow" => {
                self.host.reveal_window();
                Ok(Json::Null)
            }
            "desktop:set-notification-badge" | "setNotificationBadge" => {
                let count = params.get("count").and_then(Json::as_i64).unwrap_or(0);
                self.host.set_notification_badge(count);
                Ok(Json::Null)
            }
            "desktop:get-window-fullscreen-state" | "getWindowFullscreenState" => {
                Ok(Json::Bool(self.host.get_window_fullscreen()))
            }
            "desktop:sync-html-fullscreen" | "syncHtmlFullscreen" => {
                let active = params.as_bool().unwrap_or(false);
                self.host.set_html_fullscreen(active);
                Ok(Json::Null)
            }
            "desktop:to-local-backend-path" | "toLocalBackendPath" => {
                Ok(Json::from(params.get("path").and_then(Json::as_str)))
            }
            "desktop:context-menu" | "showContextMenu" => Ok(Json::Null),
            "desktop:open-system-settings" | "openSystemSettings" => Ok(Json::Bool(false)),
            "desktop:check-system-permission" | "checkSystemPermission" => Ok(Json::Bool(true)),
            "desktop:probe-remote-editors" | "probeRemoteEditors" => Ok(Json::Array(Vec::new())),
            "desktop:paste-as-text" | "pasteAsText" => Ok(Json::Null),
            "desktop:restart-audio-service" | "restartAudioService" => Ok(Json::Bool(false)),
            "desktop:start-file-drag" | "startFileDrag" => Ok(Json::Bool(false)),
            "desktop:read-media" | "readMedia" => Ok(Json::Null),

            // --- Status / capability defaults for Electron-only subsystems ---
            "desktop:get-server-exposure-state" | "getServerExposureState" => {
                let endpoint_url = {
                    let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    state
                        .local_endpoint
                        .as_ref()
                        .map(|e| e.http_base_url.clone())
                };
                Ok(Json::object([
                    ("mode", Json::from("local-only")),
                    ("endpointUrl", Json::from(endpoint_url)),
                    ("advertisedHost", Json::Null),
                    ("tailscaleServeEnabled", Json::Bool(false)),
                    ("tailscaleServePort", Json::from(0i64)),
                ]))
            }
            "desktop:get-advertised-endpoints" | "getAdvertisedEndpoints" => {
                Ok(Json::Array(Vec::new()))
            }
            "desktop:get-wsl-state" | "getWslState" => Ok(Json::object([
                ("enabled", Json::Bool(false)),
                ("distro", Json::Null),
                ("available", Json::Bool(false)),
                ("wslOnly", Json::Bool(false)),
                ("distros", Json::Array(Vec::new())),
                ("preflightError", Json::Null),
            ])),
            "desktop:update-get-state" | "getUpdateState" => Ok(disabled_update_state()),
            "desktop:update-check" | "checkForUpdate" => Ok(Json::object([
                ("checked", Json::Bool(false)),
                ("state", disabled_update_state()),
            ])),
            "desktop:update-download" | "downloadUpdate" | "desktop:update-install" | "installUpdate" => {
                Ok(Json::object([
                    ("accepted", Json::Bool(false)),
                    ("completed", Json::Bool(false)),
                    ("state", disabled_update_state()),
                ]))
            }
            "desktop:cli-command-get-state" | "cliCommand.getState" => Ok(Json::object([
                ("supported", Json::Bool(false)),
                ("installedPath", Json::Null),
                ("onPath", Json::Bool(false)),
                ("launcherPath", Json::Null),
            ])),
            "desktop:web-link-ready" => {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                state.web_links_ready = params.as_bool().unwrap_or(false);
                Ok(Json::Null)
            }
            "desktop:app-activation-ready" => {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                state.app_activation_ready = params.as_bool().unwrap_or(false);
                Ok(Json::Null)
            }
            "desktop:app-activation-complete" => Ok(Json::Null),
            "desktop:discover-ssh-hosts" | "discoverSshHosts" => Ok(Json::Array(Vec::new())),
            "desktop:list-pending-snap-shots" | "listPendingSnapShots" => {
                Ok(Json::Array(Vec::new()))
            }
            "desktop:get-snap-shot-state" | "getSnapShotState" => Ok(Json::object([
                ("mode", Json::from("unavailable")),
                ("shortcut", Json::from("off")),
                ("shortcutRegistered", Json::Bool(false)),
                ("shortcutMessage", Json::Null),
                ("message", Json::Null),
            ])),

            // --- Embedded preview webview pane ---
            "desktop:preview-create-tab" | "preview.createTab" => {
                let tab_id = required_str(&params, "tabId")?;
                let zoom = params.get("zoomFactor").and_then(Json::as_f64);
                let color_scheme = params.get("colorScheme").and_then(Json::as_str);
                self.host.preview_create_tab(&tab_id, zoom, color_scheme);
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                state.preview_zooms.insert(tab_id, zoom.unwrap_or(1.0));
                Ok(Json::Null)
            }
            "desktop:preview-close-tab" | "preview.closeTab" => {
                let tab_id = required_str(&params, "tabId")?;
                self.host.preview_close_tab(&tab_id);
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                state.preview_zooms.remove(&tab_id);
                Ok(Json::Null)
            }
            "desktop:preview-navigate" | "preview.navigate" => {
                let tab_id = required_str(&params, "tabId")?;
                let url = required_str(&params, "url")?;
                self.host.preview_navigate(&tab_id, &url);
                Ok(Json::Null)
            }
            "desktop:preview-go-back" | "preview.goBack" => {
                self.host.preview_go_back(&required_str(&params, "tabId")?);
                Ok(Json::Null)
            }
            "desktop:preview-go-forward" | "preview.goForward" => {
                self.host
                    .preview_go_forward(&required_str(&params, "tabId")?);
                Ok(Json::Null)
            }
            "desktop:preview-refresh" | "preview.refresh" => {
                self.host
                    .preview_refresh(&required_str(&params, "tabId")?, false);
                Ok(Json::Null)
            }
            "desktop:preview-hard-reload" | "preview.hardReload" => {
                self.host
                    .preview_refresh(&required_str(&params, "tabId")?, true);
                Ok(Json::Null)
            }
            "desktop:preview-stop-loading" | "preview.stopLoading" => {
                self.host
                    .preview_stop_loading(&required_str(&params, "tabId")?);
                Ok(Json::Null)
            }
            "desktop:preview-zoom-in" | "preview.zoomIn" => {
                let tab_id = required_str(&params, "tabId")?;
                let next = (self.host.preview_get_zoom(&tab_id) + 0.1).min(3.0);
                self.host.preview_set_zoom(&tab_id, next);
                Ok(Json::Null)
            }
            "desktop:preview-zoom-out" | "preview.zoomOut" => {
                let tab_id = required_str(&params, "tabId")?;
                let next = (self.host.preview_get_zoom(&tab_id) - 0.1).max(0.25);
                self.host.preview_set_zoom(&tab_id, next);
                Ok(Json::Null)
            }
            "desktop:preview-reset-zoom" | "preview.resetZoom" => {
                let tab_id = required_str(&params, "tabId")?;
                self.host.preview_set_zoom(&tab_id, 1.0);
                Ok(Json::Null)
            }
            "desktop:preview-set-zoom-factor" | "preview.setZoomFactor" => {
                let tab_id = required_str(&params, "tabId")?;
                let factor = params
                    .get("zoomFactor")
                    .and_then(Json::as_f64)
                    .unwrap_or(1.0)
                    .clamp(0.25, 3.0);
                self.host.preview_set_zoom(&tab_id, factor);
                Ok(Json::Null)
            }
            "desktop:preview-set-color-scheme" | "preview.setColorScheme" => {
                let tab_id = required_str(&params, "tabId")?;
                let scheme = params
                    .get("colorScheme")
                    .and_then(Json::as_str)
                    .unwrap_or("system");
                self.host.preview_set_color_scheme(&tab_id, scheme);
                Ok(Json::Null)
            }
            "desktop:preview-set-audio-muted" | "preview.setAudioMuted" => {
                let tab_id = required_str(&params, "tabId")?;
                let muted = params
                    .get("audioMuted")
                    .and_then(Json::as_bool)
                    .unwrap_or(false);
                self.host.preview_set_muted(&tab_id, muted);
                Ok(Json::Null)
            }
            "desktop:preview-set-shown" | "preview.setShown" => {
                let tab_id = required_str(&params, "tabId")?;
                let shown = params.get("shown").and_then(Json::as_bool).unwrap_or(true);
                self.host.preview_set_shown(&tab_id, shown);
                Ok(Json::Null)
            }
            "desktop:preview-find-in-page" | "preview.findInPage" => {
                let tab_id = required_str(&params, "tabId")?;
                let text = required_str(&params, "text")?;
                let forward = params
                    .get("forward")
                    .and_then(Json::as_bool)
                    .unwrap_or(true);
                let new_session = params
                    .get("newSession")
                    .and_then(Json::as_bool)
                    .unwrap_or(true);
                self.host
                    .preview_find_in_page(&tab_id, &text, forward, new_session);
                Ok(Json::Null)
            }
            "desktop:preview-stop-find-in-page" | "preview.stopFindInPage" => {
                self.host
                    .preview_stop_find_in_page(&required_str(&params, "tabId")?);
                Ok(Json::Null)
            }
            "desktop:preview-open-devtools" | "preview.openDevTools" => {
                self.host
                    .preview_open_devtools(&required_str(&params, "tabId")?);
                Ok(Json::Null)
            }
            "desktop:preview-get-config" | "preview.getPreviewConfig" => Ok(Json::object([
                ("partition", Json::from("native:preview")),
                ("webPreferences", Json::from("contextIsolation=no")),
                ("preloadUrl", Json::Null),
            ])),
            "desktop:preview-register-webview"
            | "desktop:preview-set-forwarded-shortcuts"
            | "desktop:preview-set-capture-drawn"
            | "desktop:preview-clear-cookies"
            | "desktop:preview-clear-cache"
            | "desktop:preview-set-annotation-theme"
            | "desktop:preview-set-annotation-send-enabled"
            | "desktop:preview-annotation-voice-state"
            | "desktop:preview-cancel-pick-element"
            | "desktop:preview-pip-open"
            | "desktop:preview-pip-close"
            | "desktop:preview-recording-stop"
            | "desktop:preview-tunnel-access-resolve" => Ok(Json::Null),
            "desktop:preview-import-sources" | "desktop:port-forward-list" => {
                Ok(Json::Array(Vec::new()))
            }
            "desktop:port-forward-shares-loopback" => Ok(Json::Bool(true)),
            "desktop:preview-get-state" => {
                let tab_id = required_str(&params, "tabId")?;
                Ok(match self.host.preview_tab_snapshot(&tab_id) {
                    Some(snap) => snap.to_json(),
                    None => Json::Null,
                })
            }

            other => Err(format!("unsupported native desktop IPC channel: {other}")),
        }
    }
}

/// Builds the JS expression that resolves a pending promise in the renderer.
pub fn build_reply_script(id: u64, ok: bool, payload: &Json) -> String {
    let encoded = payload.to_json_string();
    if ok {
        format!(
            "window.__t3NativeBridge && window.__t3NativeBridge._resolve({id}, true, {encoded}, null);"
        )
    } else {
        format!(
            "window.__t3NativeBridge && window.__t3NativeBridge._resolve({id}, false, null, {encoded});"
        )
    }
}

/// Builds the JS expression that emits a host push event to renderer subscribers.
pub fn build_event_script(channel: &str, payload: &Json) -> String {
    let ch = escape_json_string(channel);
    let data = payload.to_json_string();
    format!("window.__t3NativeBridge && window.__t3NativeBridge._emit({ch}, {data});")
}

/// Generates the self-contained preload script injected at `DOCUMENT_START`
/// into the WebKit2GTK / WKWebView / WebView2 host window.
pub fn build_preload_script(bootstrap: &PreloadBootstrap) -> String {
    let bootstrap_json = Json::object([
        ("platform", Json::from(bootstrap.platform.clone())),
        ("branding", bootstrap.branding.clone()),
        ("systemLocale", Json::from(bootstrap.system_locale.clone())),
        (
            "preferredSystemLanguages",
            Json::from(bootstrap.preferred_languages.clone()),
        ),
        (
            "primaryPasteEnabled",
            Json::Bool(bootstrap.primary_paste_enabled),
        ),
        (
            "localEnvironmentEnabled",
            Json::Bool(bootstrap.local_environment_enabled),
        ),
        (
            "localEnvironmentBootstraps",
            Json::Array(bootstrap.local_bootstraps.clone()),
        ),
        ("fullscreen", Json::Bool(bootstrap.fullscreen)),
        ("zoomFactor", Json::from(bootstrap.zoom_factor)),
        ("colorScheme", Json::from(bootstrap.color_scheme.as_str())),
    ])
    .to_json_string();

    format!(
        r#"(function () {{
  if (window.desktopBridge) return;
  const BOOTSTRAP = {bootstrap_json};
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  let fullscreen = !!BOOTSTRAP.fullscreen;
  let localEnvEnabled = BOOTSTRAP.localEnvironmentEnabled !== false;

  function postToNative(msg) {{
    const raw = JSON.stringify(msg);
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.t3bridge) {{
      window.webkit.messageHandlers.t3bridge.postMessage(raw);
      return true;
    }}
    if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === "function") {{
      window.chrome.webview.postMessage(raw);
      return true;
    }}
    return false;
  }}

  function invoke(method, params) {{
    return new Promise(function (resolve, reject) {{
      const id = nextId++;
      pending.set(id, {{ resolve: resolve, reject: reject }});
      if (!postToNative({{ id: id, method: method, params: params === undefined ? null : params }})) {{
        pending.delete(id);
        reject(new Error("Native desktop bridge transport unavailable for " + method));
      }}
    }});
  }}

  function on(channel, listener) {{
    let set = listeners.get(channel);
    if (!set) {{
      set = new Set();
      listeners.set(channel, set);
    }}
    set.add(listener);
    return function () {{
      set.delete(listener);
    }};
  }}

  window.__t3NativeBridge = {{
    bootstrap: BOOTSTRAP,
    invoke: invoke,
    on: on,
    _resolve: function (id, ok, result, error) {{
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(typeof error === "string" ? error : "Native IPC error"));
    }},
    _emit: function (channel, payload) {{
      if (channel === "desktop:window-fullscreen-state" && typeof payload === "boolean") {{
        fullscreen = payload;
      }}
      const set = listeners.get(channel);
      if (!set) return;
      set.forEach(function (fn) {{
        try {{
          if (channel === "desktop:preview-state-change" && payload && typeof payload === "object") {{
            fn(payload.tabId, payload.state || payload);
          }} else if (channel === "desktop:preview-annotation-voice-event" && payload && typeof payload === "object") {{
            fn(payload.tabId, payload.event);
          }} else {{
            fn(payload);
          }}
        }} catch (_err) {{}}
      }});
    }},
  }};

  window.desktopBridge = {{
    getAppBranding: function () {{ return BOOTSTRAP.branding; }},
    getRelayTelemetryEnabled: function () {{ return false; }},
    getPathForFile: function (file) {{ return (file && typeof file.path === "string") ? file.path : ""; }},
    getClientPlatform: function () {{ return BOOTSTRAP.platform; }},
    restartAudioService: function () {{ return invoke("desktop:restart-audio-service"); }},
    setNotificationBadge: function (badge) {{ return invoke("desktop:set-notification-badge", badge); }},
    onNotificationBadgeClear: function (fn) {{ return on("desktop:set-notification-badge", function () {{ fn(); }}); }},
    onTrackpadScrollBegin: function (fn) {{ return on("desktop:trackpad-scroll-begin", function () {{ fn(); }}); }},
    onTrackpadScrollEnd: function (fn) {{ return on("desktop:trackpad-scroll-end", function () {{ fn(); }}); }},
    revealWindow: function () {{ return invoke("desktop:reveal-window"); }},
    getPrimaryPasteEnabled: function () {{ return BOOTSTRAP.primaryPasteEnabled !== false; }},
    getSystemLocale: function () {{ return BOOTSTRAP.systemLocale; }},
    getPreferredSystemLanguages: function () {{ return BOOTSTRAP.preferredSystemLanguages || []; }},
    getLocalEnvironmentBootstraps: function () {{ return BOOTSTRAP.localEnvironmentBootstraps || []; }},
    getLocalEnvironmentEnabled: function () {{ return localEnvEnabled; }},
    setLocalEnvironmentEnabled: function (enabled) {{
      localEnvEnabled = !!enabled;
      return invoke("desktop:set-local-environment-enabled", !!enabled);
    }},
    getHostEnvironmentId: function () {{ return invoke("desktop:get-host-environment-id"); }},
    getLocalEnvironmentBearerToken: function () {{ return invoke("desktop:get-local-environment-bearer-token"); }},
    getClientSettings: function () {{ return invoke("desktop:get-client-settings"); }},
    setClientSettings: function (settings) {{ return invoke("desktop:set-client-settings", settings); }},
    getConnectionCatalog: function () {{ return invoke("desktop:get-connection-catalog"); }},
    setConnectionCatalog: function (catalog) {{ return invoke("desktop:set-connection-catalog", catalog); }},
    discoverSshHosts: function () {{ return invoke("desktop:discover-ssh-hosts"); }},
    resolveSshHost: function (alias) {{ return invoke("desktop:resolve-ssh-host", alias); }},
    requestSnapShotPermissions: function (includeAccessibility) {{ return invoke("desktop:request-snap-shot-permissions", includeAccessibility); }},
    getSnapShotState: function () {{ return invoke("desktop:get-snap-shot-state"); }},
    setupSnapShot: function (action) {{ return invoke("desktop:setup-snap-shot", action); }},
    previewSnapShotConfig: function (request) {{ return invoke("desktop:preview-snap-shot-config", request); }},
    applySnapShotConfig: function (id) {{ return invoke("desktop:apply-snap-shot-config", id); }},
    checkSnapShotShortcut: function (shortcut) {{ return invoke("desktop:check-snap-shot-shortcut", shortcut); }},
    setSnapShotShortcutSuppressed: function (suppressed) {{ return invoke("desktop:set-snap-shot-shortcut-suppressed", suppressed); }},
    listPendingSnapShots: function () {{ return invoke("desktop:list-pending-snap-shots"); }},
    readSnapShot: function (id) {{ return invoke("desktop:read-snap-shot", id); }},
    setSnapShotAnimationDestination: function (dest) {{ return invoke("desktop:set-snap-shot-animation-destination", dest); }},
    dismissSnapShotAnimation: function (id) {{ return invoke("desktop:dismiss-snap-shot-animation", id); }},
    acknowledgeSnapShot: function (id) {{ return invoke("desktop:acknowledge-snap-shot", id); }},
    ensureSshEnvironment: function (target, options) {{ return invoke("desktop:ensure-ssh-environment", {{ target: target, options: options }}); }},
    disconnectSshEnvironment: function (target) {{ return invoke("desktop:disconnect-ssh-environment", target); }},
    fetchSshEnvironmentDescriptor: function (httpBaseUrl) {{ return invoke("desktop:fetch-ssh-environment-descriptor", {{ httpBaseUrl: httpBaseUrl }}); }},
    bootstrapSshBearerSession: function (httpBaseUrl, credential) {{ return invoke("desktop:bootstrap-ssh-bearer-session", {{ httpBaseUrl: httpBaseUrl, credential: credential }}); }},
    fetchSshSessionState: function (httpBaseUrl, bearerToken) {{ return invoke("desktop:fetch-ssh-session-state", {{ httpBaseUrl: httpBaseUrl, bearerToken: bearerToken }}); }},
    onSshPasswordPrompt: function (fn) {{ return on("desktop:ssh-password-prompt", fn); }},
    onSshPasswordPromptSettled: function (fn) {{ return on("desktop:ssh-password-prompt-settled", fn); }},
    resolveSshPasswordPrompt: function (requestId, password) {{ return invoke("desktop:resolve-ssh-password-prompt", {{ requestId: requestId, password: password }}); }},
    getServerExposureState: function () {{ return invoke("desktop:get-server-exposure-state"); }},
    setServerExposureMode: function (mode) {{ return invoke("desktop:set-server-exposure-mode", mode); }},
    setTailscaleServeEnabled: function (input) {{ return invoke("desktop:set-tailscale-serve-enabled", input); }},
    getAdvertisedEndpoints: function () {{ return invoke("desktop:get-advertised-endpoints"); }},
    getWslState: function () {{ return invoke("desktop:get-wsl-state"); }},
    setWslBackendEnabled: function (enabled) {{ return invoke("desktop:set-wsl-backend-enabled", enabled); }},
    setWslDistro: function (distro) {{ return invoke("desktop:set-wsl-distro", distro); }},
    setWslOnly: function (enabled) {{ return invoke("desktop:set-wsl-only", enabled); }},
    pickFolder: function (options) {{ return invoke("desktop:pick-folder", options || {{}}); }},
    toLocalBackendPath: function (backendId, path) {{ return invoke("desktop:to-local-backend-path", {{ backendId: backendId, path: path }}); }},
    pickProjectFavicon: function (initialPath) {{ return invoke("desktop:pick-project-favicon", {{ initialPath: initialPath || null }}); }},
    pickThemeFiles: function () {{ return invoke("desktop:pick-theme-files"); }},
    setTheme: function (theme) {{ return invoke("desktop:set-theme", theme); }},
    showContextMenu: function (items, position, source) {{ return invoke("desktop:context-menu", {{ items: items, position: position, source: source }}); }},
    receiveProviderAuthCallback: function (url) {{ return invoke("desktop:receive-provider-auth-callback", url); }},
    cancelProviderAuthCallback: function (url) {{ return invoke("desktop:cancel-provider-auth-callback", url); }},
    startFileDrag: function (input) {{ return invoke("desktop:start-file-drag", input); }},
    openExternal: function (url) {{ return invoke("desktop:open-external", url); }},
    readMedia: function (url) {{ return invoke("desktop:read-media", url); }},
    openSystemSettings: function (pane) {{ return invoke("desktop:open-system-settings", pane); }},
    checkSystemPermission: function (pane) {{ return invoke("desktop:check-system-permission", pane); }},
    probeRemoteEditors: function () {{ return invoke("desktop:probe-remote-editors"); }},
    pasteAsText: function () {{ return invoke("desktop:paste-as-text"); }},
    onMenuAction: function (fn) {{ return on("desktop:menu-action", fn); }},
    onSnapShotEvent: function (fn) {{ return on("desktop:snap-shot-event", fn); }},
    onQuitShortcut: function (fn) {{ return on("desktop:quit-shortcut", fn); }},
    getWindowFullscreenState: function () {{ return fullscreen; }},
    onWindowFullscreenStateChange: function (fn) {{ return on("desktop:window-fullscreen-state", fn); }},
    getWindowZoomFactor: function () {{ return BOOTSTRAP.zoomFactor || 1.0; }},
    getUpdateState: function () {{ return invoke("desktop:update-get-state"); }},
    setUpdateChannel: function (channel, minimumVersion) {{ return invoke("desktop:update-set-channel", {{ channel: channel, minimumVersion: minimumVersion }}); }},
    checkForUpdate: function () {{ return invoke("desktop:update-check"); }},
    downloadUpdate: function () {{ return invoke("desktop:update-download"); }},
    installUpdate: function (expectedVersion) {{ return invoke("desktop:update-install", expectedVersion); }},
    onUpdateState: function (fn) {{ return on("desktop:update-state", fn); }},
    cliCommand: {{
      getState: function () {{ return invoke("desktop:cli-command-get-state"); }},
      install: function () {{ return invoke("desktop:cli-command-install"); }},
      uninstall: function () {{ return invoke("desktop:cli-command-uninstall"); }},
      addToPath: function () {{ return invoke("desktop:cli-command-add-to-path"); }},
    }},
    webLinks: {{
      setReady: function (ready) {{ return invoke("desktop:web-link-ready", ready); }},
      onOpen: function (fn) {{ return on("desktop:web-link-open", fn); }},
    }},
    appActivation: {{
      setReady: function (ready) {{ return invoke("desktop:app-activation-ready", ready); }},
      complete: function (response) {{ return invoke("desktop:app-activation-complete", response); }},
      onRequest: function (fn) {{ return on("desktop:app-activation-request", fn); }},
    }},
    preview: {{
      setForwardedShortcuts: function (shortcuts) {{ return invoke("desktop:preview-set-forwarded-shortcuts", shortcuts); }},
      createTab: function (tabId, defaults) {{ return invoke("desktop:preview-create-tab", Object.assign({{ tabId: tabId }}, defaults || {{}})); }},
      closeTab: function (tabId) {{ return invoke("desktop:preview-close-tab", {{ tabId: tabId }}); }},
      registerWebview: function (tabId, webContentsId) {{ return invoke("desktop:preview-register-webview", {{ tabId: tabId, webContentsId: webContentsId }}); }},
      navigate: function (tabId, url) {{ return invoke("desktop:preview-navigate", {{ tabId: tabId, url: url }}); }},
      goBack: function (tabId) {{ return invoke("desktop:preview-go-back", {{ tabId: tabId }}); }},
      goForward: function (tabId) {{ return invoke("desktop:preview-go-forward", {{ tabId: tabId }}); }},
      refresh: function (tabId) {{ return invoke("desktop:preview-refresh", {{ tabId: tabId }}); }},
      stopLoading: function (tabId) {{ return invoke("desktop:preview-stop-loading", {{ tabId: tabId }}); }},
      zoomIn: function (tabId) {{ return invoke("desktop:preview-zoom-in", {{ tabId: tabId }}); }},
      zoomOut: function (tabId) {{ return invoke("desktop:preview-zoom-out", {{ tabId: tabId }}); }},
      resetZoom: function (tabId) {{ return invoke("desktop:preview-reset-zoom", {{ tabId: tabId }}); }},
      setZoomFactor: function (tabId, zoomFactor) {{ return invoke("desktop:preview-set-zoom-factor", {{ tabId: tabId, zoomFactor: zoomFactor }}); }},
      hardReload: function (tabId) {{ return invoke("desktop:preview-hard-reload", {{ tabId: tabId }}); }},
      setColorScheme: function (tabId, colorScheme) {{ return invoke("desktop:preview-set-color-scheme", {{ tabId: tabId, colorScheme: colorScheme }}); }},
      setAudioMuted: function (tabId, audioMuted) {{ return invoke("desktop:preview-set-audio-muted", {{ tabId: tabId, audioMuted: audioMuted }}); }},
      findInPage: function (tabId, text, opts) {{ return invoke("desktop:preview-find-in-page", Object.assign({{ tabId: tabId, text: text }}, opts || {{}})); }},
      stopFindInPage: function (tabId) {{ return invoke("desktop:preview-stop-find-in-page", {{ tabId: tabId }}); }},
      setShown: function (tabId, shown) {{ return invoke("desktop:preview-set-shown", {{ tabId: tabId, shown: shown }}); }},
      setCaptureDrawn: function (tabId, drawn) {{ return invoke("desktop:preview-set-capture-drawn", {{ tabId: tabId, drawn: drawn }}); }},
      openDevTools: function (tabId) {{ return invoke("desktop:preview-open-devtools", {{ tabId: tabId }}); }},
      listBrowserImportSources: function () {{ return invoke("desktop:preview-import-sources"); }},
      importBrowserCookies: function (input) {{ return invoke("desktop:preview-import-cookies", input); }},
      clearCookies: function (environmentId, profileId) {{ return invoke("desktop:preview-clear-cookies", {{ environmentId: environmentId, profileId: profileId }}); }},
      clearCache: function (environmentId, profileId) {{ return invoke("desktop:preview-clear-cache", {{ environmentId: environmentId, profileId: profileId }}); }},
      getPreviewConfig: function (environmentId, profileId, tunnelLoopback) {{ return invoke("desktop:preview-get-config", {{ environmentId: environmentId, profileId: profileId, tunnelLoopback: tunnelLoopback }}); }},
      onTunnelAccessRequest: function (fn) {{ return on("desktop:preview-tunnel-access-request", fn); }},
      resolveTunnelAccess: function (requestId, url) {{ return invoke("desktop:preview-tunnel-access-resolve", {{ requestId: requestId, url: url }}); }},
      forwardPort: function (environmentId, remotePort) {{ return invoke("desktop:port-forward-start", {{ environmentId: environmentId, remotePort: remotePort }}); }},
      stopPortForward: function (environmentId, remotePort) {{ return invoke("desktop:port-forward-stop", {{ environmentId: environmentId, remotePort: remotePort }}); }},
      listPortForwards: function () {{ return invoke("desktop:port-forward-list"); }},
      sharesLoopback: function (environmentId) {{ return invoke("desktop:port-forward-shares-loopback", {{ environmentId: environmentId }}); }},
      onPortForwards: function (fn) {{ return on("desktop:port-forward-change", fn); }},
      setAnnotationTheme: function (theme) {{ return invoke("desktop:preview-set-annotation-theme", {{ theme: theme }}); }},
      setAnnotationSendEnabled: function (tabId, enabled) {{ return invoke("desktop:preview-set-annotation-send-enabled", {{ tabId: tabId, enabled: enabled }}); }},
      annotationVoice: {{
        onEvent: function (fn) {{ return on("desktop:preview-annotation-voice-event", fn); }},
        update: function (state) {{ return invoke("desktop:preview-annotation-voice-state", state); }},
      }},
      pickElement: function (tabId, voice) {{ return invoke("desktop:preview-pick-element", {{ tabId: tabId, voice: voice }}); }},
      cancelPickElement: function (tabId) {{ return invoke("desktop:preview-cancel-pick-element", {{ tabId: tabId }}); }},
      captureScreenshot: function (tabId) {{ return invoke("desktop:preview-capture-screenshot", {{ tabId: tabId }}); }},
      revealArtifact: function (path) {{ return invoke("desktop:preview-reveal-artifact", {{ path: path }}); }},
      copyArtifactToClipboard: function (path) {{ return invoke("desktop:preview-copy-artifact", {{ path: path }}); }},
      pictureInPicture: {{
        open: function (tabId) {{ return invoke("desktop:preview-pip-open", {{ tabId: tabId }}); }},
        close: function (tabId) {{ return invoke("desktop:preview-pip-close", {{ tabId: tabId }}); }},
      }},
      recording: {{
        onInput: function (fn) {{ return on("desktop:preview-recording-input", fn); }},
        startScreencast: function (tabId) {{ return invoke("desktop:preview-recording-start", {{ tabId: tabId }}); }},
        stopScreencast: function (tabId) {{ return invoke("desktop:preview-recording-stop", {{ tabId: tabId }}); }},
        save: function (tabId, mimeType, data) {{ return invoke("desktop:preview-recording-save", {{ tabId: tabId, mimeType: mimeType, data: Array.from(data || []) }}); }},
      }},
      onStateChange: function (fn) {{ return on("desktop:preview-state-change", fn); }},
      onPointerEvent: function (fn) {{ return on("desktop:preview-pointer-event", fn); }},
      onOpenLink: function (fn) {{ return on("desktop:preview-open-link", fn); }},
      onFindResult: function (fn) {{ return on("desktop:preview-find-result", fn); }},
    }},
  }};

  document.addEventListener("fullscreenchange", function () {{
    const el = document.fullscreenElement;
    void invoke("desktop:sync-html-fullscreen", el !== null && el.tagName !== "WEBVIEW");
  }});
}})();
"#
    )
}

fn required_str(params: &Json, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(Json::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("missing required string parameter `{key}`"))
}

fn app_branding_json() -> Json {
    Json::object([
        ("baseName", Json::from(APP_BASE_NAME)),
        ("stageLabel", Json::from(APP_STAGE_LABEL)),
        ("displayName", Json::from(APP_DISPLAY_NAME)),
    ])
}

fn build_local_bootstraps(endpoint: Option<&ServerEndpoint>) -> Vec<Json> {
    let Some(ep) = endpoint else {
        return Vec::new();
    };
    let mut entries = vec![
        ("id", Json::from("primary")),
        ("label", Json::from("Local")),
        ("httpBaseUrl", Json::from(ep.http_base_url.clone())),
        ("wsBaseUrl", Json::from(ep.ws_base_url.clone())),
    ];
    if let Some(token) = &ep.bootstrap_token {
        entries.push(("bootstrapToken", Json::from(token.clone())));
    }
    vec![Json::object(entries)]
}

fn disabled_update_state() -> Json {
    let arch = match env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => "other",
    };
    Json::object([
        ("enabled", Json::Bool(false)),
        ("status", Json::from("disabled")),
        ("channel", Json::from("latest")),
        ("currentVersion", Json::from(APP_VERSION)),
        ("hostArch", Json::from(arch)),
        ("appArch", Json::from(arch)),
        ("runningUnderArm64Translation", Json::Bool(false)),
        ("availableVersion", Json::Null),
        ("downloadedVersion", Json::Null),
        ("releaseNotes", Json::Array(Vec::new())),
        ("omittedReleaseCount", Json::from(0i64)),
        ("downloadPercent", Json::Null),
        ("checkedAt", Json::Null),
        ("message", Json::Null),
        ("errorContext", Json::Null),
        ("canRetry", Json::Bool(false)),
    ])
}

fn node_platform_name() -> &'static str {
    match env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

pub fn posix_locale_to_bcp47(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "C" || trimmed == "POSIX" || trimmed.starts_with("C.") {
        return None;
    }
    let without_charset = trimmed.split('.').next().unwrap_or(trimmed);
    let without_modifier = without_charset.split('@').next().unwrap_or(without_charset);
    let normalized = without_modifier.replace('_', "-");
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn detect_system_locale() -> Option<String> {
    for var in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(val) = env::var(var) {
            if let Some(tag) = posix_locale_to_bcp47(&val) {
                return Some(tag);
            }
        }
    }
    None
}

fn detect_preferred_languages(fallback: Option<&str>) -> Vec<String> {
    let mut langs = Vec::new();
    if let Ok(list) = env::var("LANGUAGE") {
        for part in list.split(':') {
            if let Some(tag) = posix_locale_to_bcp47(part) {
                if !langs.contains(&tag) {
                    langs.push(tag);
                }
            }
        }
    }
    if let Some(tag) = fallback {
        let s = tag.to_string();
        if !langs.contains(&s) {
            langs.push(s);
        }
    }
    langs
}

pub fn is_safe_external_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("mailto:")
        || lower.starts_with("vscode://")
        || lower.starts_with("cursor://")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Default)]
    struct MockHost {
        opened_urls: Mutex<Vec<String>>,
        themes: Mutex<Vec<String>>,
        preview_navs: Mutex<Vec<(String, String)>>,
        picked_folder: Mutex<Option<String>>,
    }

    impl HostActions for MockHost {
        fn pick_folder(&self, _options: FileDialogOptions) -> Option<String> {
            self.picked_folder.lock().unwrap().clone()
        }
        fn pick_file(&self, _options: FileDialogOptions) -> Vec<String> {
            Vec::new()
        }
        fn open_external(&self, url: &str) -> bool {
            self.opened_urls.lock().unwrap().push(url.to_string());
            true
        }
        fn reveal_window(&self) {}
        fn set_theme(&self, theme: &str) {
            self.themes.lock().unwrap().push(theme.to_string());
        }
        fn get_color_scheme(&self) -> ColorScheme {
            ColorScheme::Dark
        }
        fn get_primary_paste_enabled(&self) -> bool {
            true
        }
        fn get_window_fullscreen(&self) -> bool {
            false
        }
        fn set_html_fullscreen(&self, _fullscreen: bool) {}
        fn get_zoom_factor(&self) -> f64 {
            1.0
        }
        fn set_notification_badge(&self, _count: i64) {}
        fn preview_create_tab(&self, _tab_id: &str, _z: Option<f64>, _c: Option<&str>) {}
        fn preview_close_tab(&self, _tab_id: &str) {}
        fn preview_navigate(&self, tab_id: &str, url: &str) {
            self.preview_navs
                .lock()
                .unwrap()
                .push((tab_id.to_string(), url.to_string()));
        }
        fn preview_go_back(&self, _tab_id: &str) {}
        fn preview_go_forward(&self, _tab_id: &str) {}
        fn preview_refresh(&self, _tab_id: &str, _bypass_cache: bool) {}
        fn preview_stop_loading(&self, _tab_id: &str) {}
        fn preview_set_zoom(&self, _tab_id: &str, _zoom_factor: f64) {}
        fn preview_get_zoom(&self, _tab_id: &str) -> f64 {
            1.0
        }
        fn preview_set_muted(&self, _tab_id: &str, _muted: bool) {}
        fn preview_set_color_scheme(&self, _tab_id: &str, _color_scheme: &str) {}
        fn preview_set_shown(&self, _tab_id: &str, _shown: bool) {}
        fn preview_find_in_page(&self, _tab_id: &str, _text: &str, _f: bool, _n: bool) {}
        fn preview_stop_find_in_page(&self, _tab_id: &str) {}
        fn preview_open_devtools(&self, _tab_id: &str) {}
        fn preview_tab_snapshot(&self, _tab_id: &str) -> Option<PreviewTabSnapshot> {
            None
        }
    }

    fn temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("t3-ipc-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn dispatches_settings_dialogs_external_and_preview_rpc() {
        let dir = temp_dir();
        let host = Arc::new(MockHost::default());
        *host.picked_folder.lock().unwrap() = Some("/tmp/project".to_string());

        let endpoint = ServerEndpoint {
            http_base_url: "http://127.0.0.1:3773".to_string(),
            ws_base_url: "ws://127.0.0.1:3773".to_string(),
            bootstrap_token: Some("tok_test".to_string()),
        };
        let ipc = IpcDispatcher::new(&dir, Some(endpoint), host.clone());

        let (id, ok, res) = ipc.handle_raw_message(r#"{"id":7,"method":"desktop:pick-folder","params":{}}"#);
        assert_eq!(id, 7);
        assert!(ok);
        assert_eq!(res.as_str(), Some("/tmp/project"));

        let (_, ok, _) = ipc.handle_raw_message(
            r#"{"id":8,"method":"desktop:set-client-settings","params":{"theme":"dark","fontSize":14}}"#,
        );
        assert!(ok);
        let (_, ok, loaded) =
            ipc.handle_raw_message(r#"{"id":9,"method":"desktop:get-client-settings","params":null}"#);
        assert!(ok);
        assert_eq!(loaded.get("theme").and_then(Json::as_str), Some("dark"));

        let (_, ok, opened) = ipc.handle_raw_message(
            r#"{"id":10,"method":"desktop:open-external","params":"https://t3.codes"}"#,
        );
        assert!(ok);
        assert_eq!(opened.as_bool(), Some(true));
        assert_eq!(host.opened_urls.lock().unwrap().as_slice(), ["https://t3.codes"]);

        // Blocks unsafe javascript: URLs
        let (_, ok, blocked) = ipc.handle_raw_message(
            r#"{"id":11,"method":"desktop:open-external","params":"javascript:alert(1)"}"#,
        );
        assert!(ok);
        assert_eq!(blocked.as_bool(), Some(false));

        let (_, ok, _) = ipc.handle_raw_message(
            r#"{"id":12,"method":"desktop:preview-navigate","params":{"tabId":"tab-1","url":"http://127.0.0.1:5173"}}"#,
        );
        assert!(ok);
        assert_eq!(
            host.preview_navs.lock().unwrap().as_slice(),
            [("tab-1".to_string(), "http://127.0.0.1:5173".to_string())]
        );

        let preload = build_preload_script(&ipc.preload_bootstrap());
        assert!(preload.contains("window.desktopBridge"));
        assert!(preload.contains("http://127.0.0.1:3773"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn converts_posix_locale_to_bcp47() {
        assert_eq!(posix_locale_to_bcp47("en_US.UTF-8").as_deref(), Some("en-US"));
        assert_eq!(posix_locale_to_bcp47("fr_FR@euro").as_deref(), Some("fr-FR"));
        assert_eq!(posix_locale_to_bcp47("C.UTF-8"), None);
        assert_eq!(posix_locale_to_bcp47("POSIX"), None);
    }
}
