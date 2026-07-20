use nucleus_engine::{export_project_task_projection, ManagementProjectionExportPlan};
use nucleus_local_store::{LocalStoreBackend, LocalStoreError, LocalStoreResult};

use crate::state::ServerStateService;

use super::helpers::{read_project_projection_records, read_task_projection_records};

pub fn build_management_projection_export_plan<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<ManagementProjectionExportPlan>
where
    B: LocalStoreBackend,
{
    let projects = read_project_projection_records(state)?;
    let tasks = read_task_projection_records(state)?;

    Ok(export_project_task_projection(&projects, &tasks))
}

pub fn build_project_management_projection_export_plan<B>(
    state: &ServerStateService<B>,
    project_id: &str,
) -> LocalStoreResult<ManagementProjectionExportPlan>
where
    B: LocalStoreBackend,
{
    let projects = read_project_projection_records(state)?
        .into_iter()
        .filter(|project| project.project_id == project_id)
        .collect::<Vec<_>>();
    if projects.is_empty() {
        return Err(LocalStoreError::InvalidRecord {
            reason: format!("project not found for management projection: {project_id}"),
        });
    }
    let tasks = read_task_projection_records(state)?
        .into_iter()
        .filter(|task| task.project_id == project_id)
        .collect::<Vec<_>>();

    Ok(export_project_task_projection(&projects, &tasks))
}
