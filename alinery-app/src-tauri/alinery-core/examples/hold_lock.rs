//! Test helper for the daemon's flock tests (vinculum-daemon/src/platform/lock.test.ts): takes
//! `try_lock_exclusive` on the path, prints "held", and holds it until stdin closes. Calling the
//! real lockfile.rs here is the point: the TypeScript side must exclude and be excluded by it.
use std::io::{Read, Write};
use std::path::Path;

fn main() {
    let path = std::env::args().nth(1).expect("usage: hold_lock <path>");
    let lock = match alinery_core::try_lock_exclusive(Path::new(&path)) {
        Ok(Some(lock)) => lock,
        Ok(None) => {
            println!("busy");
            std::process::exit(3)
        }
        Err(e) => {
            println!("error {e}");
            std::process::exit(1)
        }
    };
    println!("held");
    std::io::stdout().flush().unwrap();
    let _ = std::io::stdin().read_to_end(&mut Vec::new());
    drop(lock);
}
