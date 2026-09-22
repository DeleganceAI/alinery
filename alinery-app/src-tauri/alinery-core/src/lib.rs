// alinery-core: shared pure logic for tasks, sessions, config, harnesses, paths.
// Used by alinery-app, alineryd, and mcp.

pub mod artifact_tree;
pub mod backup;
pub mod daemon_client;
pub mod execution;
pub mod fs_atomic;
pub mod git;
pub mod history;
pub mod hosted_inference;
pub mod lockfile;
pub mod log;
pub mod message;
pub mod paths;
pub mod playbook;
pub mod playbook_library;
pub mod playbook_scheduler;
pub mod prompts;
pub mod protocol;
pub mod rpc_chunk;
pub mod settings;
pub mod shared;
pub mod storage;
pub mod subtask;
pub mod task;
pub mod task_creation;
pub mod telemetry;
pub mod types;

// Re-exports for convenience
pub use artifact_tree::*;
pub use backup::*;
pub use daemon_client::*;
pub use execution::*;
pub use fs_atomic::{create_dir_owner_only, write_bytes_atomic, write_owner_only_bytes};
pub use git::*;
pub use history::*;
pub use hosted_inference::{
    ensure_hosted_inference_for_spawn, ensure_hosted_inference_for_spawn_at, hosted_models_yml_unavailable, inference_path, inference_spawn_cache_fresh, is_hosted_model,
    minted_catalog_if_unexpired, models_yml_path, pairing_config_dir, parse_hosted_catalog_body, parse_hosted_error, parse_inference_session_body, render_models_yml,
    revoke_hosted_inference, sync_hosted_inference, wipe_hosted_files, write_hosted_models_yml, write_inference_file, HostedApiError, HostedCatalog, HostedModel,
    HOSTED_MODEL_UNAVAILABLE,
};
pub use lockfile::*;
pub use log::*;
pub use message::*;
pub use paths::*;
pub use playbook::*;
pub use playbook_library::*;
pub use playbook_scheduler::*;
pub use protocol::*;
pub use rpc_chunk::*;
pub use settings::*;
pub use shared::*;
pub use storage::*;
pub use subtask::*;
pub use task::*;
pub use task_creation::*;
pub use telemetry::*;
pub use types::*;
