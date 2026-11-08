//! S0.5 sample: the Rust side of the flock interop test (../src/lock.test.ts). It only calls
//! alinery-core's public API, so the test exercises the same flock the app and MCP take.
//!
//!   lock-rs hold <path>          try_lock_exclusive, print "held", hold until stdin closes
//!   lock-rs try <path>           try_lock_exclusive once, print "acquired" or "busy", then
//!                                "locked_by_other <bool>" from is_locked_by_other
//!   lock-rs durable <dir> [n]    n x 1 KiB fs_atomic::write_bytes_durable, print p50/p99 in ms
use std::io::{Read, Write};
use std::path::Path;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |i: usize| args.get(i).map(String::as_str).unwrap_or_else(|| usage());
    match arg(1) {
        "hold" => hold(Path::new(arg(2))),
        "try" => try_once(Path::new(arg(2))),
        "durable" => durable(Path::new(arg(2)), args.get(3).and_then(|n| n.parse().ok()).unwrap_or(1000)),
        _ => usage(),
    }
}

fn usage() -> ! {
    eprintln!("usage: lock-rs hold <path> | try <path> | durable <dir> [n]");
    std::process::exit(2)
}

fn hold(path: &Path) {
    let lock = match alinery_core::try_lock_exclusive(path) {
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
    // The parent decides how long the lock is held: closing our stdin releases it.
    let _ = std::io::stdin().read_to_end(&mut Vec::new());
    drop(lock);
    println!("released");
}

fn try_once(path: &Path) {
    match alinery_core::try_lock_exclusive(path) {
        Ok(Some(lock)) => {
            println!("acquired");
            drop(lock);
        }
        Ok(None) => println!("busy"),
        Err(e) => {
            println!("error {e}");
            std::process::exit(1)
        }
    }
    println!("locked_by_other {}", alinery_core::is_locked_by_other(path));
}

fn durable(dir: &Path, n: usize) {
    let path = dir.join("rust-durable.json");
    let bytes = vec![b'x'; 1024];
    let mut ms = Vec::with_capacity(n);
    for _ in 0..20 {
        alinery_core::fs_atomic::write_bytes_durable(&path, &bytes).unwrap();
    }
    for _ in 0..n {
        let start = Instant::now();
        alinery_core::fs_atomic::write_bytes_durable(&path, &bytes).unwrap();
        ms.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pick = |q: f64| ms[((ms.len() as f64 * q).ceil() as usize).saturating_sub(1)];
    let mean = ms.iter().sum::<f64>() / ms.len() as f64;
    println!(
        "{{\"mode\":\"rust write_bytes_durable\",\"n\":{n},\"p50_ms\":{:.3},\"p99_ms\":{:.3},\"mean_ms\":{:.3}}}",
        pick(0.5),
        pick(0.99),
        mean
    );
}
