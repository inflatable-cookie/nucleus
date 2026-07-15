use std::time::{SystemTime, UNIX_EPOCH};

use nucleus_core::RevisionId;
use nucleus_engine::{
    EngineCheckpointFamily, EngineCheckpointRecord, EngineCheckpointRecordId,
    EngineCheckpointRecoveryState, EngineCheckpointRef, EngineDiffSummaryRecordId,
};
use nucleus_local_store::{LocalStoreBackend, RevisionExpectation};

use crate::checkpoint_diff_state::{write_checkpoint_record, write_diff_summary_record};
use crate::task_review_diff::{compose_task_review_diff, TaskReviewDiffInput};
use crate::task_review_snapshots::{
    SnapshotManifest, SnapshotRole, TaskReviewSnapshotCaptureRequest, TaskReviewSnapshotStore,
};
use crate::ServerStateService;

pub(super) struct TaskReviewEvidenceInput {
    pub project_id: String,
    pub resource_id: Option<String>,
    pub task_id: String,
    pub work_item_id: String,
    pub command_id: String,
    pub actor_ref: String,
}

pub(super) struct BaselineReviewEvidence {
    pub manifest: SnapshotManifest,
    pub checkpoint_id: EngineCheckpointRecordId,
}

pub(super) struct CompletedReviewEvidence {
    pub target_checkpoint_id: EngineCheckpointRecordId,
    pub diff_summary_id: EngineDiffSummaryRecordId,
}

pub(super) fn capture_baseline<B>(
    state: &ServerStateService<B>,
    store: Option<&TaskReviewSnapshotStore>,
    input: &TaskReviewEvidenceInput,
) -> Result<BaselineReviewEvidence, String>
where
    B: LocalStoreBackend,
{
    let store = store.ok_or_else(|| "task review snapshot backend is not configured".to_owned())?;
    let manifest = capture(state, store, input, SnapshotRole::Baseline)?;
    let checkpoint_id =
        EngineCheckpointRecordId(format!("checkpoint:{}:baseline", input.work_item_id));
    persist_checkpoint(
        state,
        input,
        &manifest,
        checkpoint_id.clone(),
        Vec::new(),
        "Task review baseline captured before provider dispatch.",
    )?;
    Ok(BaselineReviewEvidence {
        manifest,
        checkpoint_id,
    })
}

pub(super) fn capture_completed<B>(
    state: &ServerStateService<B>,
    store: &TaskReviewSnapshotStore,
    input: &TaskReviewEvidenceInput,
    baseline: &BaselineReviewEvidence,
) -> Result<CompletedReviewEvidence, String>
where
    B: LocalStoreBackend,
{
    let target = capture(state, store, input, SnapshotRole::Target)?;
    let target_checkpoint_id =
        EngineCheckpointRecordId(format!("checkpoint:{}:target", input.work_item_id));
    persist_checkpoint(
        state,
        input,
        &target,
        target_checkpoint_id.clone(),
        vec![EngineCheckpointRef::CheckpointId(
            baseline.checkpoint_id.0.clone(),
        )],
        "Task review target captured after provider completion.",
    )?;
    let diff_summary_id = EngineDiffSummaryRecordId(format!("diff:{}", input.work_item_id));
    let diff = compose_task_review_diff(TaskReviewDiffInput {
        diff_id: diff_summary_id.0.clone(),
        work_item_id: &input.work_item_id,
        command_id: &input.command_id,
        baseline_checkpoint_id: &baseline.checkpoint_id.0,
        target_checkpoint_id: &target_checkpoint_id.0,
        baseline: &baseline.manifest,
        target: &target,
    });
    write_diff_summary_record(
        state,
        &diff,
        RevisionId(format!("rev:{}", diff.diff_id.0)),
        RevisionExpectation::MustNotExist,
    )
    .map_err(|error| format!("task review diff persistence failed: {error:?}"))?;
    store
        .mark_awaiting_review(&baseline.manifest.snapshot_ref)
        .map_err(|error| format!("baseline retention update failed: {error}"))?;
    store
        .mark_awaiting_review(&target.snapshot_ref)
        .map_err(|error| format!("target retention update failed: {error}"))?;
    Ok(CompletedReviewEvidence {
        target_checkpoint_id,
        diff_summary_id,
    })
}

fn capture<B>(
    state: &ServerStateService<B>,
    store: &TaskReviewSnapshotStore,
    input: &TaskReviewEvidenceInput,
    role: SnapshotRole,
) -> Result<SnapshotManifest, String>
where
    B: LocalStoreBackend,
{
    store
        .capture(
            state,
            TaskReviewSnapshotCaptureRequest {
                project_id: input.project_id.clone(),
                resource_id: input.resource_id.clone(),
                work_item_id: input.work_item_id.clone(),
                role,
                created_at_unix_seconds: now_epoch_seconds()?,
            },
        )
        .map_err(|error| format!("task review snapshot capture failed: {error}"))
}

fn persist_checkpoint<B>(
    state: &ServerStateService<B>,
    input: &TaskReviewEvidenceInput,
    manifest: &SnapshotManifest,
    checkpoint_id: EngineCheckpointRecordId,
    parent_checkpoint_refs: Vec<EngineCheckpointRef>,
    summary: &str,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let record = EngineCheckpointRecord {
        checkpoint_id: checkpoint_id.clone(),
        family: EngineCheckpointFamily::TaskWork,
        primary_workflow_ref: EngineCheckpointRef::WorkItemId(input.work_item_id.clone()),
        project_ref: EngineCheckpointRef::ProjectId(input.project_id.clone()),
        source_ref: Some(EngineCheckpointRef::SnapshotRef(
            manifest.snapshot_ref.0.clone(),
        )),
        scm_adapter_ref: None,
        authority_host_ref: EngineCheckpointRef::AuthorityHostId(
            "authority-host:nucleus-local".to_owned(),
        ),
        created_by_actor_ref: EngineCheckpointRef::ActorId(input.actor_ref.clone()),
        causal_refs: vec![
            EngineCheckpointRef::TaskId(input.task_id.clone()),
            EngineCheckpointRef::CommandId(input.command_id.clone()),
        ],
        parent_checkpoint_refs,
        artifact_refs: Vec::new(),
        summary: Some(summary.to_owned()),
        recovery_state: EngineCheckpointRecoveryState::Available,
    };
    write_checkpoint_record(
        state,
        &record,
        RevisionId(format!("rev:{}", checkpoint_id.0)),
        RevisionExpectation::MustNotExist,
    )
    .map(|_| ())
    .map_err(|error| format!("task review checkpoint persistence failed: {error:?}"))
}

fn now_epoch_seconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "system clock is before the Unix epoch".to_owned())
}
