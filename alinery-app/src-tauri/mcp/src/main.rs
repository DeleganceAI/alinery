//! `alinery-mcp`: the remote repo service, and only that. The MCP server itself is `alinery-vinculum-daemon --mcp` (plan S5.1, O10 b).

mod repo_service;

use clap::Parser;
use std::io;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Serve the remote repo service on stdin/stdout (see alinery_core::repo_service).
    #[arg(long)]
    repo_service: bool,
}

fn main() {
    if Args::parse().repo_service {
        repo_service::serve(io::stdin().lock(), io::stdout());
        return;
    }
    eprintln!("Usage: alinery-mcp --repo-service");
    std::process::exit(2);
}
