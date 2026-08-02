use std::{fs, path::Path};

use longhorn_config::{
    inspect_backup_archive, list_operational_backups, BackupApplication, BackupArchiveLimits,
    BackupKind, BackupOperationalRoot, StorageRoots,
};
use longhorn_core::ConfigRequestId;
use rusqlite::Connection;
use tempfile::TempDir;

use super::*;

#[test]
fn capture_inventories_only_the_explicit_nucleus_domains() {
    let fixture = Fixture::new();
    fixture.write_sources();
    fs::create_dir_all(fixture.roots.config().join("credentials")).unwrap();
    fs::write(
        fixture.roots.config().join("credentials/token.txt"),
        "secret",
    )
    .unwrap();
    fs::create_dir_all(fixture.roots.data().join("Browser")).unwrap();
    fs::write(fixture.roots.data().join("Browser/cookies"), "private").unwrap();

    let captured = backup_domains::capture(&fixture.roots, &fixture.sources, 1).unwrap();
    assert_eq!(captured.capture.selected_domains, 7);
    assert_eq!(captured.capture.custom_domains, 7);
    let archive = fs::read(&captured.publication.path).unwrap();
    let inspection = inspect_backup_archive(&archive, BackupArchiveLimits::default()).unwrap();
    assert_eq!(
        inspection
            .manifest()
            .domains()
            .iter()
            .map(|domain| domain.domain().as_str())
            .collect::<Vec<_>>(),
        [
            "nucleus.command-keymap",
            "nucleus.database",
            "nucleus.notifications",
            "nucleus.panel-presentations",
            "nucleus.preferences",
            "nucleus.project-layouts",
            "nucleus.window-placement",
        ]
    );
    let retained = inspection
        .payloads()
        .iter()
        .flat_map(|payload| payload.bytes())
        .copied()
        .collect::<Vec<_>>();
    assert!(!String::from_utf8_lossy(&retained).contains("secret"));
    assert!(!String::from_utf8_lossy(&retained).contains("private"));
}

#[test]
fn sqlite_capture_is_a_valid_online_snapshot() {
    let fixture = Fixture::new();
    fixture.write_sources();
    let captured = backup_domains::capture(&fixture.roots, &fixture.sources, 2).unwrap();
    let archive = fs::read(&captured.publication.path).unwrap();
    let inspection = inspect_backup_archive(&archive, BackupArchiveLimits::default()).unwrap();
    let database = inspection
        .payloads()
        .iter()
        .find(|payload| payload.path().as_str().ends_with("nucleus.sqlite"))
        .expect("database payload");
    let staged = tempfile::NamedTempFile::new().unwrap();
    fs::write(staged.path(), database.bytes()).unwrap();
    let connection = Connection::open(staged.path()).unwrap();
    let value: String = connection
        .query_row("SELECT value FROM proof", [], |row| row.get(0))
        .unwrap();
    assert_eq!(value, "captured");
}

#[test]
fn inventory_preserves_corrupt_entries_and_retention_is_bounded() {
    let fixture = Fixture::new();
    fixture.write_sources();
    for sequence in 10..21 {
        backup_domains::capture(&fixture.roots, &fixture.sources, sequence).unwrap();
    }
    fs::write(
        fixture.roots.backup().join("corrupt.longhorn-backup"),
        b"broken",
    )
    .unwrap();
    let root = BackupOperationalRoot::new(fixture.roots.backup()).unwrap();
    let application =
        BackupApplication::new(CANONICAL_APPLICATION_ID, env!("CARGO_PKG_VERSION")).unwrap();
    let listing = list_operational_backups(
        &root,
        &application,
        BackupArchiveLimits::default(),
        MAX_SCAN_ENTRIES,
    );
    assert_eq!(listing.candidates().len(), 11);
    assert_eq!(listing.diagnostics().len(), 1);
    let (plan, _) = retention::plan(&listing).unwrap().unwrap();
    assert_eq!(plan.deletions().len(), 1);
}

#[test]
fn selected_operational_archive_exports_the_exact_snapshot_as_user_export() {
    let fixture = Fixture::new();
    fixture.write_sources();
    backup_domains::capture(&fixture.roots, &fixture.sources, 30).unwrap();
    let root = BackupOperationalRoot::new(fixture.roots.backup()).unwrap();
    let application =
        BackupApplication::new(CANONICAL_APPLICATION_ID, env!("CARGO_PKG_VERSION")).unwrap();
    let listing = list_operational_backups(
        &root,
        &application,
        BackupArchiveLimits::default(),
        MAX_SCAN_ENTRIES,
    );
    let candidate = listing.candidates().first().unwrap();
    let source = fs::read(candidate.path()).unwrap();
    let source = inspect_backup_archive(&source, BackupArchiveLimits::default()).unwrap();
    let target_path = fixture
        .roots
        .data()
        .join("exported-nucleus.longhorn-backup");
    let target = export::SelectedExportTarget::refusing(target_path.clone());

    let receipt = export::publish_selected_export(candidate, &target).unwrap();
    let exported = fs::read(&target_path).unwrap();
    let exported = inspect_backup_archive(&exported, BackupArchiveLimits::default()).unwrap();

    assert_eq!(receipt.destination, "userExport");
    assert_eq!(exported.manifest().kind(), BackupKind::UserExport);
    assert_eq!(
        exported.manifest().archive_id(),
        source.manifest().archive_id()
    );
    assert_eq!(exported.manifest().domains(), source.manifest().domains());
    assert_eq!(exported.payloads(), source.payloads());
}

#[test]
fn selected_export_target_is_bounded_exact_and_single_use() {
    let inbox = export::ExportTargetInbox::default();
    let request = ConfigRequestId::new("config:export:one").unwrap();
    let target = export::SelectedExportTarget::refusing(
        Path::new("/tmp/nucleus-export.longhorn-backup").to_path_buf(),
    );

    inbox.insert(request.clone(), target.clone()).unwrap();
    assert!(inbox.insert(request.clone(), target.clone()).is_err());
    assert_eq!(inbox.take(&request).unwrap(), Some(target));
    assert_eq!(inbox.take(&request).unwrap(), None);
}

#[test]
fn source_change_after_inventory_rejects_without_publishing() {
    let fixture = Fixture::new();
    fixture.write_sources();
    backup_domains::capture(&fixture.roots, &fixture.sources, 31).unwrap();
    let root = BackupOperationalRoot::new(fixture.roots.backup()).unwrap();
    let application =
        BackupApplication::new(CANONICAL_APPLICATION_ID, env!("CARGO_PKG_VERSION")).unwrap();
    let listing = list_operational_backups(
        &root,
        &application,
        BackupArchiveLimits::default(),
        MAX_SCAN_ENTRIES,
    );
    let candidate = listing.candidates().first().unwrap();
    fs::write(candidate.path(), b"changed after inventory").unwrap();
    let target_path = fixture.roots.data().join("must-not-exist.longhorn-backup");
    let target = export::SelectedExportTarget::refusing(target_path.clone());

    assert_eq!(
        export::publish_selected_export(candidate, &target),
        Err(export::SelectedExportError::ArchiveChanged)
    );
    assert!(!target_path.exists());
}

struct Fixture {
    _temporary: TempDir,
    roots: StorageRoots,
    sources: backup_domains::BackupSources,
}

impl Fixture {
    fn new() -> Self {
        let temporary = TempDir::new().unwrap();
        let roots = StorageRoots::new(
            temporary.path().join("config"),
            temporary.path().join("data"),
            temporary.path().join("state"),
            temporary.path().join("cache"),
            temporary.path().join("runtime"),
            temporary.path().join("log"),
            temporary.path().join("backup"),
        )
        .unwrap();
        let sources = backup_domains::BackupSources {
            database: roots.data().join("databases/nucleus.sqlite"),
            preferences: roots.config().join("preferences/nucleus.json"),
            keymap: roots.config().join("commands/keymap.json"),
            project_layouts: roots.config().join("project-layouts.json"),
            panel_presentations: roots.config().join("project-panel-presentations.json"),
            window_placement: roots.state().join("window-placement.json"),
            notifications: roots.state().join("notifications.json"),
        };
        Self {
            _temporary: temporary,
            roots,
            sources,
        }
    }

    fn write_sources(&self) {
        fs::create_dir_all(self.sources.database.parent().unwrap()).unwrap();
        let database = Connection::open(&self.sources.database).unwrap();
        database
            .execute("CREATE TABLE proof(value TEXT NOT NULL)", [])
            .unwrap();
        database
            .execute("INSERT INTO proof(value) VALUES ('captured')", [])
            .unwrap();
        for (path, value) in [
            (&self.sources.preferences, "preferences"),
            (&self.sources.keymap, "keymap"),
            (&self.sources.project_layouts, "layouts"),
            (&self.sources.panel_presentations, "presentations"),
            (&self.sources.window_placement, "window"),
            (&self.sources.notifications, "notifications"),
        ] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, value).unwrap();
        }
    }
}
