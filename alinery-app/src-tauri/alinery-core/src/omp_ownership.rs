//! Compatibility barrier for pre-lease Alinery processes. This is not a sandbox:
//! after rollout, older builds must not be started against the same installation.
use std::fs;
use std::path::{Path, PathBuf};

const UNKNOWN: &str =
    "OMP ownership cannot be established; close older Alinery processes sharing this installation, then refresh. Do not subsequently run older builds against this home.";

struct Process {
    pid: i32,
    start: String,
    executable: PathBuf,
    executable_known: bool,
    app_config_argument: Option<Vec<u8>>,
    environment: Vec<Vec<u8>>,
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) }
}

#[cfg(target_os = "macos")]
fn pids() -> Result<Vec<i32>, String> {
    let uid = unsafe { libc::geteuid() };
    const PROC_UID_ONLY: u32 = 4; // sys/proc_info.h: effective UID (5 is real UID).
    let count = unsafe { libc::proc_listpids(PROC_UID_ONLY, uid, std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Err(UNKNOWN.into());
    }
    let mut pids = vec![0i32; count as usize / std::mem::size_of::<i32>() + 1024];
    let bytes = unsafe { libc::proc_listpids(PROC_UID_ONLY, uid, pids.as_mut_ptr().cast(), std::mem::size_of_val(pids.as_slice()) as i32) };
    if bytes <= 0 || bytes as usize >= std::mem::size_of_val(pids.as_slice()) {
        return Err(UNKNOWN.into());
    }
    pids.truncate(bytes as usize / std::mem::size_of::<i32>());
    Ok(pids)
}

#[cfg(target_os = "linux")]
fn pids() -> Result<Vec<i32>, String> {
    fs::read_dir("/proc")
        .map_err(|_| UNKNOWN.to_string())?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name().to_str().and_then(|name| name.parse().ok()))
                .map_err(|_| UNKNOWN.to_string())
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|entries| entries.into_iter().flatten().collect())
}

fn cooperating_launcher(executable: &Path) -> bool {
    executable
        .file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|name| matches!(name, "alineryd" | "alinery-runner" | "Alinery" | "alinery") || name.starts_with("alineryd-") || name.starts_with("alinery-runner-"))
}

#[cfg(target_os = "macos")]
fn inspect(pid: i32) -> Result<Option<Process>, String> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info);
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size as i32) };
    if n != size as i32 {
        let errno = std::io::Error::last_os_error().raw_os_error();
        if errno == Some(libc::ESRCH) || !alive(pid) {
            return Ok(None);
        }
        return Err(format!("{UNKNOWN} (process {pid}: native identity unavailable, errno {errno:?})"));
    }
    if info.pbi_uid != unsafe { libc::geteuid() } {
        return Ok(None);
    }
    if info.pbi_status == 5 {
        return Ok(None);
    } // Darwin SZOMB: cannot launch or save settings.
    let comm = info.pbi_comm.map(|b| b as u8);
    let mut path = vec![0u8; 4096];
    let n = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    if n <= 0 && !alive(pid) {
        return Ok(None);
    }
    use std::os::unix::ffi::OsStrExt;
    let executable_known = n > 0;
    let executable = PathBuf::from(std::ffi::OsStr::from_bytes(if executable_known {
        path.split(|b| *b == 0).next().unwrap_or_default()
    } else {
        comm.split(|b| *b == 0).next().unwrap_or_default()
    }));
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut bytes = vec![0u8; 1024 * 1024];
    let mut len = bytes.len();
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, bytes.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) } != 0 {
        let errno = std::io::Error::last_os_error().raw_os_error();
        if errno == Some(libc::ESRCH) || !alive(pid) {
            return Ok(None);
        }
        return Err(format!("{UNKNOWN} (process {pid}: installation identity unavailable, errno {errno:?})"));
    }
    bytes.truncate(len);
    if bytes.len() < 4 {
        return Err(UNKNOWN.into());
    }
    let argc = i32::from_ne_bytes(bytes[..4].try_into().map_err(|_| UNKNOWN)?);
    if argc < 0 {
        return Err(UNKNOWN.into());
    }
    let rest = &bytes[4..];
    let end = rest.iter().position(|b| *b == 0).ok_or(UNKNOWN)?;
    let mut parts = rest[end..].split(|b| *b == 0).skip_while(|part| part.is_empty());
    let app_config_argument = config_argument(parts.by_ref().take(argc as usize));
    let environment = parts.filter(|part| identity_variable(part)).map(<[u8]>::to_vec).collect();
    Ok(Some(Process {
        pid,
        start: format!("{}-{}", info.pbi_start_tvsec, info.pbi_start_tvusec),
        executable,
        executable_known,
        app_config_argument,
        environment,
    }))
}

#[cfg(target_os = "linux")]
fn inspect(pid: i32) -> Result<Option<Process>, String> {
    use std::os::unix::fs::MetadataExt;
    let root = PathBuf::from(format!("/proc/{pid}"));
    let metadata = match fs::metadata(&root) {
        Ok(m) => m,
        Err(_) if !alive(pid) => return Ok(None),
        Err(_) => return Err(UNKNOWN.into()),
    };
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Ok(None);
    }
    let stat = fs::read_to_string(root.join("stat")).map_err(|_| UNKNOWN)?;
    let comm = stat.split_once(" (").and_then(|(_, rest)| rest.rsplit_once(") ").map(|(comm, _)| comm)).ok_or(UNKNOWN)?;
    if stat.rsplit_once(") ").is_some_and(|(_, fields)| fields.starts_with("Z ")) {
        return Ok(None);
    }
    let native_path = fs::read_link(root.join("exe")).ok();
    let executable_known = native_path.as_ref().is_some_and(|p| !p.as_os_str().as_encoded_bytes().ends_with(b" (deleted)"));
    let executable = if executable_known { native_path.unwrap() } else { PathBuf::from(comm) };
    let start = stat.rsplit_once(") ").and_then(|(_, fields)| fields.split_whitespace().nth(19)).ok_or(UNKNOWN)?.to_string();
    let arguments = fs::read(root.join("cmdline")).map_err(|_| UNKNOWN)?;
    let app_config_argument = config_argument(arguments.split(|b| *b == 0));
    drop(arguments);
    let environment = fs::read(root.join("environ"))
        .map_err(|_| UNKNOWN)?
        .split(|b| *b == 0)
        .filter(|part| identity_variable(part))
        .map(<[u8]>::to_vec)
        .collect();
    Ok(Some(Process {
        pid,
        start,
        executable,
        executable_known,
        app_config_argument,
        environment,
    }))
}

// Kernel argument/environment buffers are unavoidable. Retain only installation
// identity, never a process's command text, provider credentials, or other data.
fn config_argument<'a>(arguments: impl Iterator<Item = &'a [u8]>) -> Option<Vec<u8>> {
    let mut follows_key = false;
    let mut config = None;
    for argument in arguments {
        if follows_key && !argument.is_empty() && config.is_none() {
            config = Some(argument.to_vec());
        }
        follows_key = argument == b"--app-config";
    }
    config
}

fn identity_variable(entry: &[u8]) -> bool {
    [b"ALINERY_APP_CONFIG=".as_slice(), b"PI_CODING_AGENT_DIR=", b"PI_CONFIG_DIR=", b"ALINERY_DEV_LAUNCH_ROOT="]
        .iter()
        .any(|key| entry.starts_with(key))
}

fn env<'a>(process: &'a Process, key: &[u8]) -> Option<&'a [u8]> {
    process
        .environment
        .iter()
        .find_map(|entry| entry.strip_prefix(key).and_then(|value| value.strip_prefix(b"=")))
}

fn same_path(bytes: &[u8], expected: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let path = Path::new(std::ffi::OsStr::from_bytes(bytes));
    let canonical = |path: &Path| fs::canonicalize(path).ok().or_else(|| Some(fs::canonicalize(path.parent()?).ok()?.join(path.file_name()?)));
    path == expected || canonical(path).zip(canonical(expected)).is_some_and(|(a, b)| a == b)
}

fn marker(root: &Path, process: &Process) -> PathBuf {
    root.join("owners").join(format!("{}-{}", process.pid, process.start))
}

pub(crate) fn register(root: &Path) -> Result<(), String> {
    let process = inspect(std::process::id() as i32)?.ok_or(UNKNOWN)?;
    if !process.executable_known {
        return Err(UNKNOWN.into());
    }
    fs::create_dir_all(root.join("owners")).map_err(|_| UNKNOWN)?;
    // Exec preserves PID/start. Bind cooperation to this native executable too,
    // so a runner's registration cannot bless the runtime it later execs.
    fs::write(marker(root, &process), process.executable.as_os_str().as_encoded_bytes()).map_err(|_| UNKNOWN.to_string())
}

pub(crate) fn check(app_config: &Path, root: &Path) -> Result<(), String> {
    let (agent, config) = crate::omp_home_dirs(app_config);
    for pid in pids()? {
        if pid <= 0 || pid == std::process::id() as i32 {
            continue;
        }
        let Some(process) = inspect(pid)? else {
            continue;
        };
        let name = process.executable.file_name().and_then(|name| name.to_str()).unwrap_or_default();
        let explicit = env(&process, b"ALINERY_APP_CONFIG").or(process.app_config_argument.as_deref());
        let managed = env(&process, b"PI_CODING_AGENT_DIR")
            .map(|p| same_path(p, &agent))
            .or_else(|| env(&process, b"PI_CONFIG_DIR").map(|p| same_path(p, &config)));
        let matches = if explicit.is_some() || managed.is_some() {
            explicit.is_some_and(|path| same_path(path, app_config)) || managed == Some(true)
        } else if matches!(name, "Alinery" | "alinery") {
            // Older app builds have no app-config argument. Production has one stable
            // config identity; development instances retain their launch-root discriminator.
            if let Some(launch_root) = env(&process, b"ALINERY_DEV_LAUNCH_ROOT") {
                use std::os::unix::ffi::OsStrExt;
                let id = crate::app_config_identity(Path::new(std::ffi::OsStr::from_bytes(launch_root)));
                crate::app_config_toml_path_for(crate::DEVELOPMENT_APP_IDENTIFIER)
                    .and_then(|p| p.parent().map(|p| p.join("instances").join(id).join("app.toml")))
                    .is_some_and(|p| same_path(p.as_os_str().as_encoded_bytes(), app_config))
            } else {
                crate::app_config_toml_path().is_some_and(|p| same_path(p.as_os_str().as_encoded_bytes(), app_config))
                    || crate::app_config_toml_path_for(crate::DEVELOPMENT_APP_IDENTIFIER)
                        .and_then(|p| p.parent().map(|p| p.join("instances/unknown/app.toml")))
                        .is_some_and(|p| same_path(p.as_os_str().as_encoded_bytes(), app_config))
            }
        } else if !cooperating_launcher(&process.executable) {
            // No managed identity: this is an unrelated process or a personal OMP.
            false
        } else {
            return Err(format!("{UNKNOWN} (process {pid}: no installation identity)"));
        };
        if !matches {
            continue;
        }
        if !process.executable_known {
            return Err(format!("{UNKNOWN} (process {pid}: executable identity unavailable)"));
        }
        if !cooperating_launcher(&process.executable) || fs::read(marker(root, &process)).ok().as_deref() != Some(process.executable.as_os_str().as_encoded_bytes()) {
            return Err(format!("{UNKNOWN} (process {pid}: unregistered installation owner)"));
        }
        // Neither PID reuse nor exec during inspection inherits cooperation.
        if inspect(pid)?.is_some_and(|fresh| fresh.start != process.start || !fresh.executable_known || fresh.executable != process.executable) {
            return Err(UNKNOWN.into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Child, Command, Stdio};

    struct LegacyOwner {
        root: PathBuf,
        child: Child,
    }
    impl Drop for LegacyOwner {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    #[ignore = "subprocess fixture, invoked by the ownership regression"]
    fn legacy_owner_child() {
        if let Some(target) = std::env::var_os("ALINERY_TEST_EXEC_TARGET") {
            use std::os::unix::process::CommandExt;
            let app = PathBuf::from(std::env::var_os("ALINERY_APP_CONFIG").unwrap());
            register(crate::omp_home_dirs(&app).1.parent().unwrap()).unwrap();
            let error = Command::new(target)
                .env_remove("ALINERY_TEST_EXEC_TARGET")
                .args(["--exact", "omp_ownership::tests::legacy_owner_child", "--ignored", "--nocapture"])
                .exec();
            panic!("fixture exec failed: {error}");
        }
        assert!(std::env::var_os("ALINERY_APP_CONFIG").is_some() || std::env::var_os("PI_CODING_AGENT_DIR").is_some());
        println!("fixture-ready");
        std::io::stdout().flush().unwrap();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
    }

    #[test]
    fn omp_config_legacy_owner_blocks_only_shared_installation() {
        for (name, launcher) in [("alineryd-aarch64-apple-darwin", true), ("custom-runtime", false), ("alinery-runner", false)] {
            let root = std::env::temp_dir().join(format!("alinery-legacy-owner-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let binary = root.join(name);
            fs::copy(std::env::current_exe().unwrap(), &binary).unwrap();
            let app = root.join("app.toml");
            let mut command = Command::new(&binary);
            command.env_clear();
            if name == "alinery-runner" {
                let target = root.join("alineryd-custom");
                fs::copy(std::env::current_exe().unwrap(), &target).unwrap();
                command.env("ALINERY_APP_CONFIG", &app).env("ALINERY_TEST_EXEC_TARGET", target);
            }
            if launcher {
                command.env("ALINERY_APP_CONFIG", &app);
            } else {
                command.env("PI_CODING_AGENT_DIR", crate::omp_home_dirs(&app).0);
            }
            let child = command
                .args(["--exact", "omp_ownership::tests::legacy_owner_child", "--ignored", "--nocapture"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let mut owner = LegacyOwner { root, child };
            let stdout = owner.child.stdout.take().unwrap();
            let (send, recv) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if line == "fixture-ready" {
                        let _ = send.send(());
                        break;
                    }
                }
            });
            recv.recv_timeout(std::time::Duration::from_secs(3)).expect("native legacy fixture readiness");
            let coordination = owner.root.join("omp");
            assert!(check(&app, &coordination).is_err(), "{name} must block edits to its managed home");
            let other = owner.root.join("other/app.toml");
            check(&other, &owner.root.join("other/omp")).unwrap();
            let process = inspect(owner.child.id() as i32).unwrap().unwrap();
            fs::create_dir_all(coordination.join("owners")).unwrap();
            let registered_executable = if launcher { &process.executable } else { &binary };
            fs::write(marker(&coordination, &process), registered_executable.as_os_str().as_encoded_bytes()).unwrap();
            if launcher {
                check(&app, &coordination).unwrap();
            } else {
                // A runner marker surviving exec never makes an arbitrary runtime
                // a cooperating launcher; the live shared-home writer still blocks.
                assert!(check(&app, &coordination).is_err());
            }
            fs::write(marker(&coordination, &process), b"obsolete").unwrap();
            assert!(check(&app, &coordination).is_err());
            fs::remove_file(&binary).unwrap();
            check(&other, &owner.root.join("other/omp")).unwrap();
            assert!(check(&app, &coordination).is_err());
        }
    }
}
