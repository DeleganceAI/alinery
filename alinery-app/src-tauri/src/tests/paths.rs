//! Tests for paths.rs — slug generation and the storage layout
//!
//! These reach crate items directly as `crate::…`; nothing here needs the shared
//! fixtures in tests/mod.rs, so there is no `use super::*`.

// slugify has no direct test, yet create_task_in_with_draft_slug asserts a round-trip
// against it and *rejects the user's request* when it fails:
//
//     let normalized_slug = slugify(requested_final_slug);
//     if normalized_slug != requested_final_slug { return Err("task slug must use …") }
//
// So every string slugify emits must be a fixed point, or the app rejects a slug it
// generated itself and the user cannot proceed. That is the property worth pinning.
#[test]
fn slugify_lowercases_and_collapses_runs_of_punctuation() {
    assert_eq!(crate::slugify("Fix The Thing"), "fix-the-thing");
    assert_eq!(crate::slugify("UPPER"), "upper");
    assert_eq!(crate::slugify("a  b"), "a-b");
    assert_eq!(crate::slugify("a---b"), "a-b");
    assert_eq!(crate::slugify("a_b.c/d"), "a-b-c-d");
}

#[test]
fn slugify_never_leads_or_trails_with_a_dash() {
    // A leading dash would make the branch name `-foo`, which git reads as a flag.
    assert_eq!(crate::slugify("  spaced  "), "spaced");
    assert_eq!(crate::slugify("---x---"), "x");
    assert_eq!(crate::slugify("!!!x!!!"), "x");
}

#[test]
fn slugify_falls_back_to_task_rather_than_an_empty_name() {
    // An empty slug would produce `.alinery/tasks//task.md` and a nameless branch.
    assert_eq!(crate::slugify(""), "task");
    assert_eq!(crate::slugify("!!!"), "task");
    assert_eq!(crate::slugify("   "), "task");
    assert_eq!(crate::slugify("🎉"), "task");
}

#[test]
fn slugify_keeps_digits_and_existing_kebab_case() {
    assert_eq!(crate::slugify("issue-345"), "issue-345");
    assert_eq!(crate::slugify("v2"), "v2");
}

// The invariant the create-task guard depends on. If any of these were not fixed points,
// create_task would reject its own generated slug.
#[test]
fn slugify_output_is_always_a_fixed_point() {
    let inputs = [
        "Fix The Thing",
        "  spaced  ",
        "a_b.c/d",
        "!!!",
        "",
        "UPPER",
        "a---b",
        "issue-345",
        "🎉 party 🎉",
        "café",
        "trailing-",
        "-leading",
        "multi   space   run",
        "Mixed_Case-With.Dots",
        "123",
        "a",
    ];
    for input in inputs {
        let once = crate::slugify(input);
        assert_eq!(crate::slugify(&once), once, "slugify is not idempotent for {input:?} (got {once:?})");
    }
}

// Non-ASCII is dropped rather than transliterated, so "café" becomes "caf". Pinned
// because it is a deliberate simplification, not an accident — and because a user whose
// task titles are entirely non-ASCII gets "task" for all of them, which is worth knowing.
#[test]
fn slugify_drops_non_ascii_instead_of_transliterating() {
    assert_eq!(crate::slugify("café"), "caf");
    assert_eq!(crate::slugify("naïve approach"), "na-ve-approach");
}

#[test]
fn app_config_path_for_production_uses_legacy_path_and_ignores_launch_root() {
    let config_dir = std::path::Path::new("/tmp/ai.delegance.alinery");
    let expected = config_dir.join("app.toml");

    assert_eq!(crate::app_config_path_for(config_dir, alinery_core::PRODUCTION_APP_IDENTIFIER, None), expected);
    assert_eq!(
        crate::app_config_path_for(config_dir, alinery_core::PRODUCTION_APP_IDENTIFIER, Some(std::ffi::OsStr::new("/tmp/other-source")),),
        expected
    );
    assert_eq!(
        crate::app_config_path_for(config_dir, "ai.delegance.alinery.dev.preview", Some(std::ffi::OsStr::new("/tmp/other-source")),),
        expected
    );
}

#[test]
fn app_config_path_for_development_hashes_the_exact_source_root() {
    let config_dir = std::path::Path::new("/tmp/ai.delegance.alinery.dev");
    let source_root = std::ffi::OsStr::new("/tmp/Alinery source/日本語");
    let selected = crate::app_config_path_for(config_dir, alinery_core::DEVELOPMENT_APP_IDENTIFIER, Some(source_root));

    assert_eq!(selected, config_dir.join("instances").join("92682a1586bf05c2").join("app.toml"));
    let key = selected
        .parent()
        .and_then(std::path::Path::file_name)
        .and_then(std::ffi::OsStr::to_str)
        .expect("source-scoped config has a UTF-8 key directory");
    assert_eq!(key.len(), 16);
    assert!(key.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    assert_ne!(selected, config_dir.join("app.toml"));
}

// The sidecars (linear-account) sit in the identifier's config dir, but a dev build's app.toml is
// two levels below it. A caller that reached for app.toml's parent would write to — or, in the
// import path's case, try to delete from — an instance dir that never holds them, so the repair
// would silently do nothing on exactly the builds a developer runs.
#[test]
fn app_config_dir_of_climbs_out_of_a_development_instance_dir() {
    let config_dir = std::path::Path::new("/tmp/ai.delegance.alinery.dev");
    let development = crate::app_config_path_for(config_dir, alinery_core::DEVELOPMENT_APP_IDENTIFIER, Some(std::ffi::OsStr::new("/tmp/source-a")));
    assert_eq!(crate::app_config_dir_of(&development), Some(config_dir));

    let production = std::path::Path::new("/tmp/ai.delegance.alinery");
    assert_eq!(crate::app_config_dir_of(&production.join("app.toml")), Some(production));
    assert_eq!(crate::app_config_dir_of(std::path::Path::new("app.toml")), Some(std::path::Path::new("")));
}

#[test]
fn app_config_path_for_development_separates_distinct_source_roots() {
    let config_dir = std::path::Path::new("/tmp/ai.delegance.alinery.dev");
    let first = crate::app_config_path_for(config_dir, alinery_core::DEVELOPMENT_APP_IDENTIFIER, Some(std::ffi::OsStr::new("/tmp/source-a")));
    let second = crate::app_config_path_for(config_dir, alinery_core::DEVELOPMENT_APP_IDENTIFIER, Some(std::ffi::OsStr::new("/tmp/source-b")));

    assert_ne!(first, second);
}

#[test]
fn app_config_path_for_development_uses_unknown_for_missing_or_empty_provenance() {
    let config_dir = std::path::Path::new("/tmp/ai.delegance.alinery.dev");
    let expected = config_dir.join("instances").join("unknown").join("app.toml");

    assert_eq!(crate::app_config_path_for(config_dir, alinery_core::DEVELOPMENT_APP_IDENTIFIER, None), expected);
    assert_eq!(
        crate::app_config_path_for(config_dir, alinery_core::DEVELOPMENT_APP_IDENTIFIER, Some(std::ffi::OsStr::new("")),),
        expected
    );
    assert_ne!(expected, config_dir.join("app.toml"));
}
