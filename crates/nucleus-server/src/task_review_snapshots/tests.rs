use std::fs;
use std::path::Path;

use super::*;
use crate::{seed_local_project, LocalProjectSeed, ServerStateService};
use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_local_store::{LocalStoreBackend, RevisionExpectation, SqliteBackend};
use nucleus_projects::{decode_project_storage_record, encode_project_storage_payload};

fn request(role: SnapshotRole, created_at_unix_seconds: u64) -> TaskReviewSnapshotCaptureRequest {
    TaskReviewSnapshotCaptureRequest {
        project_id: "project:nucleus-local".to_owned(),
        work_item_id: "task:nucleus-local:review".to_owned(),
        role,
        created_at_unix_seconds,
    }
}

fn entry<'a>(manifest: &'a SnapshotManifest, path: &str) -> &'a SnapshotFileEntry {
    manifest
        .files
        .iter()
        .find(|entry| entry.display_path == path)
        .unwrap_or_else(|| panic!("missing {path}"))
}

fn regular_file_count(path: &Path) -> usize {
    fs::read_dir(path)
        .expect("read dir")
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_file())
        .count()
}

#[test]
fn captures_exact_admitted_boundaries_and_metadata_only_files() {
    let project = tempfile::tempdir().expect("project");
    let backend = tempfile::tempdir().expect("backend");
    fs::write(project.path().join("unchanged.rs"), "same\n").expect("unchanged");
    fs::write(project.path().join("modified.rs"), "before\n").expect("modified");
    fs::write(project.path().join("deleted.rs"), "delete me\n").expect("deleted");
    fs::write(project.path().join("binary.bin"), b"a\0b").expect("binary");
    fs::File::create(project.path().join("oversized.txt"))
        .expect("oversized")
        .set_len(crate::project_file_policy::MAX_PROJECT_TEXT_FILE_BYTES + 1)
        .expect("oversized length");
    fs::write(project.path().join(".gitignore"), "ignored.txt\n").expect("ignore policy");
    fs::write(project.path().join("ignored.txt"), "ignored").expect("ignored");
    fs::create_dir(project.path().join("target")).expect("excluded dir");
    fs::write(project.path().join("target/hidden.rs"), "hidden").expect("excluded file");
    #[cfg(unix)]
    std::os::unix::fs::symlink("/etc/hosts", project.path().join("escaped.txt"))
        .expect("escaped symlink");

    let store = TaskReviewSnapshotStore::new(backend.path().join("snapshots")).expect("store");
    let baseline = store
        .capture_root(project.path(), request(SnapshotRole::Baseline, 10))
        .expect("baseline");

    fs::write(project.path().join("modified.rs"), "after\n").expect("modify");
    fs::remove_file(project.path().join("deleted.rs")).expect("delete");
    fs::write(project.path().join("added.rs"), "added\n").expect("add");
    let target = store
        .capture_root(project.path(), request(SnapshotRole::Target, 20))
        .expect("target");

    assert_eq!(
        entry(&baseline, "unchanged.rs").content_hash,
        entry(&target, "unchanged.rs").content_hash
    );
    assert_ne!(
        entry(&baseline, "modified.rs").content_hash,
        entry(&target, "modified.rs").content_hash
    );
    assert!(baseline
        .files
        .iter()
        .any(|file| file.display_path == "deleted.rs"));
    assert!(!target
        .files
        .iter()
        .any(|file| file.display_path == "deleted.rs"));
    assert!(!baseline
        .files
        .iter()
        .any(|file| file.display_path == "added.rs"));
    assert!(target
        .files
        .iter()
        .any(|file| file.display_path == "added.rs"));
    assert_eq!(
        entry(&baseline, "binary.bin").content_state,
        SnapshotContentState::BinaryMetadataOnly
    );
    assert_eq!(
        entry(&baseline, "oversized.txt").content_state,
        SnapshotContentState::OversizedMetadataOnly
    );
    assert!(!baseline.files.iter().any(|file| matches!(
        file.display_path.as_str(),
        "ignored.txt" | "target/hidden.rs" | "escaped.txt"
    )));
    assert_eq!(
        baseline.coverage,
        SnapshotCoverageState::CompleteAdmittedFiles
    );
    assert_ne!(baseline.snapshot_ref, target.snapshot_ref);
}

#[test]
fn deduplicates_text_and_resolves_only_manifest_authorized_refs() {
    let project = tempfile::tempdir().expect("project");
    let backend = tempfile::tempdir().expect("backend");
    fs::write(project.path().join("a.txt"), "shared\n").expect("a");
    fs::write(project.path().join("b.txt"), "shared\n").expect("b");
    fs::write(project.path().join("binary.bin"), b"x\0y").expect("binary");
    let root = backend.path().join("snapshots");
    let store = TaskReviewSnapshotStore::new(&root).expect("store");
    let manifest = store
        .capture_root(project.path(), request(SnapshotRole::Baseline, 10))
        .expect("capture");

    assert_eq!(regular_file_count(&root.join("blobs")), 1);
    let a = entry(&manifest, "a.txt");
    let b = entry(&manifest, "b.txt");
    assert_eq!(a.content_hash, b.content_hash);
    assert_eq!(
        store
            .resolve_text(&manifest.snapshot_ref, &a.file_ref)
            .expect("resolve"),
        SnapshotTextResolution {
            state: SnapshotTextResolutionState::Available,
            content: Some("shared\n".to_owned()),
        }
    );
    assert_eq!(
        store
            .resolve_text(
                &manifest.snapshot_ref,
                &entry(&manifest, "binary.bin").file_ref
            )
            .expect("binary resolution")
            .state,
        SnapshotTextResolutionState::NotStored
    );
    assert_eq!(
        store
            .resolve_text(
                &manifest.snapshot_ref,
                &SnapshotFileRef("project-file:invented".to_owned()),
            )
            .expect("unknown file")
            .state,
        SnapshotTextResolutionState::FileNotFound
    );
    assert!(store
        .resolve_manifest(&SnapshotRef("snapshot:../escape".to_owned()))
        .expect_err("invalid ref")
        .to_string()
        .contains("invalid snapshot ref"));
    assert_eq!(
        store
            .resolve_manifest(&SnapshotRef(format!("snapshot:{}", "0".repeat(64))))
            .expect("missing snapshot")
            .state,
        SnapshotResolutionState::Missing
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for directory in ["", "manifests", "blobs", "retention", "staging"] {
            assert_eq!(
                fs::metadata(root.join(directory))
                    .expect("directory metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        for directory in ["manifests", "blobs", "retention"] {
            for entry in fs::read_dir(root.join(directory)).expect("stored files") {
                assert_eq!(
                    entry
                        .expect("entry")
                        .metadata()
                        .expect("file metadata")
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
            }
        }
    }

    let SnapshotContentState::StoredText { blob_ref } = &a.content_state else {
        panic!("text blob ref");
    };
    fs::remove_file(
        root.join("blobs")
            .join(blob_ref.0.trim_start_matches("snapshot-blob:")),
    )
    .expect("remove blob");
    assert_eq!(
        store
            .resolve_text(&manifest.snapshot_ref, &a.file_ref)
            .expect("missing blob")
            .state,
        SnapshotTextResolutionState::BlobMissing
    );
}

#[test]
fn retention_keeps_shared_blobs_until_the_last_snapshot_expires() {
    let project = tempfile::tempdir().expect("project");
    let backend = tempfile::tempdir().expect("backend");
    fs::write(project.path().join("demo.txt"), "retained\n").expect("text");
    let root = backend.path().join("snapshots");
    let store = TaskReviewSnapshotStore::new(&root).expect("store");
    let baseline = store
        .capture_root(project.path(), request(SnapshotRole::Baseline, 10))
        .expect("baseline");
    let target = store
        .capture_root(project.path(), request(SnapshotRole::Target, 20))
        .expect("target");
    assert_eq!(regular_file_count(&root.join("blobs")), 1);

    store
        .mark_awaiting_review(&baseline.snapshot_ref)
        .expect("await review");
    store
        .start_cleanup_grace(&baseline.snapshot_ref, 100)
        .expect("cleanup grace");
    assert_eq!(
        store
            .resolve_manifest(&baseline.snapshot_ref)
            .expect("resolve")
            .state,
        SnapshotResolutionState::CleanupPending
    );
    store
        .sweep(100 + 7 * 24 * 60 * 60)
        .expect("expire baseline");
    assert_eq!(
        store
            .resolve_manifest(&baseline.snapshot_ref)
            .expect("expired")
            .state,
        SnapshotResolutionState::Expired
    );
    assert_eq!(regular_file_count(&root.join("blobs")), 1);

    store
        .start_cleanup_grace(&target.snapshot_ref, 200)
        .expect("target grace");
    store.sweep(200 + 7 * 24 * 60 * 60).expect("expire target");
    assert_eq!(regular_file_count(&root.join("blobs")), 0);
    assert_eq!(
        store
            .resolve_text(&target.snapshot_ref, &entry(&target, "demo.txt").file_ref)
            .expect("expired text")
            .state,
        SnapshotTextResolutionState::SnapshotExpired
    );

    fs::create_dir(root.join("staging/orphan")).expect("orphan staging");
    fs::write(root.join("staging/orphan/payload"), "orphan").expect("orphan payload");
    store.sweep(999_999).expect("startup-style sweep");
    assert!(!root.join("staging/orphan").exists());
}

#[test]
fn hard_path_limit_fails_without_publishing_payloads() {
    let project = tempfile::tempdir().expect("project");
    let backend = tempfile::tempdir().expect("backend");
    for index in 0..=crate::project_file_policy::MAX_ADMITTED_PROJECT_FILES {
        fs::write(project.path().join(format!("{index:04}.txt")), "").expect("fixture file");
    }
    let root = backend.path().join("snapshots");
    let store = TaskReviewSnapshotStore::new(&root).expect("store");
    assert!(store
        .capture_root(project.path(), request(SnapshotRole::Baseline, 10))
        .expect_err("path cap")
        .to_string()
        .contains("path capture limit"));
    assert_eq!(regular_file_count(&root.join("manifests")), 0);
    assert_eq!(regular_file_count(&root.join("blobs")), 0);
    assert_eq!(regular_file_count(&root.join("retention")), 0);
}

#[test]
fn public_capture_resolves_the_server_owned_project_location() {
    let project = tempfile::tempdir().expect("project");
    let state_dir = tempfile::tempdir().expect("state");
    let backend = tempfile::tempdir().expect("backend");
    fs::write(project.path().join("demo.rs"), "fn demo() {}\n").expect("source");
    let state = ServerStateService::new(SqliteBackend::new(state_dir.path().join("state.sqlite")));
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed");
    set_project_location(&state, project.path());
    let store = TaskReviewSnapshotStore::new(backend.path().join("snapshots")).expect("store");

    let manifest = store
        .capture(&state, request(SnapshotRole::Baseline, 10))
        .expect("state-resolved capture");
    assert_eq!(manifest.files.len(), 1);
    assert_eq!(manifest.files[0].display_path, "demo.rs");
}

fn set_project_location<B>(state: &ServerStateService<B>, location: &Path)
where
    B: LocalStoreBackend,
{
    let id = PersistenceRecordId("project:nucleus-local".to_owned());
    let mut record = state.projects().get(&id).expect("get").expect("project");
    let previous = record.revision_id.clone();
    let mut project = decode_project_storage_record(&record.payload.bytes).expect("decode");
    project.primary_location = Some(location.to_string_lossy().into_owned());
    record.revision_id = RevisionId("rev:snapshot-test".to_owned());
    record.payload = nucleus_local_store::LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes: encode_project_storage_payload(&project).expect("encode"),
    };
    state
        .projects()
        .put(record, RevisionExpectation::Exact(previous))
        .expect("put");
}
