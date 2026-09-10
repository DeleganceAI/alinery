// alinery-core: shared pure logic for tasks, sessions, config, harnesses, paths.
// Used by alinery-app, alineryd, and mcp.

pub mod artifact_tree;
pub mod backup;
pub mod daemon_client;
pub mod fs_atomic;
pub mod git;
pub mod history;
pub mod lockfile;
pub mod log;
pub mod message;
pub mod paths;
pub mod prompts;
pub mod protocol;
pub mod rpc_chunk;
pub mod settings;
pub mod shared;
pub mod storage;
pub mod subtask;
pub mod task;
pub mod telemetry;
pub mod types;

// Re-exports for convenience
pub use artifact_tree::*;
pub use backup::*;
pub use daemon_client::*;
pub use fs_atomic::{create_dir_owner_only, write_bytes_atomic, write_owner_only_bytes};
pub use git::*;
pub use history::*;
pub use lockfile::*;
pub use log::*;
pub use message::*;
pub use paths::*;
pub use prompts::*;
pub use protocol::*;
pub use rpc_chunk::*;
pub use settings::*;
pub use shared::*;
pub use storage::*;
pub use subtask::*;
pub use task::*;
pub use telemetry::*;
pub use types::*;
