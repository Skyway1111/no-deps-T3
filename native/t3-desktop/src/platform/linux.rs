use std::cell::RefCell;
use std::collections::BTreeMap;
use std::env;
use std::ffi::{c_char, c_double, c_int, c_uint, c_ulong, c_void, CStr, CString};
use std::io;
use std::path::Path;
use std::process::Command;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use crate::ipc::{
    build_event_script, build_preload_script, build_reply_script, HostActions, IpcDispatcher,
};
use crate::json::Json;
use crate::platform::{
    ColorScheme, DesktopPlatform, FileDialogOptions, PreviewTabSnapshot, WindowConfig,
};
use crate::server::ServerEndpoint;

// --- Opaque C types for GLib / GIO / GTK3 / WebKit2GTK-4.1 / JSC ---
#[repr(C)]
struct GtkWidget {
    _private: [u8; 0],
}
#[repr(C)]
struct GtkWindow {
    _private: [u8; 0],
}
#[repr(C)]
struct GtkContainer {
    _private: [u8; 0],
}
#[repr(C)]
struct GtkPaned {
    _private: [u8; 0],
}
#[repr(C)]
struct GtkStack {
    _private: [u8; 0],
}
#[repr(C)]
struct GtkDialog {
    _private: [u8; 0],
}
#[repr(C)]
struct GtkFileChooser {
    _private: [u8; 0],
}
#[repr(C)]
struct GtkSettings {
    _private: [u8; 0],
}
#[repr(C)]
struct WebKitUserContentManager {
    _private: [u8; 0],
}
#[repr(C)]
struct WebKitUserScript {
    _private: [u8; 0],
}
#[repr(C)]
struct WebKitWebView {
    _private: [u8; 0],
}
#[repr(C)]
struct WebKitSettings {
    _private: [u8; 0],
}
#[repr(C)]
struct WebKitFeature {
    _private: [u8; 0],
}
#[repr(C)]
struct WebKitFeatureList {
    _private: [u8; 0],
}
#[repr(C)]
struct WebKitWebInspector {
    _private: [u8; 0],
}
#[repr(C)]
struct WebKitFindController {
    _private: [u8; 0],
}
#[repr(C)]
struct WebKitJavascriptResult {
    _private: [u8; 0],
}
#[repr(C)]
struct JscValue {
    _private: [u8; 0],
}
#[repr(C)]
struct GError {
    _private: [u8; 0],
}
#[repr(C)]
struct GDBusConnection {
    _private: [u8; 0],
}
#[repr(C)]
struct GVariant {
    _private: [u8; 0],
}
#[repr(C)]
struct GSList {
    data: *mut c_void,
    next: *mut GSList,
}

#[repr(C)]
struct GdkEventWindowState {
    event_type: c_int,
    window: *mut c_void,
    send_event: i8,
    changed_mask: u32,
    new_window_state: u32,
}

const GTK_WINDOW_TOPLEVEL: c_int = 0;
const GTK_ORIENTATION_HORIZONTAL: c_int = 0;
const GTK_FILE_CHOOSER_ACTION_OPEN: c_int = 0;
const GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER: c_int = 2;
const GTK_RESPONSE_ACCEPT: c_int = -3;
const GTK_RESPONSE_CANCEL: c_int = -6;
const GDK_WINDOW_STATE_FULLSCREEN: u32 = 1 << 4;
const G_BUS_TYPE_SESSION: c_int = 2;

const WEBKIT_USER_CONTENT_INJECT_TOP_FRAME: c_int = 1;
const WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START: c_int = 0;
const WEBKIT_FIND_OPTIONS_CASE_INSENSITIVE: u32 = 1 << 0;
const WEBKIT_FIND_OPTIONS_BACKWARDS: u32 = 1 << 3;
const WEBKIT_FIND_OPTIONS_WRAP_AROUND: u32 = 1 << 4;

extern "C" {
    // GLib / GObject
    fn g_free(mem: *mut c_void);
    fn g_error_free(error: *mut GError);
    fn g_set_prgname(prgname: *const c_char);
    fn g_set_application_name(application_name: *const c_char);
    fn g_object_unref(object: *mut c_void);
    fn g_object_get(object: *mut c_void, first_property_name: *const c_char, ...);
    fn g_object_set(object: *mut c_void, first_property_name: *const c_char, ...);
    fn g_signal_connect_data(
        instance: *mut c_void,
        detailed_signal: *const c_char,
        c_handler: *const c_void,
        data: *mut c_void,
        destroy_data: *const c_void,
        connect_flags: c_uint,
    ) -> c_ulong;
    fn g_slist_free_full(list: *mut GSList, free_func: unsafe extern "C" fn(*mut c_void));
    fn g_idle_add(
        function: unsafe extern "C" fn(*mut c_void) -> c_int,
        data: *mut c_void,
    ) -> c_uint;

    // GIO D-Bus (for XDG Desktop Portal color-scheme without dbus-next)
    fn g_bus_get_sync(
        bus_type: c_int,
        cancellable: *mut c_void,
        error: *mut *mut GError,
    ) -> *mut GDBusConnection;
    fn g_dbus_connection_call_sync(
        connection: *mut GDBusConnection,
        bus_name: *const c_char,
        object_path: *const c_char,
        interface_name: *const c_char,
        method_name: *const c_char,
        parameters: *mut GVariant,
        reply_type: *const c_void,
        flags: c_int,
        timeout_msec: c_int,
        cancellable: *mut c_void,
        error: *mut *mut GError,
    ) -> *mut GVariant;
    fn g_variant_new_string(string: *const c_char) -> *mut GVariant;
    fn g_variant_new_tuple(children: *const *mut GVariant, n_children: usize) -> *mut GVariant;
    fn g_variant_get_child_value(value: *mut GVariant, index: usize) -> *mut GVariant;
    fn g_variant_get_variant(value: *mut GVariant) -> *mut GVariant;
    fn g_variant_get_type_string(value: *mut GVariant) -> *const c_char;
    fn g_variant_get_uint32(value: *mut GVariant) -> u32;
    fn g_variant_unref(value: *mut GVariant);

    // GTK3
    fn gtk_init_check(argc: *mut c_int, argv: *mut *mut *mut c_char) -> c_int;
    fn gtk_main();
    fn gtk_main_quit();
    fn gtk_window_new(window_type: c_int) -> *mut GtkWidget;
    fn gtk_window_set_title(window: *mut GtkWindow, title: *const c_char);
    fn gtk_window_set_icon_from_file(
        window: *mut GtkWindow,
        filename: *const c_char,
        err: *mut *mut GError,
    ) -> c_int;
    fn gtk_window_set_default_size(window: *mut GtkWindow, width: c_int, height: c_int);
    fn gtk_window_present(window: *mut GtkWindow);
    fn gtk_window_fullscreen(window: *mut GtkWindow);
    fn gtk_window_unfullscreen(window: *mut GtkWindow);
    fn gtk_widget_show_all(widget: *mut GtkWidget);
    fn gtk_widget_show(widget: *mut GtkWidget);
    fn gtk_widget_hide(widget: *mut GtkWidget);
    fn gtk_widget_destroy(widget: *mut GtkWidget);
    fn gtk_container_add(container: *mut GtkContainer, widget: *mut GtkWidget);
    fn gtk_paned_new(orientation: c_int) -> *mut GtkWidget;
    fn gtk_paned_pack1(paned: *mut GtkPaned, child: *mut GtkWidget, resize: c_int, shrink: c_int);
    fn gtk_paned_pack2(paned: *mut GtkPaned, child: *mut GtkWidget, resize: c_int, shrink: c_int);
    fn gtk_paned_set_position(paned: *mut GtkPaned, position: c_int);
    fn gtk_stack_new() -> *mut GtkWidget;
    fn gtk_stack_add_named(stack: *mut GtkStack, child: *mut GtkWidget, name: *const c_char);
    fn gtk_stack_set_visible_child_name(stack: *mut GtkStack, name: *const c_char);
    fn gtk_settings_get_default() -> *mut GtkSettings;
    fn gtk_file_chooser_dialog_new(
        title: *const c_char,
        parent: *mut GtkWindow,
        action: c_int,
        first_button_text: *const c_char,
        ...
    ) -> *mut GtkWidget;
    fn gtk_file_chooser_set_current_folder(
        chooser: *mut GtkFileChooser,
        filename: *const c_char,
    ) -> c_int;
    fn gtk_file_chooser_set_select_multiple(chooser: *mut GtkFileChooser, select_multiple: c_int);
    fn gtk_file_chooser_get_filename(chooser: *mut GtkFileChooser) -> *mut c_char;
    fn gtk_file_chooser_get_filenames(chooser: *mut GtkFileChooser) -> *mut GSList;
    fn gtk_dialog_run(dialog: *mut GtkDialog) -> c_int;
    fn gtk_show_uri_on_window(
        parent: *mut GtkWindow,
        uri: *const c_char,
        timestamp: u32,
        error: *mut *mut GError,
    ) -> c_int;

    // WebKit2GTK-4.1 & JavaScriptCoreGTK-4.1
    fn webkit_user_content_manager_new() -> *mut WebKitUserContentManager;
    fn webkit_user_script_new(
        source: *const c_char,
        injected_frames: c_int,
        injection_time: c_int,
        allow_list: *const *const c_char,
        block_list: *const *const c_char,
    ) -> *mut WebKitUserScript;
    fn webkit_user_script_unref(user_script: *mut WebKitUserScript);
    fn webkit_user_content_manager_add_script(
        manager: *mut WebKitUserContentManager,
        script: *mut WebKitUserScript,
    );
    fn webkit_user_content_manager_register_script_message_handler(
        manager: *mut WebKitUserContentManager,
        name: *const c_char,
    ) -> c_int;
    fn webkit_web_view_new() -> *mut GtkWidget;
    fn webkit_web_view_new_with_user_content_manager(
        user_content_manager: *mut WebKitUserContentManager,
    ) -> *mut GtkWidget;
    fn webkit_web_view_load_uri(web_view: *mut WebKitWebView, uri: *const c_char);
    fn webkit_web_view_evaluate_javascript(
        web_view: *mut WebKitWebView,
        script: *const c_char,
        length: isize,
        world_name: *const c_char,
        source_uri: *const c_char,
        cancellable: *mut c_void,
        callback: *const c_void,
        user_data: *mut c_void,
    );
    fn webkit_web_view_get_settings(web_view: *mut WebKitWebView) -> *mut WebKitSettings;
    fn webkit_settings_set_enable_developer_extras(settings: *mut WebKitSettings, enabled: c_int);
    fn webkit_settings_get_all_features() -> *mut WebKitFeatureList;
    fn webkit_settings_set_feature_enabled(
        settings: *mut WebKitSettings,
        feature: *mut WebKitFeature,
        enabled: c_int,
    );
    fn webkit_feature_list_get_length(list: *mut WebKitFeatureList) -> usize;
    fn webkit_feature_list_get(list: *mut WebKitFeatureList, index: usize) -> *mut WebKitFeature;
    fn webkit_feature_list_unref(list: *mut WebKitFeatureList);
    fn webkit_feature_get_identifier(feature: *mut WebKitFeature) -> *const c_char;
    fn webkit_web_view_get_inspector(web_view: *mut WebKitWebView) -> *mut WebKitWebInspector;
    fn webkit_web_inspector_show(inspector: *mut WebKitWebInspector);
    fn webkit_web_view_go_back(web_view: *mut WebKitWebView);
    fn webkit_web_view_go_forward(web_view: *mut WebKitWebView);
    fn webkit_web_view_can_go_back(web_view: *mut WebKitWebView) -> c_int;
    fn webkit_web_view_can_go_forward(web_view: *mut WebKitWebView) -> c_int;
    fn webkit_web_view_reload(web_view: *mut WebKitWebView);
    fn webkit_web_view_reload_bypass_cache(web_view: *mut WebKitWebView);
    fn webkit_web_view_stop_loading(web_view: *mut WebKitWebView);
    fn webkit_web_view_set_zoom_level(web_view: *mut WebKitWebView, zoom_level: c_double);
    fn webkit_web_view_get_zoom_level(web_view: *mut WebKitWebView) -> c_double;
    fn webkit_web_view_set_is_muted(web_view: *mut WebKitWebView, muted: c_int);
    fn webkit_web_view_get_is_muted(web_view: *mut WebKitWebView) -> c_int;
    fn webkit_web_view_get_uri(web_view: *mut WebKitWebView) -> *const c_char;
    fn webkit_web_view_get_title(web_view: *mut WebKitWebView) -> *const c_char;
    fn webkit_web_view_get_find_controller(
        web_view: *mut WebKitWebView,
    ) -> *mut WebKitFindController;
    fn webkit_find_controller_search(
        find_controller: *mut WebKitFindController,
        search_text: *const c_char,
        find_options: u32,
        max_match_count: c_uint,
    );
    fn webkit_find_controller_search_next(find_controller: *mut WebKitFindController);
    fn webkit_find_controller_search_previous(find_controller: *mut WebKitFindController);
    fn webkit_find_controller_search_finish(find_controller: *mut WebKitFindController);
    fn webkit_javascript_result_get_js_value(
        js_result: *mut WebKitJavascriptResult,
    ) -> *mut JscValue;
    fn jsc_value_to_string(value: *mut JscValue) -> *mut c_char;
}

struct PreviewTabEntry {
    widget: *mut GtkWidget,
    webview: *mut WebKitWebView,
    color_scheme: String,
    shown: bool,
}

/// GTK main-thread widget state. Accessed exclusively from the GTK main thread.
struct GtkUiState {
    window: *mut GtkWindow,
    paned: *mut GtkPaned,
    main_webview: *mut WebKitWebView,
    preview_stack: *mut GtkStack,
    preview_tabs: BTreeMap<String, PreviewTabEntry>,
    active_preview_tab: Option<String>,
    base_title: String,
    devtools: bool,
    window_width: i32,
}

thread_local! {
    static GTK_UI: RefCell<Option<GtkUiState>> = const { RefCell::new(None) };
}

struct LinuxHost {
    fullscreen: AtomicBool,
}

impl LinuxHost {
    fn new() -> Self {
        Self {
            fullscreen: AtomicBool::new(false),
        }
    }
}

struct CallbackContext {
    dispatcher: Arc<IpcDispatcher>,
    host: Arc<LinuxHost>,
}

static CALLBACK_CTX: OnceLock<Arc<CallbackContext>> = OnceLock::new();

pub struct LinuxPlatform;

impl DesktopPlatform for LinuxPlatform {
    fn run(
        config: WindowConfig,
        state_dir: &Path,
        local_endpoint: Option<ServerEndpoint>,
    ) -> io::Result<()> {
        let prg = cstring("no-deps-t3");
        let app_name = cstring(&config.title);
        unsafe {
            g_set_prgname(prg.as_ptr());
            g_set_application_name(app_name.as_ptr());
        }
        let mut argc: c_int = 0;
        let mut argv: *mut *mut c_char = ptr::null_mut();
        let ok = unsafe { gtk_init_check(&mut argc, &mut argv) };
        if ok == 0 {
            return Err(io::Error::other(
                "failed to initialize GTK3 (is DISPLAY or WAYLAND_DISPLAY set?)",
            ));
        }

        let host = Arc::new(LinuxHost::new());
        let dispatcher = Arc::new(IpcDispatcher::new(state_dir, local_endpoint, host.clone()));
        let preload_js = build_preload_script(&dispatcher.preload_bootstrap());

        let _ = CALLBACK_CTX.set(Arc::new(CallbackContext {
            dispatcher: Arc::clone(&dispatcher),
            host: Arc::clone(&host),
        }));

        unsafe {
            let window_widget = gtk_window_new(GTK_WINDOW_TOPLEVEL);
            let window = window_widget as *mut GtkWindow;
            let title_c = cstring(&config.title);
            gtk_window_set_title(window, title_c.as_ptr());
            if let Some(icon_path) = &config.icon_path {
                let icon_c = cstring(icon_path);
                let mut err: *mut GError = ptr::null_mut();
                gtk_window_set_icon_from_file(window, icon_c.as_ptr(), &mut err);
                if !err.is_null() {
                    g_error_free(err);
                }
            }
            gtk_window_set_default_size(window, config.width, config.height);

            // Inject preload bridge + register `window.webkit.messageHandlers.t3bridge`
            let ucm = webkit_user_content_manager_new();
            let preload_c = cstring(&preload_js);
            let script = webkit_user_script_new(
                preload_c.as_ptr(),
                WEBKIT_USER_CONTENT_INJECT_TOP_FRAME,
                WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START,
                ptr::null(),
                ptr::null(),
            );
            webkit_user_content_manager_add_script(ucm, script);
            webkit_user_script_unref(script);

            let handler_name = cstring("t3bridge");
            webkit_user_content_manager_register_script_message_handler(ucm, handler_name.as_ptr());

            let signal_bridge = cstring("script-message-received::t3bridge");
            g_signal_connect_data(
                ucm as *mut c_void,
                signal_bridge.as_ptr(),
                on_script_message as *const c_void,
                ptr::null_mut(),
                ptr::null(),
                0,
            );

            let main_webview_widget = webkit_web_view_new_with_user_content_manager(ucm);
            let main_webview = main_webview_widget as *mut WebKitWebView;
            g_object_unref(ucm as *mut c_void);

            configure_webview(main_webview, config.devtools);

            // Horizontal split pane: main T3 WebView (left) + embedded preview WebView stack (right)
            let paned_widget = gtk_paned_new(GTK_ORIENTATION_HORIZONTAL);
            let paned = paned_widget as *mut GtkPaned;
            let preview_stack_widget = gtk_stack_new();
            let preview_stack = preview_stack_widget as *mut GtkStack;

            gtk_paned_pack1(paned, main_webview_widget, 1, 0);
            gtk_paned_pack2(paned, preview_stack_widget, 1, 1);
            gtk_container_add(window_widget as *mut GtkContainer, paned_widget);

            let sig_destroy = cstring("destroy");
            g_signal_connect_data(
                window_widget as *mut c_void,
                sig_destroy.as_ptr(),
                on_window_destroy as *const c_void,
                ptr::null_mut(),
                ptr::null(),
                0,
            );

            let sig_state = cstring("window-state-event");
            g_signal_connect_data(
                window_widget as *mut c_void,
                sig_state.as_ptr(),
                on_window_state_event as *const c_void,
                ptr::null_mut(),
                ptr::null(),
                0,
            );

            GTK_UI.with(|cell| {
                *cell.borrow_mut() = Some(GtkUiState {
                    window,
                    paned,
                    main_webview,
                    preview_stack,
                    preview_tabs: BTreeMap::new(),
                    active_preview_tab: None,
                    base_title: config.title.clone(),
                    devtools: config.devtools,
                    window_width: config.width,
                });
            });

            let url_c = cstring(&config.url);
            webkit_web_view_load_uri(main_webview, url_c.as_ptr());

            gtk_widget_show_all(window_widget);
            super::refresh::pace_frame_clock(window_widget.cast());
            // Keep preview pane hidden until a preview tab is created & shown.
            gtk_widget_hide(preview_stack_widget);

            gtk_main();

            GTK_UI.with(|cell| {
                *cell.borrow_mut() = None;
            });
        }

        Ok(())
    }
}

/// Schedules an event push to the renderer from any thread via `g_idle_add`.
pub fn emit_event_from_any_thread(channel: &str, payload: &Json) {
    let script = build_event_script(channel, payload);
    let boxed = Box::new(script);
    unsafe {
        g_idle_add(eval_script_idle_cb, Box::into_raw(boxed) as *mut c_void);
    }
}

/// Raises the GTK window from any thread (e.g. secondary instance socket callback).
pub fn reveal_window_from_any_thread() {
    unsafe {
        g_idle_add(reveal_window_idle_cb, ptr::null_mut());
    }
}

unsafe extern "C" fn eval_script_idle_cb(data: *mut c_void) -> c_int {
    if !data.is_null() {
        let script = Box::from_raw(data as *mut String);
        eval_js_on_main_webview(&script);
    }
    0 // G_SOURCE_REMOVE
}

unsafe extern "C" fn reveal_window_idle_cb(_data: *mut c_void) -> c_int {
    GTK_UI.with(|cell| {
        if let Some(ui) = cell.borrow().as_ref() {
            gtk_window_present(ui.window);
        }
    });
    0
}

unsafe extern "C" fn on_window_destroy(_widget: *mut GtkWidget, _data: *mut c_void) {
    gtk_main_quit();
}

unsafe extern "C" fn on_window_state_event(
    _widget: *mut GtkWidget,
    event: *mut GdkEventWindowState,
    _data: *mut c_void,
) -> c_int {
    if event.is_null() {
        return 0;
    }
    let is_fullscreen = ((*event).new_window_state & GDK_WINDOW_STATE_FULLSCREEN) != 0;
    if let Some(ctx) = CALLBACK_CTX.get() {
        let prev = ctx.host.fullscreen.swap(is_fullscreen, Ordering::SeqCst);
        if prev != is_fullscreen {
            let script = build_event_script(
                "desktop:window-fullscreen-state",
                &Json::Bool(is_fullscreen),
            );
            eval_js_on_main_webview(&script);
        }
    }
    0
}

unsafe extern "C" fn on_script_message(
    _manager: *mut WebKitUserContentManager,
    js_result: *mut WebKitJavascriptResult,
    _user_data: *mut c_void,
) {
    if js_result.is_null() {
        return;
    }
    let jsc_val = webkit_javascript_result_get_js_value(js_result);
    if jsc_val.is_null() {
        return;
    }
    let raw_ptr = jsc_value_to_string(jsc_val);
    if raw_ptr.is_null() {
        return;
    }
    let raw_msg = CStr::from_ptr(raw_ptr).to_string_lossy().into_owned();
    g_free(raw_ptr as *mut c_void);

    if let Some(ctx) = CALLBACK_CTX.get() {
        let (id, ok, payload) = ctx.dispatcher.handle_raw_message(&raw_msg);
        if id > 0 {
            let reply_js = build_reply_script(id, ok, &payload);
            eval_js_on_main_webview(&reply_js);
        }
    }
}

fn eval_js_on_main_webview(script: &str) {
    GTK_UI.with(|cell| {
        if let Some(ui) = cell.borrow().as_ref() {
            if let Ok(c_script) = CString::new(script) {
                unsafe {
                    webkit_web_view_evaluate_javascript(
                        ui.main_webview,
                        c_script.as_ptr(),
                        script.len() as isize,
                        ptr::null(),
                        ptr::null(),
                        ptr::null_mut(),
                        ptr::null(),
                        ptr::null_mut(),
                    );
                }
            }
        }
    });
}

impl HostActions for LinuxHost {
    fn pick_folder(&self, options: FileDialogOptions) -> Option<String> {
        run_file_chooser(GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER, options)
            .into_iter()
            .next()
    }

    fn pick_file(&self, options: FileDialogOptions) -> Vec<String> {
        run_file_chooser(GTK_FILE_CHOOSER_ACTION_OPEN, options)
    }

    fn open_external(&self, url: &str) -> bool {
        let opened_via_gtk = GTK_UI.with(|cell| {
            let borrow = cell.borrow();
            let parent = borrow
                .as_ref()
                .map(|ui| ui.window)
                .unwrap_or(ptr::null_mut());
            let c_url = cstring(url);
            let mut err: *mut GError = ptr::null_mut();
            let ok = unsafe { gtk_show_uri_on_window(parent, c_url.as_ptr(), 0, &mut err) };
            if !err.is_null() {
                unsafe { g_error_free(err) };
            }
            ok != 0
        });
        if opened_via_gtk {
            return true;
        }
        Command::new("xdg-open").arg(url).spawn().is_ok()
    }

    fn reveal_window(&self) {
        GTK_UI.with(|cell| {
            if let Some(ui) = cell.borrow().as_ref() {
                unsafe { gtk_window_present(ui.window) };
            }
        });
    }

    fn set_theme(&self, theme: &str) {
        let prefer_dark: c_int = match theme {
            "dark" => 1,
            "light" => 0,
            _ => match detect_linux_color_scheme() {
                ColorScheme::Dark => 1,
                ColorScheme::Light => 0,
            },
        };
        unsafe {
            let settings = gtk_settings_get_default();
            if !settings.is_null() {
                let prop = cstring("gtk-application-prefer-dark-theme");
                g_object_set(
                    settings as *mut c_void,
                    prop.as_ptr(),
                    prefer_dark,
                    ptr::null::<c_void>(),
                );
            }
        }
    }

    fn get_color_scheme(&self) -> ColorScheme {
        detect_linux_color_scheme()
    }

    fn get_primary_paste_enabled(&self) -> bool {
        unsafe {
            let settings = gtk_settings_get_default();
            if settings.is_null() {
                return true;
            }
            let mut enabled: c_int = 1;
            let prop = cstring("gtk-enable-primary-paste");
            g_object_get(
                settings as *mut c_void,
                prop.as_ptr(),
                &mut enabled as *mut c_int,
                ptr::null::<c_void>(),
            );
            enabled != 0
        }
    }

    fn get_window_fullscreen(&self) -> bool {
        self.fullscreen.load(Ordering::SeqCst)
    }

    fn set_html_fullscreen(&self, fullscreen: bool) {
        GTK_UI.with(|cell| {
            if let Some(ui) = cell.borrow().as_ref() {
                unsafe {
                    if fullscreen {
                        gtk_window_fullscreen(ui.window);
                    } else {
                        gtk_window_unfullscreen(ui.window);
                    }
                }
            }
        });
    }

    fn get_zoom_factor(&self) -> f64 {
        GTK_UI.with(|cell| {
            cell.borrow()
                .as_ref()
                .map(|ui| unsafe { webkit_web_view_get_zoom_level(ui.main_webview) })
                .unwrap_or(1.0)
        })
    }

    fn set_notification_badge(&self, count: i64) {
        GTK_UI.with(|cell| {
            if let Some(ui) = cell.borrow().as_ref() {
                let title = if count > 0 {
                    format!("({count}) {}", ui.base_title)
                } else {
                    ui.base_title.clone()
                };
                let c_title = cstring(&title);
                unsafe { gtk_window_set_title(ui.window, c_title.as_ptr()) };
            }
        });
    }

    fn preview_create_tab(
        &self,
        tab_id: &str,
        zoom_factor: Option<f64>,
        color_scheme: Option<&str>,
    ) {
        GTK_UI.with(|cell| {
            let mut borrow = cell.borrow_mut();
            let Some(ui) = borrow.as_mut() else { return };
            if ui.preview_tabs.contains_key(tab_id) {
                return;
            }
            unsafe {
                let widget = webkit_web_view_new();
                let webview = widget as *mut WebKitWebView;
                configure_webview(webview, ui.devtools);
                if let Some(zoom) = zoom_factor {
                    webkit_web_view_set_zoom_level(webview, zoom);
                }
                let name = cstring(tab_id);
                gtk_stack_add_named(ui.preview_stack, widget, name.as_ptr());
                gtk_widget_show(widget);
                ui.preview_tabs.insert(
                    tab_id.to_string(),
                    PreviewTabEntry {
                        widget,
                        webview,
                        color_scheme: color_scheme.unwrap_or("system").to_string(),
                        shown: false,
                    },
                );
            }
        });
    }

    fn preview_close_tab(&self, tab_id: &str) {
        GTK_UI.with(|cell| {
            let mut borrow = cell.borrow_mut();
            let Some(ui) = borrow.as_mut() else { return };
            if let Some(entry) = ui.preview_tabs.remove(tab_id) {
                // Destroying removes it from the stack; removing first could drop the last reference.
                unsafe { gtk_widget_destroy(entry.widget) };
            }
            if ui.active_preview_tab.as_deref() == Some(tab_id) {
                ui.active_preview_tab = None;
            }
            if !ui.preview_tabs.values().any(|t| t.shown) {
                unsafe { gtk_widget_hide(ui.preview_stack as *mut GtkWidget) };
            }
        });
    }

    fn preview_navigate(&self, tab_id: &str, url: &str) {
        with_preview_tab(tab_id, |entry| {
            let c_url = cstring(url);
            unsafe { webkit_web_view_load_uri(entry.webview, c_url.as_ptr()) };
        });
    }

    fn preview_go_back(&self, tab_id: &str) {
        with_preview_tab(tab_id, |entry| unsafe {
            webkit_web_view_go_back(entry.webview);
        });
    }

    fn preview_go_forward(&self, tab_id: &str) {
        with_preview_tab(tab_id, |entry| unsafe {
            webkit_web_view_go_forward(entry.webview);
        });
    }

    fn preview_refresh(&self, tab_id: &str, bypass_cache: bool) {
        with_preview_tab(tab_id, |entry| unsafe {
            if bypass_cache {
                webkit_web_view_reload_bypass_cache(entry.webview);
            } else {
                webkit_web_view_reload(entry.webview);
            }
        });
    }

    fn preview_stop_loading(&self, tab_id: &str) {
        with_preview_tab(tab_id, |entry| unsafe {
            webkit_web_view_stop_loading(entry.webview);
        });
    }

    fn preview_set_zoom(&self, tab_id: &str, zoom_factor: f64) {
        with_preview_tab(tab_id, |entry| unsafe {
            webkit_web_view_set_zoom_level(entry.webview, zoom_factor);
        });
    }

    fn preview_get_zoom(&self, tab_id: &str) -> f64 {
        GTK_UI.with(|cell| {
            cell.borrow()
                .as_ref()
                .and_then(|ui| ui.preview_tabs.get(tab_id))
                .map(|entry| unsafe { webkit_web_view_get_zoom_level(entry.webview) })
                .unwrap_or(1.0)
        })
    }

    fn preview_set_muted(&self, tab_id: &str, muted: bool) {
        with_preview_tab(tab_id, |entry| unsafe {
            webkit_web_view_set_is_muted(entry.webview, if muted { 1 } else { 0 });
        });
    }

    fn preview_set_color_scheme(&self, tab_id: &str, color_scheme: &str) {
        GTK_UI.with(|cell| {
            if let Some(ui) = cell.borrow_mut().as_mut() {
                if let Some(entry) = ui.preview_tabs.get_mut(tab_id) {
                    entry.color_scheme = color_scheme.to_string();
                }
            }
        });
    }

    fn preview_set_shown(&self, tab_id: &str, shown: bool) {
        GTK_UI.with(|cell| {
            let mut borrow = cell.borrow_mut();
            let Some(ui) = borrow.as_mut() else { return };
            if let Some(entry) = ui.preview_tabs.get_mut(tab_id) {
                entry.shown = shown;
            }
            if shown {
                ui.active_preview_tab = Some(tab_id.to_string());
                let name = cstring(tab_id);
                unsafe {
                    gtk_stack_set_visible_child_name(ui.preview_stack, name.as_ptr());
                    gtk_widget_show(ui.preview_stack as *mut GtkWidget);
                    gtk_paned_set_position(ui.paned, (ui.window_width as f64 * 0.58) as c_int);
                }
            } else if !ui.preview_tabs.values().any(|t| t.shown) {
                unsafe { gtk_widget_hide(ui.preview_stack as *mut GtkWidget) };
            }
        });
    }

    fn preview_find_in_page(&self, tab_id: &str, text: &str, forward: bool, new_session: bool) {
        with_preview_tab(tab_id, |entry| unsafe {
            let controller = webkit_web_view_get_find_controller(entry.webview);
            if new_session {
                let mut opts =
                    WEBKIT_FIND_OPTIONS_CASE_INSENSITIVE | WEBKIT_FIND_OPTIONS_WRAP_AROUND;
                if !forward {
                    opts |= WEBKIT_FIND_OPTIONS_BACKWARDS;
                }
                let query = cstring(text);
                webkit_find_controller_search(controller, query.as_ptr(), opts, 1000);
            } else if forward {
                webkit_find_controller_search_next(controller);
            } else {
                webkit_find_controller_search_previous(controller);
            }
        });
    }

    fn preview_stop_find_in_page(&self, tab_id: &str) {
        with_preview_tab(tab_id, |entry| unsafe {
            let controller = webkit_web_view_get_find_controller(entry.webview);
            webkit_find_controller_search_finish(controller);
        });
    }

    fn preview_open_devtools(&self, tab_id: &str) {
        with_preview_tab(tab_id, |entry| unsafe {
            let settings = webkit_web_view_get_settings(entry.webview);
            webkit_settings_set_enable_developer_extras(settings, 1);
            let inspector = webkit_web_view_get_inspector(entry.webview);
            webkit_web_inspector_show(inspector);
        });
    }

    fn preview_tab_snapshot(&self, tab_id: &str) -> Option<PreviewTabSnapshot> {
        GTK_UI.with(|cell| {
            let borrow = cell.borrow();
            let ui = borrow.as_ref()?;
            let entry = ui.preview_tabs.get(tab_id)?;
            unsafe {
                let uri_ptr = webkit_web_view_get_uri(entry.webview);
                let title_ptr = webkit_web_view_get_title(entry.webview);
                let url = if uri_ptr.is_null() {
                    String::new()
                } else {
                    CStr::from_ptr(uri_ptr).to_string_lossy().into_owned()
                };
                let title = if title_ptr.is_null() {
                    String::new()
                } else {
                    CStr::from_ptr(title_ptr).to_string_lossy().into_owned()
                };
                Some(PreviewTabSnapshot {
                    tab_id: tab_id.to_string(),
                    url,
                    title,
                    can_go_back: webkit_web_view_can_go_back(entry.webview) != 0,
                    can_go_forward: webkit_web_view_can_go_forward(entry.webview) != 0,
                    zoom_factor: webkit_web_view_get_zoom_level(entry.webview),
                    color_scheme: entry.color_scheme.clone(),
                    audio_muted: webkit_web_view_get_is_muted(entry.webview) != 0,
                })
            }
        })
    }
}

fn with_preview_tab<F: FnOnce(&PreviewTabEntry)>(tab_id: &str, f: F) {
    GTK_UI.with(|cell| {
        if let Some(ui) = cell.borrow().as_ref() {
            if let Some(entry) = ui.preview_tabs.get(tab_id) {
                f(entry);
            }
        }
    });
}

fn run_file_chooser(action: c_int, options: FileDialogOptions) -> Vec<String> {
    GTK_UI.with(|cell| {
        let borrow = cell.borrow();
        let parent = borrow
            .as_ref()
            .map(|ui| ui.window)
            .unwrap_or(ptr::null_mut());
        let title = cstring(&options.title);
        let cancel_label = cstring("_Cancel");
        let open_label = cstring("_Open");

        unsafe {
            let dialog = gtk_file_chooser_dialog_new(
                title.as_ptr(),
                parent,
                action,
                cancel_label.as_ptr(),
                GTK_RESPONSE_CANCEL,
                open_label.as_ptr(),
                GTK_RESPONSE_ACCEPT,
                ptr::null::<c_char>(),
            );
            if dialog.is_null() {
                return Vec::new();
            }

            let chooser = dialog as *mut GtkFileChooser;
            if let Some(initial) = &options.initial_path {
                let c_path = cstring(initial);
                gtk_file_chooser_set_current_folder(chooser, c_path.as_ptr());
            }
            if options.multiple {
                gtk_file_chooser_set_select_multiple(chooser, 1);
            }

            let response = gtk_dialog_run(dialog as *mut GtkDialog);
            let mut results = Vec::new();
            if response == GTK_RESPONSE_ACCEPT {
                if options.multiple {
                    let list = gtk_file_chooser_get_filenames(chooser);
                    let mut node = list;
                    while !node.is_null() {
                        let ptr = (*node).data as *const c_char;
                        if !ptr.is_null() {
                            results.push(CStr::from_ptr(ptr).to_string_lossy().into_owned());
                        }
                        node = (*node).next;
                    }
                    if !list.is_null() {
                        g_slist_free_full(list, g_free);
                    }
                } else {
                    let filename = gtk_file_chooser_get_filename(chooser);
                    if !filename.is_null() {
                        results.push(CStr::from_ptr(filename).to_string_lossy().into_owned());
                        g_free(filename as *mut c_void);
                    }
                }
            }
            gtk_widget_destroy(dialog);
            results
        }
    })
}

/// Detects the Linux desktop color scheme directly via GIO D-Bus XDG Settings
/// Portal (`org.freedesktop.appearance.color-scheme`), falling back to
/// `GtkSettings` and `GTK_THEME`. No `dbus-next` or subprocesses required.
/// Cached briefly: each lookup is a blocking D-Bus round trip on the GTK thread, and a window
/// asks several times while it starts and opens previews.
pub fn detect_linux_color_scheme() -> ColorScheme {
    static CACHE: std::sync::Mutex<Option<(std::time::Instant, ColorScheme)>> =
        std::sync::Mutex::new(None);
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, scheme)) = *cache {
        if at.elapsed() < std::time::Duration::from_secs(2) {
            return scheme;
        }
    }
    let scheme = query_linux_color_scheme();
    *cache = Some((std::time::Instant::now(), scheme));
    scheme
}

fn query_linux_color_scheme() -> ColorScheme {
    if let Some(scheme) = query_xdg_portal_color_scheme() {
        return scheme;
    }
    if let Some(scheme) = query_gtk_settings_color_scheme() {
        return scheme;
    }
    if let Ok(theme) = env::var("GTK_THEME") {
        if is_dark_theme_name(&theme) {
            return ColorScheme::Dark;
        }
    }
    ColorScheme::Light
}

fn query_xdg_portal_color_scheme() -> Option<ColorScheme> {
    unsafe {
        let mut err: *mut GError = ptr::null_mut();
        let bus = g_bus_get_sync(G_BUS_TYPE_SESSION, ptr::null_mut(), &mut err);
        if !err.is_null() {
            g_error_free(err);
        }
        if bus.is_null() {
            return None;
        }

        let bus_name = cstring("org.freedesktop.portal.Desktop");
        let object_path = cstring("/org/freedesktop/portal/desktop");
        let iface = cstring("org.freedesktop.portal.Settings");
        let method_read_one = cstring("ReadOne");
        let method_read = cstring("Read");
        let ns = cstring("org.freedesktop.appearance");
        let key = cstring("color-scheme");

        let make_params = || {
            let children = [
                g_variant_new_string(ns.as_ptr()),
                g_variant_new_string(key.as_ptr()),
            ];
            g_variant_new_tuple(children.as_ptr(), children.len())
        };

        let mut call_err: *mut GError = ptr::null_mut();
        let mut reply = g_dbus_connection_call_sync(
            bus,
            bus_name.as_ptr(),
            object_path.as_ptr(),
            iface.as_ptr(),
            method_read_one.as_ptr(),
            make_params(),
            ptr::null(),
            0,
            250,
            ptr::null_mut(),
            &mut call_err,
        );
        if reply.is_null() {
            if !call_err.is_null() {
                g_error_free(call_err);
                call_err = ptr::null_mut();
            }
            reply = g_dbus_connection_call_sync(
                bus,
                bus_name.as_ptr(),
                object_path.as_ptr(),
                iface.as_ptr(),
                method_read.as_ptr(),
                make_params(),
                ptr::null(),
                0,
                250,
                ptr::null_mut(),
                &mut call_err,
            );
            if !call_err.is_null() {
                g_error_free(call_err);
            }
        }

        g_object_unref(bus as *mut c_void);
        if reply.is_null() {
            return None;
        }

        // Unwrap tuple `(v)` and any nested `v` (deprecated `Read` returns `(v)` wrapping `v`).
        let mut current = g_variant_get_child_value(reply, 0);
        g_variant_unref(reply);
        for _ in 0..3 {
            if current.is_null() {
                return None;
            }
            let ty = CStr::from_ptr(g_variant_get_type_string(current)).to_bytes();
            if ty == b"v" {
                let inner = g_variant_get_variant(current);
                g_variant_unref(current);
                current = inner;
            } else {
                break;
            }
        }

        let scheme = if !current.is_null()
            && CStr::from_ptr(g_variant_get_type_string(current)).to_bytes() == b"u"
        {
            match g_variant_get_uint32(current) {
                1 => Some(ColorScheme::Dark),
                0 | 2 => Some(ColorScheme::Light),
                _ => None,
            }
        } else {
            None
        };

        if !current.is_null() {
            g_variant_unref(current);
        }
        scheme
    }
}

fn query_gtk_settings_color_scheme() -> Option<ColorScheme> {
    unsafe {
        let settings = gtk_settings_get_default();
        if settings.is_null() {
            return None;
        }
        let mut prefer_dark: c_int = 0;
        let prop_dark = cstring("gtk-application-prefer-dark-theme");
        g_object_get(
            settings as *mut c_void,
            prop_dark.as_ptr(),
            &mut prefer_dark as *mut c_int,
            ptr::null::<c_void>(),
        );
        if prefer_dark != 0 {
            return Some(ColorScheme::Dark);
        }

        let mut theme_ptr: *mut c_char = ptr::null_mut();
        let prop_name = cstring("gtk-theme-name");
        g_object_get(
            settings as *mut c_void,
            prop_name.as_ptr(),
            &mut theme_ptr as *mut *mut c_char,
            ptr::null::<c_void>(),
        );
        if !theme_ptr.is_null() {
            let name = CStr::from_ptr(theme_ptr).to_string_lossy().into_owned();
            g_free(theme_ptr as *mut c_void);
            if is_dark_theme_name(&name) {
                return Some(ColorScheme::Dark);
            }
        }
        Some(ColorScheme::Light)
    }
}

fn is_dark_theme_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with("-dark") || lower.ends_with(":dark") || lower.contains("dark")
}

fn cstring(s: &str) -> CString {
    CString::new(s).unwrap_or_else(|_| CString::new(s.replace('\0', "")).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_dark_gtk_theme_names() {
        assert!(is_dark_theme_name("Adwaita-dark"));
        assert!(is_dark_theme_name("Adwaita:dark"));
        assert!(!is_dark_theme_name("Adwaita"));
    }
}

unsafe fn configure_webview(webview: *mut WebKitWebView, devtools: bool) {
    let settings = webkit_web_view_get_settings(webview);
    if devtools {
        webkit_settings_set_enable_developer_extras(settings, 1);
    }
    // On by default, it holds rendering near 60 fps on high-refresh displays; see refresh.rs.
    let features = webkit_settings_get_all_features();
    for i in 0..webkit_feature_list_get_length(features) {
        let feature = webkit_feature_list_get(features, i);
        if CStr::from_ptr(webkit_feature_get_identifier(feature))
            == c"PreferPageRenderingUpdatesNear60FPS"
        {
            webkit_settings_set_feature_enabled(settings, feature, 0);
        }
    }
    webkit_feature_list_unref(features);
}
