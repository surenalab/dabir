//! The same check the app runs as `dabir --check`, built without the app around it.

#[allow(dead_code)] // the app uses more of the module than the command line does
#[path = "../src/check.rs"]
mod check;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(check::cli(&args));
}
