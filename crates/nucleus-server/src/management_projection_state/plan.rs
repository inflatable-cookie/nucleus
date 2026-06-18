use nucleus_engine::{export_project_task_projection, ManagementProjectionExportPlan};
use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

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
