fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rest = args.get(1..).unwrap_or_default();
    let code = match args.first().map(String::as_str) {
        Some("pty") => t3_sys::pty::run(rest),
        Some("fuzzy") => t3_sys::fuzzy::run(rest),
        Some("flock") => t3_sys::flock::run(rest),
        Some("keyring") => t3_sys::keyring::run(rest),
        Some("--version") => {
            println!("t3-sys {}", env!("CARGO_PKG_VERSION"));
            0
        }
        _ => {
            eprintln!("usage: t3-sys pty|fuzzy|flock|keyring ...");
            2
        }
    };
    std::process::exit(code);
}
