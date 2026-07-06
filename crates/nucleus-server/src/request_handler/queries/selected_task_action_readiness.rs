use nucleus_local_store::LocalStoreBackend;

use super::task_workflow_drilldown;
use super::LocalControlRequestHandler;
use crate::control_api::{
    SelectedTaskActionReadinessQuery, ServerControlError, ServerQueryResult,
    TaskWorkflowDrilldownQuery,
};
use crate::selected_task_action_readiness;

pub(crate) fn selected_task_action_readiness_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: SelectedTaskActionReadinessQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if query.project_id.0.trim().is_empty() || query.task_id.0.trim().is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "selected task action readiness requires project and task ids".to_owned(),
        });
    }

    let drilldown = task_workflow_drilldown::task_workflow_drilldown_query(
        handler,
        TaskWorkflowDrilldownQuery {
            project_id: query.project_id,
            task_id: query.task_id,
        },
    )?;
    let ServerQueryResult::TaskWorkflowDrilldown(drilldown) = drilldown else {
        return Err(ServerControlError::InvalidRequest {
            reason: "task workflow drilldown query returned an unexpected result".to_owned(),
        });
    };

    Ok(ServerQueryResult::SelectedTaskActionReadiness(
        selected_task_action_readiness(&drilldown),
    ))
}
