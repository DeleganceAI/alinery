use alinery_core::PollerAction;

#[test]
fn nothing_on_the_socket_restarts_the_pair_and_never_spawns_release() {
    assert!(matches!(alinery_core::poller_action(None), PollerAction::Spawn));
    assert!(matches!(alinery_core::poller_action(Some(alinery_core::DaemonCompat::Current)), PollerAction::Leave));
    assert!(matches!(
        alinery_core::poller_action(Some(alinery_core::DaemonCompat::ProtocolMismatch)),
        PollerAction::SurfaceConflict
    ));
}

#[test]
fn the_local_runtime_unpacks_python_and_skills_and_only_the_newest_older_one_stays() {
    let base = std::env::temp_dir().join(format!("alinery-python-unpack-{}", uuid::Uuid::new_v4()));
    let source = base.join("source");
    std::fs::create_dir_all(source.join("python/bin")).unwrap();
    std::fs::write(source.join("python/bin/python3"), b"").unwrap();
    std::fs::create_dir_all(source.join("skills/pdf")).unwrap();
    std::fs::write(source.join("skills/pdf/SKILL.md"), b"---\n").unwrap();
    std::fs::write(source.join("alinery-vinculum-daemon"), b"daemon").unwrap();
    let archive = base.join("rt.tar.gz");
    let packed = std::process::Command::new("tar")
        .arg("-czf")
        .arg(&archive)
        .arg("-C")
        .arg(&source)
        .args(["python", "skills", "alinery-vinculum-daemon"])
        .status()
        .unwrap();
    assert!(packed.success());

    let root = base.join("runtime");
    for (old, age) in [("old-a", 300), ("old-b", 100)] {
        std::fs::create_dir_all(root.join(old)).unwrap();
        let when = std::time::SystemTime::now() - std::time::Duration::from_secs(age);
        std::fs::File::open(root.join(old)).unwrap().set_modified(when).unwrap();
    }
    let dir = root.join("new");
    crate::pi_durable::unpack_runtime(&archive, &root, &dir).unwrap();

    assert!(dir.join("python/bin/python3").is_file() && dir.join("skills/pdf/SKILL.md").is_file() && dir.join(".complete").is_file());
    assert!(!dir.join("alinery-vinculum-daemon").exists(), "only python/ and skills/ are unpacked");
    assert!(root.join("old-b").is_dir() && !root.join("old-a").exists());
    assert!(!std::fs::read_dir(&root)
        .unwrap()
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().starts_with(".unpack")));
    let _ = std::fs::remove_dir_all(base);
}
