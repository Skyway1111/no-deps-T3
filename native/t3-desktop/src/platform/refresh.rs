//! High-refresh rendering for WebKitGTK on GTK3 + NVIDIA. Three 60 fps caps stand in the way:
//!
//! 1. WebKit paces frames with `drmWaitVBlank` on the CRTC whose connector size equals
//!    `gdk_monitor_get_{width,height}_mm` exactly, else a fixed 60 fps timer. This executable
//!    exports those symbols: sizes snap to the nearest DRM connector, and an unsupported wait
//!    (NVIDIA) becomes an absolute-deadline sleep at the CRTC's exact mode rate.
//! 2. GTK3 requests no Wayland frame callback after GL paints (WebKit's path), so its frame clock
//!    free-runs at a hardcoded 16667 µs; `pace_frame_clock` feeds it the monitor's real interval.
//! 3. WebKit's `PreferPageRenderingUpdatesNear60FPS` feature, disabled in `configure_webview`.

use std::ffi::{c_char, c_int, c_long, c_uint, c_ulong, c_void, CStr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;

const RTLD_DEFAULT: *mut c_void = std::ptr::null_mut();
const RTLD_NEXT: *mut c_void = -1isize as *mut c_void;
const EOPNOTSUPP: c_int = 95;
const CLOCK_MONOTONIC: c_int = 1;
const TIMER_ABSTIME: c_int = 1;
const DRM_VBLANK_RELATIVE: c_uint = 0x1;
const DRM_VBLANK_SECONDARY: c_uint = 0x2000_0000;
const DRM_VBLANK_HIGH_CRTC_MASK: c_uint = 0x3e;
const DRM_MODE_CONNECTED: c_int = 1;

extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn clock_gettime(clock: c_int, ts: *mut Timespec) -> c_int;
    fn clock_nanosleep(
        clock: c_int,
        flags: c_int,
        req: *const Timespec,
        rem: *mut Timespec,
    ) -> c_int;
    fn __errno_location() -> *mut c_int;
    fn open(path: *const c_char, flags: c_int, ...) -> c_int;
    fn close(fd: c_int) -> c_int;
    fn g_signal_connect_data(
        instance: *mut c_void,
        signal: *const c_char,
        handler: *const c_void,
        data: *mut c_void,
        destroy: *const c_void,
        flags: c_uint,
    ) -> c_ulong;
    fn gtk_widget_get_frame_clock(widget: *mut c_void) -> *mut c_void;
    fn gtk_widget_get_window(widget: *mut c_void) -> *mut c_void;
    fn gdk_window_get_display(window: *mut c_void) -> *mut c_void;
    fn gdk_display_get_monitor_at_window(display: *mut c_void, window: *mut c_void) -> *mut c_void;
    fn gdk_monitor_get_refresh_rate(monitor: *mut c_void) -> c_int;
    fn gdk_frame_clock_get_current_timings(clock: *mut c_void) -> *mut c_void;
    fn gdk_frame_timings_get_refresh_interval(timings: *mut c_void) -> i64;
}

#[repr(C)]
#[derive(Default)]
struct Timespec {
    sec: c_long,
    nsec: c_long,
}

#[repr(C)]
pub struct DrmVBlank {
    kind: c_uint,
    sequence: c_uint,
    // request: `signal: c_ulong`; reply: `tval_sec, tval_usec: c_long`.
    tval_sec: c_long,
    tval_usec: c_long,
}

#[repr(C)]
struct DrmModeRes {
    count_fbs: c_int,
    fbs: *mut u32,
    count_crtcs: c_int,
    crtcs: *mut u32,
    count_connectors: c_int,
    connectors: *mut u32,
}

#[repr(C)]
struct DrmModeConnector {
    connector_id: u32,
    encoder_id: u32,
    connector_type: u32,
    connector_type_id: u32,
    connection: c_int,
    mm_width: u32,
    mm_height: u32,
}

#[repr(C)]
struct DrmModeCrtc {
    crtc_id: u32,
    buffer_id: u32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    mode_valid: c_int,
    clock_khz: u32,
    hdisplay: u16,
    hsync_start: u16,
    hsync_end: u16,
    htotal: u16,
    hskew: u16,
    vdisplay: u16,
    vsync_start: u16,
    vsync_end: u16,
    vtotal: u16,
}

struct Drm {
    get_resources: unsafe extern "C" fn(c_int) -> *mut DrmModeRes,
    free_resources: unsafe extern "C" fn(*mut DrmModeRes),
    get_connector: unsafe extern "C" fn(c_int, u32) -> *mut DrmModeConnector,
    free_connector: unsafe extern "C" fn(*mut DrmModeConnector),
    get_crtc: unsafe extern "C" fn(c_int, u32) -> *mut DrmModeCrtc,
    free_crtc: unsafe extern "C" fn(*mut DrmModeCrtc),
}

unsafe fn sym<T>(handle: *mut c_void, name: &CStr) -> Option<T> {
    let p = dlsym(handle, name.as_ptr());
    (!p.is_null()).then(|| std::mem::transmute_copy(&p))
}

/// libdrm is already loaded by WebKit; resolve at runtime so building needs no libdrm headers.
fn drm() -> Option<&'static Drm> {
    static DRM: OnceLock<Option<Drm>> = OnceLock::new();
    DRM.get_or_init(|| unsafe {
        Some(Drm {
            get_resources: sym(RTLD_DEFAULT, c"drmModeGetResources")?,
            free_resources: sym(RTLD_DEFAULT, c"drmModeFreeResources")?,
            get_connector: sym(RTLD_DEFAULT, c"drmModeGetConnector")?,
            free_connector: sym(RTLD_DEFAULT, c"drmModeFreeConnector")?,
            get_crtc: sym(RTLD_DEFAULT, c"drmModeGetCrtc")?,
            free_crtc: sym(RTLD_DEFAULT, c"drmModeFreeCrtc")?,
        })
    })
    .as_ref()
}

/// Physical sizes (mm) of every connected connector on every DRM card.
fn connector_sizes() -> &'static [(u32, u32)] {
    static SIZES: OnceLock<Vec<(u32, u32)>> = OnceLock::new();
    SIZES.get_or_init(|| {
        let mut sizes = Vec::new();
        let Some(drm) = drm() else { return sizes };
        for card in 0..16 {
            let path = format!("/dev/dri/card{card}\0");
            unsafe {
                let fd = open(path.as_ptr().cast(), 0o2000002); // O_RDWR | O_CLOEXEC
                if fd < 0 {
                    continue;
                }
                let res = (drm.get_resources)(fd);
                if !res.is_null() {
                    let r = &*res;
                    for i in 0..r.count_connectors.max(0) as usize {
                        let c = (drm.get_connector)(fd, *r.connectors.add(i));
                        if c.is_null() {
                            continue;
                        }
                        if (*c).connection == DRM_MODE_CONNECTED && (*c).mm_width > 0 {
                            sizes.push(((*c).mm_width, (*c).mm_height));
                        }
                        (drm.free_connector)(c);
                    }
                    (drm.free_resources)(res);
                }
                close(fd);
            }
        }
        sizes
    })
}

type MonitorMm = unsafe extern "C" fn(*mut c_void) -> c_int;

fn real_monitor_mm(monitor: *mut c_void) -> Option<(u32, u32)> {
    static FNS: OnceLock<Option<(MonitorMm, MonitorMm)>> = OnceLock::new();
    let (w, h) = (*FNS.get_or_init(|| unsafe {
        Some((
            sym(RTLD_NEXT, c"gdk_monitor_get_width_mm")?,
            sym(RTLD_NEXT, c"gdk_monitor_get_height_mm")?,
        ))
    }))?;
    unsafe { Some((w(monitor).max(0) as u32, h(monitor).max(0) as u32)) }
}

/// Compositors and the kernel round EDID sizes differently (597x336 vs 600x340); snap to the
/// nearest connector within 5% so WebKit's exact-equality match succeeds.
fn snapped_monitor_mm(monitor: *mut c_void) -> (u32, u32) {
    let Some(real) = real_monitor_mm(monitor) else {
        return (0, 0);
    };
    let close = |a: u32, b: u32| a.abs_diff(b) * 20 <= a.max(b);
    connector_sizes()
        .iter()
        .copied()
        .filter(|&(w, h)| close(w, real.0) && close(h, real.1))
        .min_by_key(|&(w, h)| w.abs_diff(real.0) + h.abs_diff(real.1))
        .unwrap_or(real)
}

#[no_mangle]
pub extern "C" fn gdk_monitor_get_width_mm(monitor: *mut c_void) -> c_int {
    snapped_monitor_mm(monitor).0 as c_int
}

#[no_mangle]
pub extern "C" fn gdk_monitor_get_height_mm(monitor: *mut c_void) -> c_int {
    snapped_monitor_mm(monitor).1 as c_int
}

/// Exact frame period of CRTC `index` in ns (pixel clock / total pixels), cached per index.
fn crtc_period_ns(fd: c_int, index: usize) -> u64 {
    static PERIODS: [AtomicU64; 32] = [const { AtomicU64::new(0) }; 32];
    let slot = &PERIODS[index.min(31)];
    let cached = slot.load(Ordering::Relaxed);
    if cached != 0 {
        return cached;
    }
    let mut period = 1_000_000_000 / 60;
    if let Some(drm) = drm() {
        unsafe {
            let res = (drm.get_resources)(fd);
            if !res.is_null() {
                if index < (*res).count_crtcs.max(0) as usize {
                    let crtc = (drm.get_crtc)(fd, *(*res).crtcs.add(index));
                    if !crtc.is_null() {
                        let c = &*crtc;
                        let pixels = u64::from(c.htotal) * u64::from(c.vtotal);
                        if c.mode_valid != 0 && c.clock_khz > 0 && pixels > 0 {
                            period = pixels * 1_000_000 / u64::from(c.clock_khz);
                        }
                        (drm.free_crtc)(crtc);
                    }
                }
                (drm.free_resources)(res);
            }
        }
    }
    slot.store(period, Ordering::Relaxed);
    period
}

fn now_ns() -> u64 {
    let mut ts = Timespec::default();
    unsafe { clock_gettime(CLOCK_MONOTONIC, &mut ts) };
    ts.sec as u64 * 1_000_000_000 + ts.nsec as u64
}

type WaitVBlank = unsafe extern "C" fn(c_int, *mut DrmVBlank) -> c_int;

#[no_mangle]
pub unsafe extern "C" fn drmWaitVBlank(fd: c_int, vbl: *mut DrmVBlank) -> c_int {
    static REAL: OnceLock<Option<WaitVBlank>> = OnceLock::new();
    let Some(real) = *REAL.get_or_init(|| sym(RTLD_NEXT, c"drmWaitVBlank")) else {
        return -EOPNOTSUPP;
    };
    static UNSUPPORTED: AtomicBool = AtomicBool::new(false);
    let (kind, count) = ((*vbl).kind, (*vbl).sequence);
    if !UNSUPPORTED.load(Ordering::Relaxed) {
        let ret = real(fd, vbl);
        if ret == 0 || *__errno_location() != EOPNOTSUPP {
            return ret;
        }
        UNSUPPORTED.store(true, Ordering::Relaxed);
    }
    if kind & DRM_VBLANK_RELATIVE == 0 {
        return real(fd, vbl);
    }
    let index = if kind & DRM_VBLANK_SECONDARY != 0 {
        1
    } else {
        ((kind & DRM_VBLANK_HIGH_CRTC_MASK) >> 1) as usize
    };
    let period = crtc_period_ns(fd, index);
    // Ticks sit on a fixed grid so per-call latency cannot accumulate into drift.
    let tick = now_ns() / period + u64::from(count);
    let deadline = tick * period;
    let ts = Timespec {
        sec: (deadline / 1_000_000_000) as c_long,
        nsec: (deadline % 1_000_000_000) as c_long,
    };
    while clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &ts, std::ptr::null_mut()) != 0 {}
    *vbl = DrmVBlank {
        kind,
        sequence: tick as c_uint,
        tval_sec: ts.sec,
        tval_usec: ts.nsec / 1000,
    };
    0
}

/// Call once the toplevel is realized; the window shares one frame clock with every web view in it.
pub unsafe fn pace_frame_clock(toplevel: *mut c_void) {
    let clock = gtk_widget_get_frame_clock(toplevel);
    if !clock.is_null() {
        let handler = on_after_paint as unsafe extern "C" fn(*mut c_void, *mut c_void);
        g_signal_connect_data(
            clock,
            c"after-paint".as_ptr(),
            handler as *const c_void,
            toplevel,
            std::ptr::null(),
            0,
        );
    }
}

/// GTK reads the previous frame's `refresh_interval` to space the next cycle.
unsafe extern "C" fn on_after_paint(clock: *mut c_void, toplevel: *mut c_void) {
    let timings = gdk_frame_clock_get_current_timings(clock);
    let window = gtk_widget_get_window(toplevel);
    if timings.is_null() || window.is_null() {
        return;
    }
    let monitor = gdk_display_get_monitor_at_window(gdk_window_get_display(window), window);
    let millihertz = if monitor.is_null() {
        0
    } else {
        gdk_monitor_get_refresh_rate(monitor)
    };
    if let (Some(field), true) = (refresh_interval_field(timings), millihertz > 0) {
        *field = 1_000_000_000 / i64::from(millihertz);
    }
}

/// `GdkFrameTimings` is private and gained a field mid-3.24, so locate `refresh_interval` once
/// through its public getter: write a sentinel at each candidate offset and restore it.
unsafe fn refresh_interval_field(timings: *mut c_void) -> Option<*mut i64> {
    static OFFSET: OnceLock<Option<usize>> = OnceLock::new();
    let offset = (*OFFSET.get_or_init(|| {
        (8..=56).step_by(8).find(|&offset| {
            let field = timings.cast::<u8>().add(offset).cast::<i64>();
            let saved = *field;
            *field = 0x5EED_F00D;
            let hit = gdk_frame_timings_get_refresh_interval(timings) == 0x5EED_F00D;
            *field = saved;
            hit
        })
    }))?;
    Some(timings.cast::<u8>().add(offset).cast::<i64>())
}
