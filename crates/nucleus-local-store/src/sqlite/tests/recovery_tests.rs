//! SQLite recovery tests: reopen durability, ref-only recovery, and
//! projection-file isolation.

use super::*;

use crate::repositories::{LocalStoreBackend, LocalStoreRepository};

#[test]
fn sqlite_first_slice_domain_records_survive_reopen() {
    for (domain, kind, id) in sqlite_supported_domains() {
        assert_sqlite_repository_recovers_after_reopen(domain, kind, id);
    }
}

#[test]
fn sqlite_single_database_recovers_all_first_domains() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let database_path = tempdir.path().join("nucleus.sqlite3");

    {
        let backend = SqliteBackend::new(database_path.clone());
        for (domain, kind, id) in sqlite_supported_domains() {
            let mut repository = backend
                .open_repository(domain.clone())
                .expect("open repository for write");
            let record = fixture_record(domain, kind, id, "rev:1");
            repository
                .put(
                    record,
                    RevisionExpectation::MustNotExist,
                    LocalStoreTransactionPosture::Autocommit,
                )
                .expect("write record");
        }
    }

    let backend = SqliteBackend::new(database_path);
    for (domain, kind, id) in sqlite_supported_domains() {
        let repository = backend
            .open_repository(domain)
            .expect("open repository after restart");
        let record = repository
            .get(&PersistenceRecordId(id.to_owned()))
            .expect("get after restart")
            .expect("record after restart");
        assert_eq!(record.id, PersistenceRecordId(id.to_owned()));
        assert_eq!(record.kind, kind);
        assert_eq!(record.revision_id, RevisionId("rev:1".to_owned()));
    }
}

#[test]
fn sqlite_recovery_uses_refs_without_secret_or_artifact_payload_material() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let database_path = tempdir.path().join("nucleus.sqlite3");
    let backend = SqliteBackend::new(database_path.clone());

    {
        let records = [
            fixture_record(
                PersistenceDomain::ModelRoutes,
                PersistenceRecordKind::ModelRoute,
                "route:credential-ref-only",
                "rev:1",
            ),
            fixture_record(
                PersistenceDomain::CommandEvidence,
                PersistenceRecordKind::CommandEvidence,
                "command:evidence-ref-only",
                "rev:1",
            ),
            fixture_record(
                PersistenceDomain::ArtifactMetadata,
                PersistenceRecordKind::ArtifactMetadata,
                "artifact:metadata-ref-only",
                "rev:1",
            ),
            fixture_record(
                PersistenceDomain::RuntimeEffects,
                PersistenceRecordKind::RuntimeEffect,
                "runtime:effect-ref-only",
                "rev:1",
            ),
        ];

        for record in records {
            let mut repository = backend
                .open_repository(record.domain.clone())
                .expect("open repository");
            repository
                .put(
                    record,
                    RevisionExpectation::MustNotExist,
                    LocalStoreTransactionPosture::Autocommit,
                )
                .expect("write ref-only metadata");
        }
    }

    let backend = SqliteBackend::new(database_path);
    for domain in [
        PersistenceDomain::ModelRoutes,
        PersistenceDomain::CommandEvidence,
        PersistenceDomain::ArtifactMetadata,
        PersistenceDomain::RuntimeEffects,
    ] {
        let repository = backend
            .open_repository(domain)
            .expect("open repository after restart without external material");
        assert_eq!(repository.list().expect("list ref-only metadata").len(), 1);
    }
}

#[test]
fn sqlite_recovery_does_not_import_projection_files_as_active_state() {
    use std::fs;

    let tempdir = tempfile::tempdir().expect("tempdir");
    let projection_dir = tempdir.path().join("nucleus").join("tasks");
    fs::create_dir_all(&projection_dir).expect("create projection dir");
    fs::write(
        projection_dir.join("task-from-projection.toml"),
        "id = \"task-from-projection\"\n",
    )
    .expect("write projection file");

    let database_path = tempdir.path().join("nucleus.sqlite3");
    let repository =
        SqliteRepository::open(&database_path, PersistenceDomain::Tasks).expect("open sqlite");

    assert_eq!(repository.list().expect("list active tasks"), Vec::new());
}
