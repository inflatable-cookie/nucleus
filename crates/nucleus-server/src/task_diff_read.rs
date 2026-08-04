mod lineage;
mod patch;
mod types;

pub use types::{
    TaskDiffCountsDto, TaskDiffFileDto, TaskDiffFilePatchRequest, TaskDiffFilePatchResponse,
    TaskDiffOverviewRequest, TaskDiffOverviewResponse, TaskDiffPatchState,
};

use nucleus_local_store::LocalStoreBackend;

use crate::task_review_snapshots::SnapshotRef;
use crate::{ServerStateService, TaskReviewSnapshotStore};

pub fn read_task_diff_overview<B>(
    state: &ServerStateService<B>,
    store: Option<&TaskReviewSnapshotStore>,
    request: &TaskDiffOverviewRequest,
) -> Result<TaskDiffOverviewResponse, String>
where
    B: LocalStoreBackend,
{
    let lineage = lineage::resolve(state, request)?;
    let resource_id = review_resource_id(store, &lineage)?;
    Ok(types::overview(&lineage.diff, resource_id))
}

fn review_resource_id(
    store: Option<&TaskReviewSnapshotStore>,
    lineage: &lineage::ResolvedTaskDiff,
) -> Result<Option<String>, String> {
    let Some(store) = store else {
        return Ok(None);
    };
    let baseline_ref = SnapshotRef(lineage::snapshot_ref(&lineage.baseline)?);
    let target_ref = SnapshotRef(lineage::snapshot_ref(&lineage.target)?);
    let baseline = store
        .resolve_manifest(&baseline_ref)
        .map_err(|error| format!("baseline snapshot resolution failed: {error}"))?;
    let target = store
        .resolve_manifest(&target_ref)
        .map_err(|error| format!("target snapshot resolution failed: {error}"))?;
    shared_resource_id(
        baseline
            .manifest
            .as_ref()
            .and_then(|manifest| manifest.resource_id.as_deref()),
        target
            .manifest
            .as_ref()
            .and_then(|manifest| manifest.resource_id.as_deref()),
    )
}

fn shared_resource_id(
    baseline: Option<&str>,
    target: Option<&str>,
) -> Result<Option<String>, String> {
    match (baseline, target) {
        (Some(baseline), Some(target)) if baseline == target => Ok(Some(baseline.to_owned())),
        (Some(_), Some(_)) => Err("task diff snapshot resource lineage mismatch".to_owned()),
        _ => Ok(None),
    }
}

pub fn read_task_diff_file_patch<B>(
    state: &ServerStateService<B>,
    store: &TaskReviewSnapshotStore,
    request: &TaskDiffFilePatchRequest,
) -> Result<TaskDiffFilePatchResponse, String>
where
    B: LocalStoreBackend,
{
    let lineage = lineage::resolve(state, &request.overview_request())?;
    let change = lineage
        .diff
        .path_changes
        .iter()
        .find(|change| change.file_ref == request.file_ref)
        .ok_or_else(|| "changed-file ref is not linked to the requested diff".to_owned())?;
    patch::render(store, &lineage, change)
}

#[cfg(test)]
mod tests;
