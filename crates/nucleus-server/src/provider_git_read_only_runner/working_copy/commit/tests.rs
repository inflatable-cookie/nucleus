use std::path::Path;
use std::process::Command;

use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_local_store::{RevisionExpectation, SqliteBackend};
use nucleus_projects::{decode_project_storage_record, encode_project_storage_payload};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use crate::{seed_local_project, LocalProjectSeed, ServerStateService};

use super::*;
use crate::provider_git_read_only_runner::{
    mutate_scm_working_copy, ScmWorkingCopyMutationAction, ScmWorkingCopyMutationRequest,
};

#[test]
fn commit_captures_only_the_staged_index_and_replays_without_hooks() {
    let directory = tempfile::tempdir().expect("directory");
    let repo = directory.path().join("repo");
    std::fs::create_dir(&repo).expect("repo");
    run_git(&repo, &["init"]);
    run_git(&repo, &["config", "user.name", "Nucleus Test"]);
    run_git(&repo, &["config", "user.email", "nucleus@example.invalid"]);
    run_git(&repo, &["config", "commit.gpgSign", "true"]);
    #[cfg(unix)]
    install_failing_hook(&repo);
    std::fs::write(repo.join("file.txt"), "staged\n").expect("file");

    let state = ServerStateService::new(SqliteBackend::new(directory.path().join("state.sqlite")));
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed");
    let resource_id = point_seeded_project_at(&state, &repo);
    let inspection_request = ScmWorkingCopyInspectionRequest {
        project_id: "project:nucleus-local".to_owned(),
        resource_id: resource_id.clone(),
    };
    let before_stage = inspect_scm_working_copy(&state, &inspection_request);
    mutate_scm_working_copy(
        &state,
        "host:embedded-desktop",
        "operator:test",
        &ScmWorkingCopyMutationRequest {
            project_id: inspection_request.project_id.clone(),
            resource_id: resource_id.clone(),
            action: ScmWorkingCopyMutationAction::Stage,
            paths: vec!["file.txt".to_owned()],
            expected_status_fingerprint: before_stage
                .status_fingerprint
                .expect("stage fingerprint"),
            idempotency_key: "stage-before-commit".to_owned(),
        },
    )
    .expect("stage");
    std::fs::write(repo.join("file.txt"), "working\n").expect("working edit");
    let before_commit = inspect_scm_working_copy(&state, &inspection_request);
    assert!(before_commit.files[0].staged);
    assert!(before_commit.files[0].unstaged);
    let request = ScmWorkingCopyCommitRequest {
        project_id: inspection_request.project_id.clone(),
        resource_id: resource_id.clone(),
        message: "Capture the staged file".to_owned(),
        expected_status_fingerprint: before_commit
            .status_fingerprint
            .clone()
            .expect("commit fingerprint"),
        idempotency_key: "commit-staged-file".to_owned(),
    };

    let committed =
        commit_scm_working_copy(&state, "host:embedded-desktop", "operator:test", &request)
            .expect("commit");

    assert!(!committed.receipt.replayed);
    assert_eq!(committed.receipt.staged_paths, vec!["file.txt"]);
    #[cfg(unix)]
    assert!(!repo.join("hook-ran").exists());
    assert_eq!(git_output(&repo, &["show", "HEAD:file.txt"]), "staged\n");
    assert_eq!(
        std::fs::read_to_string(repo.join("file.txt")).expect("working file"),
        "working\n"
    );
    assert_eq!(
        git_output(&repo, &["log", "-1", "--pretty=%B"]),
        "Capture the staged file\n\n"
    );
    assert!(committed.inspection.files[0].unstaged);
    assert!(!committed.inspection.files[0].staged);
    let encoded = serde_json::to_string(&committed.receipt).expect("receipt");
    assert!(!encoded.contains("Capture the staged file"));

    let replay =
        commit_scm_working_copy(&state, "host:embedded-desktop", "operator:test", &request)
            .expect("replay");
    assert!(replay.receipt.replayed);
    assert_eq!(replay.receipt.commit_oid, committed.receipt.commit_oid);
    assert_eq!(git_output(&repo, &["rev-list", "--count", "HEAD"]), "1\n");

    let mut rebound = request.clone();
    rebound.message = "Different message".to_owned();
    assert!(
        commit_scm_working_copy(&state, "host:embedded-desktop", "operator:test", &rebound,)
            .expect_err("key rebound")
            .contains("already bound")
    );

    let no_staged = ScmWorkingCopyCommitRequest {
        idempotency_key: "commit-without-staged".to_owned(),
        expected_status_fingerprint: committed
            .inspection
            .status_fingerprint
            .expect("post-commit fingerprint"),
        ..request.clone()
    };
    assert!(
        commit_scm_working_copy(&state, "host:embedded-desktop", "operator:test", &no_staged,)
            .expect_err("no staged")
            .contains("requires staged")
    );

    let wrong_host = ScmWorkingCopyCommitRequest {
        idempotency_key: "wrong-host".to_owned(),
        ..request
    };
    assert!(
        commit_scm_working_copy(&state, "host:other", "operator:test", &wrong_host)
            .expect_err("wrong host")
            .contains("authority host")
    );
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
    record.revision_id = RevisionId("rev:forge-commit".to_owned());
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

fn git_output(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git");
    assert!(output.status.success());
    String::from_utf8(output.stdout).expect("utf8")
}

#[cfg(unix)]
fn install_failing_hook(repo: &Path) {
    let hook = repo.join(".git/hooks/pre-commit");
    std::fs::write(
        &hook,
        format!(
            "#!/bin/sh\ntouch '{}'\nexit 1\n",
            repo.join("hook-ran").display()
        ),
    )
    .expect("hook");
    let mut permissions = std::fs::metadata(&hook)
        .expect("hook metadata")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&hook, permissions).expect("hook permissions");
}
