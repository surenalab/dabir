// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `dabir-check`, the wrapper Dabir puts on agents' PATH, runs this binary with `--check`: a quick
    // look at the paper for an agent, answered and exited before any window or plugin starts.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--check") {
        std::process::exit(dabir_lib::check::cli(&args[1..]));
    }
    dabir_lib::run()
}
