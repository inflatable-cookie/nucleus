use nucleus_engine::{EngineCheckpointRecord, EngineCheckpointRef, EngineDiffSummaryRecord};
use nucleus_local_store::LocalStoreBackend;
use std::path::{Component, Path};

use crate::checkpoint_diff_state::{read_checkpoint_records, read_diff_summary_records};
use crate::task_agent_work_unit_state::read_task_agent_work_unit_source_records;
use crate::ServerStateService;

use super::types::TaskDiffOverviewRequest;

pub(super) struct ResolvedTaskDiff {
    pub diff: EngineDiffSummaryRecord,
    pub baseline: EngineCheckpointRecord,
    pub target: EngineCheckpointRecord,
}

pub(super) fn resolve<B>(
    state: &ServerStateService<B>,
    request: &TaskDiffOverviewRequest,
) -> Result<ResolvedTaskDiff, String>
where
    B: LocalStoreBackend,
{
    let diff = read_diff_summary_records(state)
        .map_err(|error| format!("task diff lookup failed: {error:?}"))?
        .into_iter()
        .find(|diff| diff.diff_id.0 == request.diff_id)
        .ok_or_else(|| "task diff was not found".to_owned())?;
    if diff.source_ref
        != Some(EngineCheckpointRef::WorkItemId(
            request.work_item_id.clone(),
        ))
    {
        return Err("task diff work-item lineage mismatch".to_owned());
    }
    for change in &diff.path_changes {
        let path = Path::new(&change.display_path);
        if !change.file_ref.starts_with("project-file:")
            || path.is_absolute()
            || path.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err("task diff contains an unsafe changed-file record".to_owned());
        }
    }
    let baseline_id = checkpoint_id(&diff.source_boundary_ref)?;
    let target_id = checkpoint_id(&diff.target_boundary_ref)?;
    let checkpoints = read_checkpoint_records(state)
        .map_err(|error| format!("task checkpoint lookup failed: {error:?}"))?;
    let baseline = checkpoints
        .iter()
        .find(|record| record.checkpoint_id.0 == baseline_id)
        .cloned()
        .ok_or_else(|| "baseline checkpoint was not found".to_owned())?;
    let target = checkpoints
        .iter()
        .find(|record| record.checkpoint_id.0 == target_id)
        .cloned()
        .ok_or_else(|| "target checkpoint was not found".to_owned())?;
    validate_checkpoint(&baseline, request)?;
    validate_checkpoint(&target, request)?;

    let latest = read_task_agent_work_unit_source_records(state)
        .map_err(|error| format!("task work-item lookup failed: {error:?}"))?
        .into_iter()
        .filter(|record| record.work_item_id.0 == request.work_item_id)
        .max_by(|left, right| left.source_cursor.0.cmp(&right.source_cursor.0))
        .ok_or_else(|| "task work item was not found".to_owned())?;
    if latest.project_id.0 != request.project_id || latest.task_id.0 != request.task_id {
        return Err("task work-item project/task lineage mismatch".to_owned());
    }
    if !latest.refs.checkpoint_ids.contains(&baseline.checkpoint_id)
        || !latest.refs.checkpoint_ids.contains(&target.checkpoint_id)
        || !latest.refs.diff_summary_ids.contains(&diff.diff_id)
    {
        return Err("task work item does not cite the requested review evidence".to_owned());
    }
    Ok(ResolvedTaskDiff {
        diff,
        baseline,
        target,
    })
}

fn checkpoint_id(value: &EngineCheckpointRef) -> Result<&str, String> {
    match value {
        EngineCheckpointRef::CheckpointId(value) => Ok(value),
        _ => Err("task diff boundary is not a checkpoint ref".to_owned()),
    }
}

fn validate_checkpoint(
    checkpoint: &EngineCheckpointRecord,
    request: &TaskDiffOverviewRequest,
) -> Result<(), String> {
    if checkpoint.primary_workflow_ref
        != EngineCheckpointRef::WorkItemId(request.work_item_id.clone())
        || checkpoint.project_ref != EngineCheckpointRef::ProjectId(request.project_id.clone())
        || !checkpoint
            .causal_refs
            .contains(&EngineCheckpointRef::TaskId(request.task_id.clone()))
    {
        return Err("task checkpoint lineage mismatch".to_owned());
    }
    Ok(())
}

pub(super) fn snapshot_ref(checkpoint: &EngineCheckpointRecord) -> Result<String, String> {
    match checkpoint.source_ref.as_ref() {
        Some(EngineCheckpointRef::SnapshotRef(value)) => Ok(value.clone()),
        _ => Err("task checkpoint has no source snapshot ref".to_owned()),
    }
}
