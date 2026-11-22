fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rest = args.get(1..).unwrap_or_default();
    let code = match args.first().map(String::as_str) {
        Some("pty") => t3_sys::pty::run(rest),
        Some("fuzzy") => t3_sys::fuzzy::run(rest),
        Some("flock") => t3_sys::flock::run(rest),
        Some("keyring") => t3_sys::keyring::run(rest),
        Some("clonefile") => t3_sys::clonefile::run(rest),
        Some("reg-read") => t3_sys::registry::run(rest),
        Some("win") => t3_sys::win::run(rest),
        Some("--version") => {
            println!("t3-sys {}", env!("CARGO_PKG_VERSION"));
            0
        }
        _ => {
            eprintln!("usage: t3-sys pty|fuzzy|flock|keyring|clonefile|reg-read|win ...");
            2
        }
    };
    std::process::exit(code);
}
