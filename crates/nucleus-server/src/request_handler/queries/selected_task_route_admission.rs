use nucleus_local_store::LocalStoreBackend;

use super::selected_task_operator_action_gate;
use super::selected_task_review_outcome_route;
use super::LocalControlRequestHandler;
use crate::control_api::{
    SelectedTaskOperatorActionGateQuery, SelectedTaskReviewOutcomeRouteQuery,
    SelectedTaskRouteAdmissionQuery, ServerControlError, ServerQueryResult,
};
use crate::{selected_task_route_admission, SelectedTaskRouteAdmissionInput};

pub(crate) fn selected_task_route_admission_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: SelectedTaskRouteAdmissionQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if query.project_id.0.trim().is_empty()
        || query.task_id.0.trim().is_empty()
        || query.operator_ref.trim().is_empty()
    {
        return Err(ServerControlError::InvalidRequest {
            reason:
                "selected task route admission query requires project id, task id, and operator ref"
                    .to_owned(),
        });
    }

    let route = selected_task_review_outcome_route::selected_task_review_outcome_route_query(
        handler,
        SelectedTaskReviewOutcomeRouteQuery {
            project_id: query.project_id.clone(),
            task_id: query.task_id.clone(),
        },
    )?;
    let ServerQueryResult::SelectedTaskReviewOutcomeRoute(route) = route else {
        return Err(ServerControlError::InvalidRequest {
            reason: "selected task review outcome route query returned an unexpected result"
                .to_owned(),
        });
    };

    let gate = selected_task_operator_action_gate::selected_task_operator_action_gate_query(
        handler,
        SelectedTaskOperatorActionGateQuery {
            project_id: query.project_id,
            task_id: query.task_id,
        },
    )?;
    let ServerQueryResult::SelectedTaskOperatorActionGate(gate) = gate else {
        return Err(ServerControlError::InvalidRequest {
            reason: "selected task operator action gate query returned an unexpected result"
                .to_owned(),
        });
    };

    Ok(ServerQueryResult::SelectedTaskRouteAdmission(
        selected_task_route_admission(SelectedTaskRouteAdmissionInput {
            route,
            gate,
            expected_revision: query.expected_revision,
            operator_ref: query.operator_ref,
        }),
    ))
}
