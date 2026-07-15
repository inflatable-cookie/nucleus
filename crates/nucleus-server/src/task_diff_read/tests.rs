use std::fs;
use std::path::Path;

use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_engine::{
    EngineCheckpointFamily, EngineCheckpointRecord, EngineCheckpointRecordId,
    EngineCheckpointRecoveryState, EngineCheckpointRef, EngineTaskAgentWorkUnitReviewStatus,
    EngineTaskAgentWorkUnitRuntimeStatus, EngineTaskAgentWorkUnitSourceCursor,
    EngineTaskAgentWorkUnitSourceId, EngineTaskAgentWorkUnitSourceRecord, EngineTaskWorkItemId,
    EngineTaskWorkItemRefs,
};
use nucleus_local_store::{LocalStoreBackend, RevisionExpectation, SqliteBackend};
use nucleus_projects::{decode_project_storage_record, encode_project_storage_payload, ProjectId};
use nucleus_tasks::TaskId;

use super::*;
use crate::checkpoint_diff_state::{write_checkpoint_record, write_diff_summary_record};
use crate::task_agent_work_unit_state::write_task_agent_work_unit_source_record;
use crate::task_review_diff::{compose_task_review_diff, TaskReviewDiffInput};
use crate::task_review_snapshots::{
    SnapshotRole, TaskReviewSnapshotCaptureRequest, TaskReviewSnapshotStore,
};
use crate::{seed_local_project, LocalProjectSeed, ServerStateService};

const PROJECT_ID: &str = "project:nucleus-local";
const TASK_ID: &str = "task:nucleus-local:diff";
const WORK_ITEM_ID: &str = "work-item:diff:test";
const DIFF_ID: &str = "diff:work-item:diff:test";

struct Fixture {
    _project: tempfile::TempDir,
    _state_dir: tempfile::TempDir,
    backend: tempfile::TempDir,
    state: ServerStateService<SqliteBackend>,
    store: TaskReviewSnapshotStore,
    request: TaskDiffOverviewRequest,
    file_ref: String,
    baseline_snapshot_ref: crate::task_review_snapshots::SnapshotRef,
    target_snapshot_ref: crate::task_review_snapshots::SnapshotRef,
}

fn fixture(before: &[u8], after: &[u8]) -> Fixture {
    let project = tempfile::tempdir().expect("project");
    let state_dir = tempfile::tempdir().expect("state");
    let backend = tempfile::tempdir().expect("backend");
    let state = ServerStateService::new(SqliteBackend::new(state_dir.path().join("state.sqlite")));
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
    set_project_location(&state, project.path());
    fs::write(project.path().join("demo.txt"), before).expect("baseline file");
    let store = TaskReviewSnapshotStore::new(backend.path().join("snapshots")).expect("store");
    let baseline = store
        .capture(
            &state,
            TaskReviewSnapshotCaptureRequest {
                project_id: PROJECT_ID.to_owned(),
                resource_id: None,
                work_item_id: WORK_ITEM_ID.to_owned(),
                role: SnapshotRole::Baseline,
                created_at_unix_seconds: 1,
            },
        )
        .expect("baseline");
    fs::write(project.path().join("demo.txt"), after).expect("target file");
    let target = store
        .capture(
            &state,
            TaskReviewSnapshotCaptureRequest {
                project_id: PROJECT_ID.to_owned(),
                resource_id: None,
                work_item_id: WORK_ITEM_ID.to_owned(),
                role: SnapshotRole::Target,
                created_at_unix_seconds: 2,
            },
        )
        .expect("target");
    let baseline_id = EngineCheckpointRecordId("checkpoint:diff:baseline".to_owned());
    let target_id = EngineCheckpointRecordId("checkpoint:diff:target".to_owned());
    write_checkpoint(&state, &baseline_id, &baseline.snapshot_ref.0);
    write_checkpoint(&state, &target_id, &target.snapshot_ref.0);
    let diff = compose_task_review_diff(TaskReviewDiffInput {
        diff_id: DIFF_ID.to_owned(),
        work_item_id: WORK_ITEM_ID,
        command_id: "command:diff:test",
        baseline_checkpoint_id: &baseline_id.0,
        target_checkpoint_id: &target_id.0,
        baseline: &baseline,
        target: &target,
    });
    let file_ref = diff.path_changes[0].file_ref.clone();
    write_diff_summary_record(
        &state,
        &diff,
        RevisionId("rev:diff:test".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write diff");
    write_source(&state, baseline_id, target_id, diff.diff_id.clone());
    store
        .mark_awaiting_review(&baseline.snapshot_ref)
        .expect("baseline retention");
    store
        .mark_awaiting_review(&target.snapshot_ref)
        .expect("target retention");
    Fixture {
        _project: project,
        _state_dir: state_dir,
        backend,
        state,
        store,
        request: TaskDiffOverviewRequest {
            project_id: PROJECT_ID.to_owned(),
            task_id: TASK_ID.to_owned(),
            work_item_id: WORK_ITEM_ID.to_owned(),
            diff_id: DIFF_ID.to_owned(),
        },
        file_ref,
        baseline_snapshot_ref: baseline.snapshot_ref,
        target_snapshot_ref: target.snapshot_ref,
    }
}

#[test]
fn overview_is_metadata_only_and_patch_is_lineage_authorized() {
    let fixture = fixture(b"old\n", b"new\n");
    let overview = read_task_diff_overview(&fixture.state, &fixture.request).expect("overview");
    assert_eq!(overview.files.len(), 1);
    assert_eq!(overview.files[0].display_path, "demo.txt");
    assert!(!serde_json::to_string(&overview)
        .expect("json")
        .contains("patch"));

    let patch = read_task_diff_file_patch(&fixture.state, &fixture.store, &patch_request(&fixture))
        .expect("patch");
    assert_eq!(patch.state, TaskDiffPatchState::Available);
    assert_eq!(patch.additions, 1);
    assert_eq!(patch.deletions, 1);
    let text = patch.patch.expect("patch text");
    assert!(text.contains("--- a/demo.txt"));
    assert!(text.contains("+++ b/demo.txt"));
    assert!(!text.contains(fixture._project.path().to_string_lossy().as_ref()));

    let mut mismatched = fixture.request.clone();
    mismatched.task_id = "task:other".to_owned();
    assert!(read_task_diff_overview(&fixture.state, &mismatched)
        .expect_err("lineage mismatch")
        .contains("lineage"));
}

#[test]
fn binary_missing_and_expired_states_are_explicit() {
    let binary = fixture(b"text\n", b"a\0b");
    assert_eq!(
        read_task_diff_file_patch(&binary.state, &binary.store, &patch_request(&binary))
            .expect("binary")
            .state,
        TaskDiffPatchState::Binary
    );

    let oversized_bytes = vec![b'x'; 2 * 1024 * 1024 + 1];
    let oversized = fixture(b"text\n", &oversized_bytes);
    assert_eq!(
        read_task_diff_file_patch(
            &oversized.state,
            &oversized.store,
            &patch_request(&oversized),
        )
        .expect("oversized")
        .state,
        TaskDiffPatchState::Oversized
    );

    let missing = fixture(b"old\n", b"new\n");
    for entry in fs::read_dir(missing.backend.path().join("snapshots/blobs")).expect("blobs") {
        fs::remove_file(entry.expect("blob").path()).expect("remove blob");
    }
    assert_eq!(
        read_task_diff_file_patch(&missing.state, &missing.store, &patch_request(&missing))
            .expect("missing")
            .state,
        TaskDiffPatchState::Missing
    );

    let expired = fixture(b"old\n", b"new\n");
    expired
        .store
        .start_cleanup_grace(&expired.baseline_snapshot_ref, 10)
        .expect("baseline grace");
    expired
        .store
        .start_cleanup_grace(&expired.target_snapshot_ref, 10)
        .expect("target grace");
    expired.store.sweep(10 + 7 * 24 * 60 * 60).expect("expire");
    assert_eq!(
        read_task_diff_file_patch(&expired.state, &expired.store, &patch_request(&expired))
            .expect("expired")
            .state,
        TaskDiffPatchState::Expired
    );
}

#[test]
fn patch_output_is_bounded_for_long_lines() {
    let before = vec![b'a'; 2 * 1024 * 1024];
    let after = vec![b'b'; 2 * 1024 * 1024];
    let fixture = fixture(&before, &after);
    let patch = read_task_diff_file_patch(&fixture.state, &fixture.store, &patch_request(&fixture))
        .expect("bounded patch");
    assert_eq!(patch.state, TaskDiffPatchState::Truncated);
    assert!(patch.truncated);
    assert!(patch.patch.as_ref().expect("patch").len() <= 4 * 1024 * 1024);
    assert!(
        serde_json::to_vec(&patch)
            .expect("serialized response")
            .len()
            <= 4 * 1024 * 1024
    );
}

fn patch_request(fixture: &Fixture) -> TaskDiffFilePatchRequest {
    TaskDiffFilePatchRequest {
        project_id: fixture.request.project_id.clone(),
        task_id: fixture.request.task_id.clone(),
        work_item_id: fixture.request.work_item_id.clone(),
        diff_id: fixture.request.diff_id.clone(),
        file_ref: fixture.file_ref.clone(),
    }
}

fn write_checkpoint(
    state: &ServerStateService<SqliteBackend>,
    checkpoint_id: &EngineCheckpointRecordId,
    snapshot_ref: &str,
) {
    let record = EngineCheckpointRecord {
        checkpoint_id: checkpoint_id.clone(),
        family: EngineCheckpointFamily::TaskWork,
        primary_workflow_ref: EngineCheckpointRef::WorkItemId(WORK_ITEM_ID.to_owned()),
        project_ref: EngineCheckpointRef::ProjectId(PROJECT_ID.to_owned()),
        source_ref: Some(EngineCheckpointRef::SnapshotRef(snapshot_ref.to_owned())),
        scm_adapter_ref: None,
        authority_host_ref: EngineCheckpointRef::AuthorityHostId("host:local".to_owned()),
        created_by_actor_ref: EngineCheckpointRef::ActorId("actor:test".to_owned()),
        causal_refs: vec![EngineCheckpointRef::TaskId(TASK_ID.to_owned())],
        parent_checkpoint_refs: Vec::new(),
        artifact_refs: Vec::new(),
        summary: None,
        recovery_state: EngineCheckpointRecoveryState::Available,
    };
    write_checkpoint_record(
        state,
        &record,
        RevisionId(format!("rev:{}", checkpoint_id.0)),
        RevisionExpectation::MustNotExist,
    )
    .expect("write checkpoint");
}

fn write_source(
    state: &ServerStateService<SqliteBackend>,
    baseline_id: EngineCheckpointRecordId,
    target_id: EngineCheckpointRecordId,
    diff_id: nucleus_engine::EngineDiffSummaryRecordId,
) {
    let scheduled = EngineTaskAgentWorkUnitSourceRecord {
        source_id: EngineTaskAgentWorkUnitSourceId("source:diff:scheduled".to_owned()),
        source_cursor: EngineTaskAgentWorkUnitSourceCursor("cursor:diff:001".to_owned()),
        work_item_id: EngineTaskWorkItemId(WORK_ITEM_ID.to_owned()),
        project_id: ProjectId(PROJECT_ID.to_owned()),
        task_id: TaskId(TASK_ID.to_owned()),
        command_id: "command:diff:test".to_owned(),
        actor_ref: "actor:test".to_owned(),
        adapter_id: "codex-app-server".to_owned(),
        provider_instance_id: "codex:local".to_owned(),
        idempotency_key: "diff:test".to_owned(),
        task_revision: None,
        runtime: EngineTaskAgentWorkUnitRuntimeStatus::Scheduled,
        review: EngineTaskAgentWorkUnitReviewStatus::NotReady,
        refs: EngineTaskWorkItemRefs {
            checkpoint_ids: vec![baseline_id.clone()],
            ..EngineTaskWorkItemRefs::default()
        },
        previous_source_id: None,
        summary: "scheduled".to_owned(),
    };
    write_task_agent_work_unit_source_record(
        state,
        scheduled.clone(),
        RevisionId("rev:source:diff:scheduled".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write scheduled source");
    let running = EngineTaskAgentWorkUnitSourceRecord {
        source_id: EngineTaskAgentWorkUnitSourceId("source:diff:running".to_owned()),
        source_cursor: EngineTaskAgentWorkUnitSourceCursor("cursor:diff:002".to_owned()),
        runtime: EngineTaskAgentWorkUnitRuntimeStatus::Running,
        previous_source_id: Some(scheduled.source_id.clone()),
        summary: "running".to_owned(),
        ..scheduled
    };
    write_task_agent_work_unit_source_record(
        state,
        running.clone(),
        RevisionId("rev:source:diff:running".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write running source");
    let completed = EngineTaskAgentWorkUnitSourceRecord {
        source_id: EngineTaskAgentWorkUnitSourceId("source:diff:completed".to_owned()),
        source_cursor: EngineTaskAgentWorkUnitSourceCursor("cursor:diff:003".to_owned()),
        runtime: EngineTaskAgentWorkUnitRuntimeStatus::Completed,
        review: EngineTaskAgentWorkUnitReviewStatus::AwaitingReview,
        refs: EngineTaskWorkItemRefs {
            checkpoint_ids: vec![baseline_id, target_id],
            diff_summary_ids: vec![diff_id],
            ..EngineTaskWorkItemRefs::default()
        },
        previous_source_id: Some(running.source_id.clone()),
        summary: "review ready".to_owned(),
        ..running
    };
    write_task_agent_work_unit_source_record(
        state,
        completed,
        RevisionId("rev:source:diff:completed".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write completed source");
}

fn set_project_location<B>(state: &ServerStateService<B>, location: &Path)
where
    B: LocalStoreBackend,
{
    let id = PersistenceRecordId(PROJECT_ID.to_owned());
    let mut record = state.projects().get(&id).expect("get").expect("project");
    let previous = record.revision_id.clone();
    let mut project = decode_project_storage_record(&record.payload.bytes).expect("decode");
    let resource = project.resources.first_mut().expect("seed resource");
    resource.current_locator = Some(location.to_string_lossy().into_owned());
    record.revision_id = RevisionId("rev:diff-project".to_owned());
    record.payload = nucleus_local_store::LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes: encode_project_storage_payload(&project).expect("encode"),
    };
    state
        .projects()
        .put(record, RevisionExpectation::Exact(previous))
        .expect("put");
}
