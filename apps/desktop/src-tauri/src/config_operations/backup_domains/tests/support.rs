use std::fs;
use std::path::{Path, PathBuf};

use longhorn_config::BackupAdapterGroupedApplyKind;
use rusqlite::{params, Connection};

use super::super::*;
use crate::desktop_profile::DesktopProfile;

pub(super) struct PanicTargetAdapter {
    inner: FileCaptureAdapter,
}

impl PanicTargetAdapter {
    pub(super) fn new(id: &str, path: PathBuf) -> Self {
        Self {
            inner: FileCaptureAdapter::new(id, path).expect("panic adapter"),
        }
    }
}

impl BackupAdapter for PanicTargetAdapter {
    fn id(&self) -> &BackupAdapterId {
        self.inner.id()
    }

    fn capabilities(&self) -> &BackupAdapterCapabilities {
        self.inner.capabilities()
    }

    fn capture(
        &self,
        request: BackupAdapterCaptureRequest<'_>,
    ) -> Result<BackupAdapterCapture, BackupAdapterError> {
        self.inner.capture(request)
    }

    fn inspect(
        &self,
        request: BackupAdapterInspectRequest<'_>,
    ) -> Result<BackupAdapterRestorePreview, BackupAdapterError> {
        self.inner.inspect(request)
    }

    fn restore(
        &self,
        request: BackupAdapterRestoreRequest<'_>,
    ) -> Result<BackupAdapterRestoreOutcome, BackupAdapterError> {
        self.inner.restore(request)
    }

    fn grouped_restore(&self) -> Option<&dyn BackupAdapterGroupedRestore> {
        Some(self)
    }
}

impl BackupAdapterGroupedRestore for PanicTargetAdapter {
    fn stage(
        &self,
        request: BackupAdapterGroupedStageRequest<'_>,
    ) -> Result<BackupAdapterRestoreStage, BackupAdapterError> {
        self.inner.stage(request)
    }

    fn apply(
        &self,
        request: BackupAdapterGroupedApplyRequest<'_>,
    ) -> Result<(), BackupAdapterError> {
        if request.kind() == BackupAdapterGroupedApplyKind::Target {
            panic!("simulated Nucleus process interruption");
        }
        self.inner.apply(request)
    }

    fn verify(
        &self,
        request: BackupAdapterGroupedVerifyRequest<'_>,
    ) -> Result<BackupAdapterStateEvidence, BackupAdapterError> {
        self.inner.verify(request)
    }
}

pub(super) fn published_archive(profile: &DesktopProfile) -> PathBuf {
    fs::read_dir(profile.storage_roots().backup())
        .expect("backup directory")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "longhorn-backup")
        })
        .expect("published archive")
}

pub(super) fn write_generation(sources: &BackupSources, generation: &str) {
    for path in file_sources(sources) {
        fs::create_dir_all(path.parent().expect("file parent")).expect("create parent");
        fs::write(path, generation.as_bytes()).expect("write file domain");
    }
    fs::create_dir_all(sources.database.parent().expect("database parent"))
        .expect("create database parent");
    let connection = Connection::open(&sources.database).expect("open database");
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA wal_autocheckpoint = 0;
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

pub(super) fn assert_file_generation_except(
    sources: &BackupSources,
    expected: &str,
    absent: &[&Path],
) {
    for path in file_sources(sources) {
        if absent.contains(&path) {
            continue;
        }
        assert_eq!(
            fs::read_to_string(path).expect("read file domain"),
            expected
        );
    }
}

pub(super) fn assert_database_generation(sources: &BackupSources, expected: &str) {
    let value = Connection::open(&sources.database)
        .expect("open database")
        .query_row(
            "SELECT value FROM restore_fixture WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .expect("read database");
    assert_eq!(value, expected);
}

pub(super) fn remove_sqlite_files(path: &Path) {
    for path in [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.display())),
        PathBuf::from(format!("{}-shm", path.display())),
    ] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("remove sqlite target: {error}"),
        }
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
