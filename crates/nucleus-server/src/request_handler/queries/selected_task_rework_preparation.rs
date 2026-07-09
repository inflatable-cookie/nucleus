use nucleus_local_store::LocalStoreBackend;

use super::selected_task_operator_action_gate;
use super::selected_task_review_outcome_route;
use super::LocalControlRequestHandler;
use crate::control_api::{
    SelectedTaskOperatorActionGateQuery, SelectedTaskReviewOutcomeRouteQuery,
    SelectedTaskReworkPreparationQuery, ServerControlError, ServerQueryResult,
};
use crate::{
    selected_task_rework_preparation, selected_task_route_admission,
    SelectedTaskReworkPreparationInput, SelectedTaskRouteAdmissionInput,
};

pub(crate) fn selected_task_rework_preparation_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: SelectedTaskReworkPreparationQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if query.project_id.0.trim().is_empty()
        || query.task_id.0.trim().is_empty()
        || query.operator_ref.trim().is_empty()
    {
        return Err(ServerControlError::InvalidRequest {
            reason: "selected task rework preparation query requires project id, task id, and operator ref"
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
        expected_revision: query.expected_task_revision.clone(),
        operator_ref: query.operator_ref.clone(),
    });
    let route_admission_id = query
        .route_admission_id
        .unwrap_or_else(|| route_admission.rework_delegation.admission_id.clone());
    let review_decision_ref = query
        .review_decision_ref
        .or_else(|| route_admission.rework_delegation.decision_ref.clone())
        .unwrap_or_default();
    let reviewed_work_item_refs = if query.reviewed_work_item_refs.is_empty() {
        route_admission.rework_delegation.work_item_refs.clone()
    } else {
        query.reviewed_work_item_refs
    };
    let reviewed_evidence_refs = if query.reviewed_evidence_refs.is_empty() {
        route_admission.rework_delegation.evidence_refs.clone()
    } else {
        query.reviewed_evidence_refs
    };

    Ok(ServerQueryResult::SelectedTaskReworkPreparation(
        selected_task_rework_preparation(SelectedTaskReworkPreparationInput {
            project_id: query.project_id,
            task_id: query.task_id,
            operator_ref: query.operator_ref,
            route_admission_id,
            review_decision_ref,
            reviewed_work_item_refs,
            reviewed_evidence_refs,
            expected_task_revision: query.expected_task_revision,
            expected_work_item_revision: query.expected_work_item_revision,
            route_admission,
        }),
    ))
}
