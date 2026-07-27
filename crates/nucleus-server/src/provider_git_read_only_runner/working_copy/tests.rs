use std::path::Path;

use super::*;
use crate::{seed_local_project, LocalProjectSeed};
use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_local_store::{RevisionExpectation, SqliteBackend};
use nucleus_projects::{decode_project_storage_record, encode_project_storage_payload};

#[test]
fn parser_preserves_branch_divergence_and_changed_file_semantics() {
    let root = tempfile::tempdir().expect("root");
    std::fs::write(root.path().join("tracked.txt"), "changed").expect("file");
    std::fs::write(root.path().join("new.txt"), "new").expect("file");
    let request = ScmWorkingCopyInspectionRequest {
        project_id: "project:test".to_owned(),
        resource_id: "resource:test".to_owned(),
    };
    let output = concat!(
        "# branch.oid abc123\0",
        "# branch.head main\0",
        "# branch.upstream origin/main\0",
        "# branch.ab +2 -1\0",
        "1 M. N... 100644 100644 100644 abc def tracked.txt\0",
        "? new.txt\0",
        "1 .D N... 100644 100644 000000 abc def gone.txt\0",
    );

    let inspection =
        parse_working_copy_status(&request, root.path(), output.as_bytes(), "git-index:test")
            .expect("parse");

    assert_eq!(inspection.branch.as_deref(), Some("main"));
    assert_eq!(inspection.upstream.as_deref(), Some("origin/main"));
    assert_eq!(inspection.ahead, 2);
    assert_eq!(inspection.behind, 1);
    assert_eq!(inspection.files.len(), 3);
    assert!(inspection.files[0].staged);
    assert!(!inspection.files[0].unstaged);
    assert!(inspection.files[0].file_ref.is_some());
    assert_eq!(
        inspection.files[1].change_kind,
        ScmWorkingCopyChangeKind::Untracked
    );
    assert_eq!(inspection.files[2].file_ref, None);
}

#[test]
fn inspection_resolves_the_exact_project_resource_and_reads_git_status() {
    let directory = tempfile::tempdir().expect("directory");
    let repo = directory.path().join("repo");
    std::fs::create_dir(&repo).expect("repo");
    run_git(&repo, &["init"]);
    std::fs::write(repo.join("new.txt"), "new").expect("file");

    let state = ServerStateService::new(SqliteBackend::new(directory.path().join("state.sqlite")));
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed");
    let id = PersistenceRecordId("project:nucleus-local".to_owned());
    let mut record = state.projects().get(&id).expect("get").expect("project");
    let previous = record.revision_id.clone();
    let mut project = decode_project_storage_record(&record.payload.bytes).expect("decode");
    let resource = project.resources.first_mut().expect("resource");
    resource.current_locator = Some(repo.to_string_lossy().into_owned());
    resource.location_status = nucleus_projects::ProjectResourceStorageLocationStatus::Present;
    let resource_id = resource.resource_id.clone();
    record.revision_id = RevisionId("rev:forge-working-copy".to_owned());
    record.payload = nucleus_local_store::LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes: encode_project_storage_payload(&project).expect("encode"),
    };
    state
        .projects()
        .put(record, RevisionExpectation::Exact(previous))
        .expect("put");

    let inspection = inspect_scm_working_copy(
        &state,
        &ScmWorkingCopyInspectionRequest {
            project_id: "project:nucleus-local".to_owned(),
            resource_id: resource_id.clone(),
        },
    );

    assert_eq!(inspection.state, ScmWorkingCopyInspectionState::Ready);
    assert_eq!(inspection.files.len(), 1);
    assert_eq!(
        inspection.files[0].change_kind,
        ScmWorkingCopyChangeKind::Untracked
    );

    let diff = read_scm_working_copy_diff(
        &state,
        &ScmWorkingCopyDiffRequest {
            project_id: "project:nucleus-local".to_owned(),
            resource_id,
            path: "new.txt".to_owned(),
            scope: ScmWorkingCopyDiffScope::All,
        },
    )
    .expect("diff");
    assert!(diff
        .patch
        .as_deref()
        .is_some_and(|patch| { patch.contains("diff --git") && patch.contains("+new") }));
    assert_eq!(diff.additions, 1);
    assert_eq!(diff.deletions, 0);
}

fn run_git(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .status()
        .expect("git");
    assert!(status.success());
}
