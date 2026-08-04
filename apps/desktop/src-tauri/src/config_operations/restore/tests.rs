use std::fs;

use rusqlite::{params, Connection};
use tempfile::tempdir;

use super::*;

#[test]
fn scheduled_group_restores_all_seven_domains_before_authorities_open() {
    let fixture = RestoreFixture::new();
    let archive = fixture.capture("target");
    fixture.write_generation("current");

    let selection =
        prepare_selection(&fixture.profile, &archive).expect("prepare restore selection");
    schedule_selection(&fixture.profile, &selection).expect("schedule restore");
    assert!(request_path(&fixture.profile).is_file());

    let receipt = run_before_authorities(&fixture.profile).expect("boot restore");
    assert_eq!(receipt.outcome, RestoreBootOutcome::Committed);
    assert_eq!(receipt.entries.len(), 7);
    assert_eq!(
        read_receipt(&fixture.profile).expect("read receipt"),
        Some(receipt)
    );
    assert!(!request_path(&fixture.profile).exists());
    fixture.assert_generation("target");

    let restarted = run_before_authorities(&fixture.profile).expect("clean restart");
    assert_eq!(restarted.outcome, RestoreBootOutcome::NoRequest);
}

#[test]
fn changed_archive_is_rejected_without_live_mutation() {
    let fixture = RestoreFixture::new();
    let archive = fixture.capture("target");
    fixture.write_generation("current");
    let selection =
        prepare_selection(&fixture.profile, &archive).expect("prepare restore selection");
    schedule_selection(&fixture.profile, &selection).expect("schedule restore");
    fs::write(&archive, b"changed after confirmation").expect("change archive");

    let receipt = run_before_authorities(&fixture.profile).expect("safe rejection");
    assert_eq!(receipt.outcome, RestoreBootOutcome::RejectedOrRolledBack);
    assert!(receipt
        .detail
        .as_deref()
        .is_some_and(|detail| detail.contains("reinspect restore archive")));
    assert!(!request_path(&fixture.profile).exists());
    fixture.assert_generation("current");
}

#[test]
fn current_evidence_change_invalidates_review_before_restart_is_scheduled() {
    let fixture = RestoreFixture::new();
    let archive = fixture.capture("target");
    fixture.write_generation("current");
    let selection =
        prepare_selection(&fixture.profile, &archive).expect("prepare restore selection");
    fs::write(
        sources(&fixture.profile).preferences,
        b"changed-after-review",
    )
    .expect("change current evidence");

    let error = schedule_selection(&fixture.profile, &selection).unwrap_err();
    assert_eq!(error, "restore evidence changed after operator review");
    assert!(!request_path(&fixture.profile).exists());
}

#[test]
fn corrupt_pending_request_keeps_product_authorities_closed() {
    let fixture = RestoreFixture::new();
    atomic_write(&request_path(&fixture.profile), b"not-json").expect("corrupt request");

    let error = run_before_authorities(&fixture.profile).unwrap_err();
    assert!(error.contains("decode pending restore request"));
    assert!(request_path(&fixture.profile).is_file());
}

struct RestoreFixture {
    _temp: tempfile::TempDir,
    profile: DesktopProfile,
}

impl RestoreFixture {
    fn new() -> Self {
        let temp = tempdir().expect("tempdir");
        let profile = DesktopProfile::portable_for_test(&temp.path().join("profile"))
            .expect("portable profile");
        profile.prepare().expect("prepare profile");
        Self {
            _temp: temp,
            profile,
        }
    }

    fn capture(&self, generation: &str) -> PathBuf {
        self.write_generation(generation);
        let sources = sources(&self.profile);
        backup_domains::capture(
            self.profile.storage_roots(),
            &sources,
            backup_domains::sequence(1),
        )
        .expect("capture fixture");
        fs::read_dir(self.profile.storage_roots().backup())
            .expect("backup directory")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "longhorn-backup")
            })
            .expect("published archive")
    }

    fn write_generation(&self, generation: &str) {
        let sources = sources(&self.profile);
        for path in file_sources(&sources) {
            fs::create_dir_all(path.parent().expect("file parent")).expect("create parent");
            fs::write(path, generation.as_bytes()).expect("write domain");
        }
        fs::create_dir_all(sources.database.parent().expect("database parent"))
            .expect("create database parent");
        let connection = Connection::open(&sources.database).expect("open database");
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE IF NOT EXISTS restore_fixture (
                     id INTEGER PRIMARY KEY,
                     value TEXT NOT NULL
                 );",
            )
            .expect("schema");
        connection
            .execute(
                "INSERT OR REPLACE INTO restore_fixture (id, value) VALUES (1, ?1)",
                params![generation],
            )
            .expect("seed database");
    }

    fn assert_generation(&self, expected: &str) {
        let sources = sources(&self.profile);
        for path in file_sources(&sources) {
            assert_eq!(fs::read_to_string(path).expect("read domain"), expected);
        }
        let value = Connection::open(&sources.database)
            .expect("open restored database")
            .query_row(
                "SELECT value FROM restore_fixture WHERE id = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("read restored database");
        assert_eq!(value, expected);
    }
}

fn file_sources(sources: &BackupSources) -> [&Path; 6] {
    [
        &sources.preferences,
        &sources.keymap,
        &sources.project_layouts,
        &sources.panel_presentations,
        &sources.window_placement,
        &sources.notifications,
    ]
}
