use super::*;
use longhorn_config::TargetPlatform;
use std::fs;
use tempfile::tempdir;

fn facts(platform: TargetPlatform) -> PlatformDirectoryFacts {
    match platform {
        TargetPlatform::MacOs => PlatformDirectoryFacts::complete(
            platform,
            "/Users/example/Library/Application Support",
            "/Users/example/Library/Application Support",
            "/Users/example/Library/Application Support",
            "/Users/example/Library/Caches",
            "/Users/example/Library/Logs",
            "/private/tmp",
        ),
        TargetPlatform::Windows => PlatformDirectoryFacts::complete(
            platform,
            "/windows/LocalAppData",
            "/windows/LocalAppData",
            "/windows/LocalAppData",
            "/windows/LocalAppData",
            "/windows/LocalAppData",
            "/windows/Temp",
        ),
        TargetPlatform::Linux => PlatformDirectoryFacts::complete(
            platform,
            "/home/example/.config",
            "/home/example/.local/share",
            "/home/example/.local/state",
            "/home/example/.cache",
            "/home/example/.local/state",
            "/run/user/1000",
        ),
    }
}

#[test]
fn canonical_identity_drives_all_three_platform_defaults() {
    for (platform, expected_config, expected_database) in [
        (
            TargetPlatform::MacOs,
            "/Users/example/Library/Application Support/com.inflatablecookie.nucleus/config",
            "/Users/example/Library/Application Support/com.inflatablecookie.nucleus/data/databases/nucleus.sqlite",
        ),
        (
            TargetPlatform::Windows,
            "/windows/LocalAppData/com.inflatablecookie.nucleus/config",
            "/windows/LocalAppData/com.inflatablecookie.nucleus/data/databases/nucleus.sqlite",
        ),
        (
            TargetPlatform::Linux,
            "/home/example/.config/com.inflatablecookie.nucleus",
            "/home/example/.local/share/com.inflatablecookie.nucleus/databases/nucleus.sqlite",
        ),
    ] {
        let profile = DesktopProfile::from_values(
            facts(platform),
            None,
            None,
            None,
            Path::new("/nonexistent/nucleus-profile-test"),
        )
        .expect("platform profile");
        assert_eq!(profile.workspace_ui_paths().project_layouts(), Path::new(expected_config).join("project-layouts.json"));
        assert_eq!(
            profile.workspace_ui_paths().panel_presentations(),
            Path::new(expected_config).join("project-panel-presentations.json")
        );
        assert_eq!(profile.database_path(), Path::new(expected_database));
        assert_eq!(profile.profile_id(), "platform-native-v1");
    }
}

#[test]
fn portable_profile_isolates_every_desktop_owned_path() {
    let profile = DesktopProfile::from_values(
        facts(TargetPlatform::MacOs),
        Some(OsStr::new("/tmp/nucleus-proof")),
        Some(OsStr::new("1250")),
        None,
        Path::new("/Users/example"),
    )
    .expect("portable profile");
    assert_eq!(
        profile.database_path(),
        Path::new("/tmp/nucleus-proof/data/databases/nucleus.sqlite")
    );
    assert_eq!(
        profile.snapshot_path(),
        Path::new("/tmp/nucleus-proof/state/task-review-snapshots")
    );
    assert_eq!(
        profile.workspace_ui_paths().window_placement(),
        Path::new("/tmp/nucleus-proof/state/window-placement.json")
    );
    assert_eq!(
        profile.workspace_ui_paths().project_layouts(),
        Path::new("/tmp/nucleus-proof/config/project-layouts.json")
    );
    assert_eq!(
        profile.workspace_ui_paths().panel_presentations(),
        Path::new("/tmp/nucleus-proof/config/project-panel-presentations.json")
    );
    assert_eq!(
        profile.editor_drafts_path(),
        Path::new("/tmp/nucleus-proof/state/editor-drafts")
    );
    assert_eq!(profile.chat_turn_timeout(), Duration::from_millis(1250));
    assert_eq!(profile.profile_id(), "portable-v1");
}

#[test]
fn fresh_portable_profile_restarts_with_the_same_layout() {
    let temp = tempdir().expect("tempdir");
    let root = temp.path().join("portable");
    let home = temp.path().join("home");
    let first = DesktopProfile::from_values(
        facts(TargetPlatform::MacOs),
        Some(root.as_os_str()),
        None,
        None,
        &home,
    )
    .expect("first profile");
    first.prepare().expect("prepare first profile");
    let second = DesktopProfile::from_values(
        facts(TargetPlatform::MacOs),
        Some(root.as_os_str()),
        None,
        None,
        &home,
    )
    .expect("restart profile");

    assert_eq!(second.profile_id(), "portable-v1");
    assert_eq!(second.layout_digest(), first.layout_digest());
    assert_eq!(second.database_path(), first.database_path());
    assert_eq!(second.workspace_ui_paths(), first.workspace_ui_paths());
    assert!(second.storage_roots().config().is_dir());
    assert!(second.storage_roots().data().is_dir());
    assert!(second.storage_roots().state().is_dir());
}

#[test]
fn legacy_profile_restart_reuses_the_committed_receipt_and_retains_source() {
    let temp = tempdir().expect("tempdir");
    let home = temp.path().join("home");
    let legacy_ui = home.join(".nucleus/config/ui.json");
    fs::create_dir_all(legacy_ui.parent().unwrap()).expect("legacy config root");
    fs::write(
        &legacy_ui,
        r#"{
          "schema_version": 10,
          "window": {
            "id": "window:primary",
            "placement": {"display_id":"display:main","maximized":false}
          },
          "project_layouts": {}
        }"#,
    )
    .expect("legacy UI");
    let facts = PlatformDirectoryFacts::complete(
        TargetPlatform::MacOs,
        temp.path().join("native/config"),
        temp.path().join("native/data"),
        temp.path().join("native/state"),
        temp.path().join("native/cache"),
        temp.path().join("native/log"),
        temp.path().join("native/runtime"),
    );

    let first = DesktopProfile::from_values(facts.clone(), None, None, None, &home)
        .expect("legacy import startup");
    let first_receipt = first
        .legacy_import_receipt()
        .cloned()
        .expect("legacy import receipt");
    let layout_before =
        fs::read(first.workspace_ui_paths().project_layouts()).expect("migrated project layouts");
    let second =
        DesktopProfile::from_values(facts, None, None, None, &home).expect("legacy restart");

    assert_eq!(second.legacy_import_receipt(), Some(&first_receipt));
    assert_eq!(second.layout_digest(), first.layout_digest());
    assert_eq!(
        fs::read(second.workspace_ui_paths().project_layouts()).expect("restarted project layouts"),
        layout_before
    );
    assert!(!fs::read(&legacy_ui).expect("retained legacy UI").is_empty());
}

#[test]
fn explicit_invalid_values_do_not_fall_back() {
    let result = DesktopProfile::from_values(
        facts(TargetPlatform::MacOs),
        Some(OsStr::new("relative")),
        None,
        None,
        Path::new("/Users/example"),
    );
    assert_eq!(
        result.unwrap_err(),
        format!("{PORTABLE_ROOT_ENV} must be an absolute path")
    );
    let result = DesktopProfile::from_values(
        facts(TargetPlatform::MacOs),
        Some(OsStr::new("/tmp/nucleus-proof")),
        Some(OsStr::new("0")),
        None,
        Path::new("/Users/example"),
    );
    assert_eq!(
        result.unwrap_err(),
        format!("{CHAT_TIMEOUT_ENV} must be between 1 and 180000")
    );
}
