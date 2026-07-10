mod lineage;
mod patch;
mod types;

pub use types::{
    TaskDiffCountsDto, TaskDiffFileDto, TaskDiffFilePatchRequest, TaskDiffFilePatchResponse,
    TaskDiffOverviewRequest, TaskDiffOverviewResponse, TaskDiffPatchState,
};

use nucleus_local_store::LocalStoreBackend;

use crate::{ServerStateService, TaskReviewSnapshotStore};

pub fn read_task_diff_overview<B>(
    state: &ServerStateService<B>,
    request: &TaskDiffOverviewRequest,
) -> Result<TaskDiffOverviewResponse, String>
where
    B: LocalStoreBackend,
{
    let lineage = lineage::resolve(state, request)?;
    Ok(types::overview(&lineage.diff))
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
