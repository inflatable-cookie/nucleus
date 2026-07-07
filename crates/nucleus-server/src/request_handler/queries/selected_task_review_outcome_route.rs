use nucleus_local_store::LocalStoreBackend;

use super::task_workflow_drilldown;
use super::{storage_error, LocalControlRequestHandler};
use crate::control_api::{
    SelectedTaskReviewOutcomeRouteQuery, ServerControlError, ServerQueryResult,
    TaskWorkflowDrilldownQuery,
};
use crate::{
    read_selected_task_review_decisions, selected_task_review_next,
    selected_task_review_outcome_route, selected_task_scm_handoff_readiness,
    SelectedTaskReviewOutcomeRouteInput,
};

pub(crate) fn selected_task_review_outcome_route_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: SelectedTaskReviewOutcomeRouteQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if query.project_id.0.trim().is_empty() || query.task_id.0.trim().is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "selected task review outcome route query requires project and task ids"
                .to_owned(),
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

    let review_next = selected_task_review_next(&drilldown);
    let scm_handoff = selected_task_scm_handoff_readiness(&drilldown);
    let decisions = read_selected_task_review_decisions(handler.state()).map_err(storage_error)?;

    Ok(ServerQueryResult::SelectedTaskReviewOutcomeRoute(
        selected_task_review_outcome_route(SelectedTaskReviewOutcomeRouteInput {
            review_next,
            decision_records: decisions,
            scm_handoff_refs: scm_handoff.readiness.handoff_refs,
        }),
    ))
}
