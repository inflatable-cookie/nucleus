use std::path::Path;
use std::process::Command;

use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_local_store::{RevisionExpectation, SqliteBackend};
use nucleus_projects::{decode_project_storage_record, encode_project_storage_payload};

use crate::{seed_local_project, LocalProjectSeed, ServerStateService};

use super::*;
use crate::provider_git_read_only_runner::{
    read_scm_working_copy_diff, ScmWorkingCopyDiffRequest, ScmWorkingCopyDiffScope,
};

#[test]
fn staging_is_observation_bound_idempotent_and_preserves_working_content() {
    let directory = tempfile::tempdir().expect("directory");
    let repo = directory.path().join("repo");
    std::fs::create_dir(&repo).expect("repo");
    run_git(&repo, &["init"]);
    std::fs::write(repo.join("new.txt"), "new\n").expect("file");

    let state = ServerStateService::new(SqliteBackend::new(directory.path().join("state.sqlite")));
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed");
    let resource_id = point_seeded_project_at(&state, &repo);
    let inspection_request = ScmWorkingCopyInspectionRequest {
        project_id: "project:nucleus-local".to_owned(),
        resource_id: resource_id.clone(),
    };
    let before = inspect_scm_working_copy(&state, &inspection_request);
    let before_fingerprint = before
        .status_fingerprint
        .clone()
        .expect("status fingerprint");
    let stage = ScmWorkingCopyMutationRequest {
        project_id: inspection_request.project_id.clone(),
        resource_id: resource_id.clone(),
        action: ScmWorkingCopyMutationAction::Stage,
        paths: vec!["new.txt".to_owned()],
        expected_status_fingerprint: before_fingerprint.clone(),
        idempotency_key: "stage-new-file".to_owned(),
    };

    let staged = mutate_scm_working_copy(&state, "host:embedded-desktop", "operator:test", &stage)
        .expect("stage");

    assert!(!staged.receipt.replayed);
    assert!(staged.inspection.files[0].staged);
    assert!(!staged.inspection.files[0].unstaged);
    assert!(state
        .artifact_metadata()
        .get(&PersistenceRecordId(staged.receipt.receipt_id.clone()))
        .expect("receipt lookup")
        .is_some());

    std::fs::write(repo.join("new.txt"), "newer\n").expect("working edit");
    let both = inspect_scm_working_copy(&state, &inspection_request);
    assert!(both.files[0].staged);
    assert!(both.files[0].unstaged);
    let staged_diff = scoped_diff(&state, &resource_id, ScmWorkingCopyDiffScope::Staged);
    let working_diff = scoped_diff(&state, &resource_id, ScmWorkingCopyDiffScope::Working);
    assert!(staged_diff.contains("+new"));
    assert!(!staged_diff.contains("+newer"));
    assert!(working_diff.contains("-new"));
    assert!(working_diff.contains("+newer"));

    let replay = mutate_scm_working_copy(&state, "host:embedded-desktop", "operator:test", &stage)
        .expect("replay");
    assert!(replay.receipt.replayed);
    assert!(replay.inspection.files[0].unstaged);

    let mut reused = stage.clone();
    reused.action = ScmWorkingCopyMutationAction::Unstage;
    reused.expected_status_fingerprint = both.status_fingerprint.clone().expect("both fingerprint");
    assert!(
        mutate_scm_working_copy(&state, "host:embedded-desktop", "operator:test", &reused,)
            .expect_err("key reuse")
            .contains("already bound")
    );

    let unstage = ScmWorkingCopyMutationRequest {
        idempotency_key: "unstage-new-file".to_owned(),
        ..reused
    };
    let unstaged =
        mutate_scm_working_copy(&state, "host:embedded-desktop", "operator:test", &unstage)
            .expect("unstage");
    assert!(!unstaged.inspection.files[0].staged);
    assert!(unstaged.inspection.files[0].unstaged);
    assert_eq!(
        std::fs::read_to_string(repo.join("new.txt")).expect("working content"),
        "newer\n"
    );

    std::fs::write(repo.join("another.txt"), "another\n").expect("second change");
    let stale = ScmWorkingCopyMutationRequest {
        idempotency_key: "stale-stage".to_owned(),
        ..stage.clone()
    };
    assert!(
        mutate_scm_working_copy(&state, "host:embedded-desktop", "operator:test", &stale,)
            .expect_err("stale observation")
            .contains("status changed")
    );
    let wrong_host = ScmWorkingCopyMutationRequest {
        expected_status_fingerprint: unstaged
            .inspection
            .status_fingerprint
            .expect("unstaged fingerprint"),
        idempotency_key: "wrong-host".to_owned(),
        ..stage
    };
    assert!(
        mutate_scm_working_copy(&state, "host:other", "operator:test", &wrong_host)
            .expect_err("authority host")
            .contains("authority host")
    );
}

fn scoped_diff(
    state: &ServerStateService<SqliteBackend>,
    resource_id: &str,
    scope: ScmWorkingCopyDiffScope,
) -> String {
    read_scm_working_copy_diff(
        state,
        &ScmWorkingCopyDiffRequest {
            project_id: "project:nucleus-local".to_owned(),
            resource_id: resource_id.to_owned(),
            path: "new.txt".to_owned(),
            scope,
        },
    )
    .expect("diff")
    .patch
    .expect("patch")
}

fn point_seeded_project_at(state: &ServerStateService<SqliteBackend>, repo: &Path) -> String {
    let id = PersistenceRecordId("project:nucleus-local".to_owned());
    let mut record = state.projects().get(&id).expect("get").expect("project");
    let previous = record.revision_id.clone();
    let mut project = decode_project_storage_record(&record.payload.bytes).expect("decode");
    let resource = project.resources.first_mut().expect("resource");
    resource.current_locator = Some(repo.to_string_lossy().into_owned());
    resource.location_status = nucleus_projects::ProjectResourceStorageLocationStatus::Present;
    let resource_id = resource.resource_id.clone();
    record.revision_id = RevisionId("rev:forge-mutation".to_owned());
    record.payload = nucleus_local_store::LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes: encode_project_storage_payload(&project).expect("encode"),
    };
    state
        .projects()
        .put(record, RevisionExpectation::Exact(previous))
        .expect("put");
    resource_id
}

fn run_git(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .status()
        .expect("git");
    assert!(status.success());
}
