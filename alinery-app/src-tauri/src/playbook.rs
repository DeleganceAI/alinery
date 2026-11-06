//! The files of a playbook library for the community import registry (`community_playbooks.rs`, S4.10). The library itself
//! (catalog, read, save, delete, picker, validate, render) is the daemon's `PlaybookService` since S4.6.
use crate::*;
use alinery_core::playbook_library::PlaybookRoots;

/// Where a command finds its playbook files. Bundled and global playbooks are always on this
/// machine. A repo's own playbooks are in place for a local repo; for a repo on another machine they
/// are a scratch copy that `with_library` fills from the host and writes back to.
pub(crate) struct Library {
    pub(crate) roots: PlaybookRoots,
    local_repo: Option<PathBuf>,
    remote: Option<RemoteLibrary>,
}

struct RemoteLibrary {
    host_id: String,
}

impl Library {
    pub(crate) fn has_repo(&self) -> bool {
        !self.roots.repo_dir.as_os_str().is_empty()
    }

    /// Changing a repo's library needs a repo this window owns, or a host that is connected.
    pub(crate) fn require_owned(&self, state: &AppState) -> Result<(), String> {
        match (&self.local_repo, &self.remote) {
            (Some(repo), _) => require_repo_owned(state, repo),
            (_, Some(remote)) => connected_session(state, &remote.host_id).map(|_| ()),
            _ => Ok(()),
        }
    }
}

/// Removes the scratch copy when the command is done with it.
struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Run `work` against the playbook files of `repo_path` (or the active repo, or none). A remote
/// repo's files are copied here first and whatever `work` changed is sent back, refused if the host's
/// copy moved in the meantime. This is the one place that knows a library can be on another machine,
/// so the library, the community import registry and the picker preferences all work unchanged.
pub(crate) fn with_library<T>(app: &AppHandle, repo_path: Option<&str>, work: impl FnOnce(&Library) -> T) -> Result<T, String> {
    let target = match repo_path {
        Some(path) => Some(target_repo_ref_for_app(app, path)?),
        None => active_repo_ref().ok(),
    };
    with_library_at(&app_config_path(app)?, &app.state::<AppState>(), target, work)
}

pub(crate) fn with_library_at<T>(app_config: &Path, state: &AppState, target: Option<RepoRef>, work: impl FnOnce(&Library) -> T) -> Result<T, String> {
    let global_config_dir = app_config_dir_of(app_config).ok_or("app config root unavailable")?.to_path_buf();
    match target {
        None => Ok(work(&Library {
            roots: PlaybookRoots {
                global_config_dir,
                repo_dir: PathBuf::new(),
            },
            local_repo: None,
            remote: None,
        })),
        Some(RepoRef::Local(repo)) => Ok(work(&Library {
            roots: PlaybookRoots {
                global_config_dir,
                repo_dir: repo.clone(),
            },
            local_repo: Some(repo),
            remote: None,
        })),
        Some(RepoRef::Remote { host_id, path }) => {
            let before: Vec<alinery_core::playbook_tree::TreeFile> = remote_call(state, &host_id, RepoOp::ReadPlaybookTree { repo: path.clone().into() })?;
            let scratch = Scratch(std::env::temp_dir().join(format!("alinery-library-{}", uuid::Uuid::new_v4())));
            let stage_repo = scratch.0.join("repo");
            fs::create_dir_all(&stage_repo).map_err(|error| error.to_string())?;
            alinery_core::playbook_tree::write_tree(&stage_repo, &before)?;
            let library = Library {
                roots: PlaybookRoots {
                    global_config_dir,
                    repo_dir: stage_repo.clone(),
                },
                local_repo: None,
                remote: Some(RemoteLibrary { host_id: host_id.clone() }),
            };
            let result = work(&library);
            let changes = alinery_core::playbook_tree::changes_since(&stage_repo, &before)?;
            if !changes.is_empty() {
                remote_call::<()>(state, &host_id, RepoOp::ApplyPlaybookTree { repo: path.into(), changes })?;
            }
            Ok(result)
        }
    }
}
