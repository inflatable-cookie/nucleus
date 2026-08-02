use super::*;
use longhorn_config::{
    inspect_storage_bootstrap, resolve_storage_bootstrap_paths, resolve_storage_layout,
    PlatformDirectoryFacts, StorageBootstrapState, StorageIdentity, StorageLayoutRequest,
    StorageProfile, TargetPlatform,
};
use rusqlite::{params, Connection};
use tempfile::TempDir;

struct Fixture {
    _temp: TempDir,
    identity: StorageIdentity,
    facts: PlatformDirectoryFacts,
    source: ResolvedStorageLayout,
    target: ResolvedStorageLayout,
    bootstrap: StorageBootstrapPaths,
    legacy_root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().expect("tempdir");
        let identity = StorageIdentity::new("com.inflatablecookie.nucleus").unwrap();
        let facts = PlatformDirectoryFacts::complete(
            TargetPlatform::Linux,
            temp.path().join("native/config"),
            temp.path().join("native/data"),
            temp.path().join("native/state"),
            temp.path().join("native/cache"),
            temp.path().join("native/log"),
            temp.path().join("native/runtime"),
        );
        let legacy_root = temp.path().join("home/.nucleus");
        let source = resolve_storage_layout(
            &StorageLayoutRequest::new(identity.clone(), facts.clone())
                .with_profile(StorageProfile::PortableV1)
                .with_portable_root(&legacy_root),
        )
        .unwrap();
        let target =
            resolve_storage_layout(&StorageLayoutRequest::new(identity.clone(), facts.clone()))
                .unwrap();
        let bootstrap = resolve_storage_bootstrap_paths(&identity, &facts).unwrap();
        Self {
            _temp: temp,
            identity,
            facts,
            source,
            target,
            bootstrap,
            legacy_root,
        }
    }

    fn request(&self) -> LegacyImportRequest<'_> {
        LegacyImportRequest {
            canonical_application_id: self.identity.canonical_application_id(),
            source_layout: &self.source,
            target_layout: &self.target,
            target_selection: StorageProfileSelection::platform_native(),
            bootstrap: self.bootstrap.clone(),
        }
    }

    fn seed_ui(&self, schema_version: u32) {
        let path = self.source.storage_roots().config().join("ui.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            format!(
                r#"{{
                  "schema_version": {schema_version},
                  "window": {{
                    "id": "window:primary",
                    "placement": {{"display_id":"display:main","maximized":false}}
                  }},
                  "project_layouts": {{
                    "project:one": {{
                      "layout": {{"left_center_ratio":0.2,"center_right_ratio":0.74,"center_stack_ratio":0.74,"right_stack_ratio":0.74}},
                      "regions": {{"left":[],"right_top":[],"right_bottom":[],"center_top":[],"center_bottom":[]}},
                      "active_panels": {{}}
                    }}
                  }}
                }}"#
            ),
        )
        .unwrap();
    }
}

#[test]
fn live_wal_ui_and_trees_import_once_with_locator_last_and_source_retained() {
    let fixture = Fixture::new();
    fixture.seed_ui(10);
    let database = fixture
        .source
        .storage_roots()
        .state()
        .join("nucleus.sqlite");
    fs::create_dir_all(database.parent().unwrap()).unwrap();
    let connection = Connection::open(&database).unwrap();
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA wal_autocheckpoint=0;
             CREATE TABLE values_table (id INTEGER PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO values_table (id, value) VALUES (1, ?1)",
            params!["legacy-wal-value"],
        )
        .unwrap();
    let wal = PathBuf::from(format!("{}-wal", database.display()));
    let wal_before = fs::read(&wal).unwrap();

    for (directory, relative, bytes) in [
        (
            "task-review-snapshots",
            "task/manifest.json",
            b"snapshot".as_slice(),
        ),
        (
            "editor-drafts",
            "project/resource/draft.json",
            b"draft".as_slice(),
        ),
    ] {
        let path = fixture
            .source
            .storage_roots()
            .state()
            .join(directory)
            .join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    let unknown = fixture.source.storage_roots().config().join("unknown.bin");
    fs::write(&unknown, b"retain-unknown").unwrap();

    let receipt = import_legacy_storage(fixture.request())
        .expect("legacy import")
        .expect("import receipt");

    assert_eq!(receipt.outcome, "target-committed");
    assert_eq!(receipt.custom_domains.len(), 4);
    assert_eq!(receipt.retained_source_root, fixture.legacy_root);
    assert_eq!(receipt.retained_unknown_files, [unknown.clone()]);
    assert_eq!(fs::read(&unknown).unwrap(), b"retain-unknown");
    assert_eq!(fs::read(&wal).unwrap(), wal_before);
    assert!(fixture
        .target
        .storage_roots()
        .state()
        .join("window-placement.json")
        .is_file());
    assert!(fixture
        .target
        .storage_roots()
        .config()
        .join("project-layouts.json")
        .is_file());
    assert_eq!(
        fs::read(
            fixture
                .target
                .storage_roots()
                .state()
                .join("task-review-snapshots/task/manifest.json")
        )
        .unwrap(),
        b"snapshot"
    );
    assert_eq!(
        fs::read(
            fixture
                .target
                .storage_roots()
                .state()
                .join("editor-drafts/project/resource/draft.json")
        )
        .unwrap(),
        b"draft"
    );
    let target_database = fixture.target.durable_database_dir().join("nucleus.sqlite");
    assert_eq!(
        Connection::open(target_database)
            .unwrap()
            .query_row("SELECT value FROM values_table WHERE id=1", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
        "legacy-wal-value"
    );
    let StorageBootstrapState::Selected(selected) =
        inspect_storage_bootstrap(&fixture.identity, &fixture.facts, None).unwrap()
    else {
        panic!("locator did not select target");
    };
    assert_eq!(selected.transition_id(), Some(TRANSITION_ID));
    assert_eq!(
        read_import_receipt(&fixture.bootstrap).unwrap(),
        Some(receipt)
    );
    drop(connection);
}

#[test]
fn missing_legacy_root_does_not_create_target_or_locator() {
    let fixture = Fixture::new();
    assert_eq!(import_legacy_storage(fixture.request()).unwrap(), None);
    assert!(!fixture.bootstrap.locator().exists());
    assert!(!fixture.target.storage_roots().data().exists());
}

#[test]
fn corrupt_and_future_ui_preserve_source_and_never_commit_locator() {
    for source in [b"not-json".as_slice(), br#"{"schema_version":999}"#] {
        let fixture = Fixture::new();
        let ui = fixture.source.storage_roots().config().join("ui.json");
        fs::create_dir_all(ui.parent().unwrap()).unwrap();
        fs::write(&ui, source).unwrap();
        assert!(import_legacy_storage(fixture.request()).is_err());
        assert_eq!(fs::read(ui).unwrap(), source);
        assert!(!fixture.bootstrap.locator().exists());
        assert!(!fixture
            .target
            .storage_roots()
            .state()
            .join("window-placement.json")
            .exists());
    }
}

#[test]
fn occupied_split_target_blocks_without_merging_or_locator_commit() {
    let fixture = Fixture::new();
    fixture.seed_ui(10);
    let occupied = fixture
        .target
        .storage_roots()
        .state()
        .join("window-placement.json");
    fs::create_dir_all(occupied.parent().unwrap()).unwrap();
    fs::write(&occupied, b"occupied").unwrap();
    assert!(import_legacy_storage(fixture.request()).is_err());
    assert_eq!(fs::read(&occupied).unwrap(), b"occupied");
    assert!(!fixture.bootstrap.locator().exists());
}
