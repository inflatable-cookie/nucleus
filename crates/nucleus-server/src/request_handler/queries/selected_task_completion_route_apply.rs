use nucleus_local_store::LocalStoreBackend;

use super::selected_task_operator_action_gate;
use super::selected_task_review_outcome_route;
use super::LocalControlRequestHandler;
use crate::control_api::{
    SelectedTaskCompletionRouteApplyQuery, SelectedTaskOperatorActionGateQuery,
    SelectedTaskReviewOutcomeRouteQuery, ServerControlError, ServerQueryResult,
};
use crate::{
    selected_task_completion_route_apply, selected_task_route_admission,
    SelectedTaskCompletionRouteApplyInput, SelectedTaskRouteAdmissionInput,
};

pub(crate) fn selected_task_completion_route_apply_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: SelectedTaskCompletionRouteApplyQuery,
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
                "selected task completion route apply query requires project id, task id, and operator ref"
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
            project_id: query.project_id.clone(),
            task_id: query.task_id.clone(),
        },
    )?;
    let ServerQueryResult::SelectedTaskOperatorActionGate(gate) = gate else {
        return Err(ServerControlError::InvalidRequest {
            reason: "selected task operator action gate query returned an unexpected result"
                .to_owned(),
        });
    };

    let route_admission = selected_task_route_admission(SelectedTaskRouteAdmissionInput {
        route,
        gate,
        expected_revision: query.expected_revision.clone(),
        operator_ref: query.operator_ref.clone(),
    });
    let route_admission_id = query
        .route_admission_id
        .unwrap_or_else(|| route_admission.admission_id.clone());
    let review_decision_ref = query
        .review_decision_ref
        .or_else(|| route_admission.completion.decision_ref.clone())
        .unwrap_or_default();
    let evidence_refs = if query.evidence_refs.is_empty() {
        route_admission.completion.evidence_refs.clone()
    } else {
        query.evidence_refs
    };

    Ok(ServerQueryResult::SelectedTaskCompletionRouteApply(
        selected_task_completion_route_apply(SelectedTaskCompletionRouteApplyInput {
            project_id: query.project_id,
            task_id: query.task_id,
            expected_revision: query.expected_revision,
            operator_ref: query.operator_ref,
            route_admission_id,
            review_decision_ref,
            evidence_refs,
            route_admission,
        }),
    ))
}
