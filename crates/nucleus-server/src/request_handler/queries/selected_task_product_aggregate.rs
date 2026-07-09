use nucleus_local_store::LocalStoreBackend;

use super::selected_task_action_readiness;
use super::selected_task_command_admission;
use super::selected_task_completion_route_apply;
use super::selected_task_operator_action_gate;
use super::selected_task_review_next;
use super::selected_task_review_outcome_route;
use super::selected_task_rework_preparation;
use super::selected_task_route_admission;
use super::selected_task_scm_handoff;
use super::task_workflow_drilldown;
use super::LocalControlRequestHandler;
use crate::control_api::{
    SelectedTaskActionReadinessQuery, SelectedTaskCommandAdmissionQuery,
    SelectedTaskCompletionRouteApplyQuery, SelectedTaskOperatorActionGateQuery,
    SelectedTaskProductAggregateQuery, SelectedTaskReviewNextQuery,
    SelectedTaskReviewOutcomeRouteQuery, SelectedTaskReworkPreparationQuery,
    SelectedTaskRouteAdmissionQuery, SelectedTaskScmHandoffQuery, ServerControlError,
    ServerQueryResult, TaskWorkflowDrilldownQuery,
};
use crate::{
    selected_task_product_aggregate, SelectedTaskActionFamily, SelectedTaskProductAggregateInput,
};

pub(crate) fn selected_task_product_aggregate_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: SelectedTaskProductAggregateQuery,
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
                "selected task product aggregate query requires project id, task id, and operator ref"
                    .to_owned(),
        });
    }

    let drilldown = expect_drilldown(task_workflow_drilldown::task_workflow_drilldown_query(
        handler,
        TaskWorkflowDrilldownQuery {
            project_id: query.project_id.clone(),
            task_id: query.task_id.clone(),
        },
    )?)?;
    let action_readiness = expect_action_readiness(
        selected_task_action_readiness::selected_task_action_readiness_query(
            handler,
            SelectedTaskActionReadinessQuery {
                project_id: query.project_id.clone(),
                task_id: query.task_id.clone(),
            },
        )?,
    )?;
    let operator_gate = expect_operator_gate(
        selected_task_operator_action_gate::selected_task_operator_action_gate_query(
            handler,
            SelectedTaskOperatorActionGateQuery {
                project_id: query.project_id.clone(),
                task_id: query.task_id.clone(),
            },
        )?,
    )?;
    let review_next =
        expect_review_next(selected_task_review_next::selected_task_review_next_query(
            handler,
            SelectedTaskReviewNextQuery {
                project_id: query.project_id.clone(),
                task_id: query.task_id.clone(),
            },
        )?)?;
    let review_outcome_route = expect_review_outcome_route(
        selected_task_review_outcome_route::selected_task_review_outcome_route_query(
            handler,
            SelectedTaskReviewOutcomeRouteQuery {
                project_id: query.project_id.clone(),
                task_id: query.task_id.clone(),
            },
        )?,
    )?;
    let route_admission = expect_route_admission(
        selected_task_route_admission::selected_task_route_admission_query(
            handler,
            SelectedTaskRouteAdmissionQuery {
                project_id: query.project_id.clone(),
                task_id: query.task_id.clone(),
                expected_revision: query.expected_revision.clone(),
                operator_ref: query.operator_ref.clone(),
            },
        )?,
    )?;
    let completion_apply = expect_completion_apply(
        selected_task_completion_route_apply::selected_task_completion_route_apply_query(
            handler,
            SelectedTaskCompletionRouteApplyQuery {
                project_id: query.project_id.clone(),
                task_id: query.task_id.clone(),
                expected_revision: query.expected_revision.clone(),
                operator_ref: query.operator_ref.clone(),
                route_admission_id: None,
                review_decision_ref: None,
                evidence_refs: Vec::new(),
            },
        )?,
    )?;
    let rework_preparation = expect_rework_preparation(
        selected_task_rework_preparation::selected_task_rework_preparation_query(
            handler,
            SelectedTaskReworkPreparationQuery {
                project_id: query.project_id.clone(),
                task_id: query.task_id.clone(),
                operator_ref: query.operator_ref.clone(),
                route_admission_id: None,
                review_decision_ref: None,
                reviewed_work_item_refs: Vec::new(),
                reviewed_evidence_refs: Vec::new(),
                expected_task_revision: query.expected_revision.clone(),
                expected_work_item_revision: None,
            },
        )?,
    )?;
    let scm_handoff =
        expect_scm_handoff(selected_task_scm_handoff::selected_task_scm_handoff_query(
            handler,
            SelectedTaskScmHandoffQuery {
                project_id: query.project_id.clone(),
                task_id: query.task_id.clone(),
            },
        )?)?;
    let command_admissions = command_admissions(handler, &query)?;

    Ok(ServerQueryResult::SelectedTaskProductAggregate(
        selected_task_product_aggregate(SelectedTaskProductAggregateInput {
            project_id: query.project_id,
            task_id: query.task_id,
            expected_revision: query.expected_revision,
            drilldown: Some(drilldown),
            action_readiness: Some(action_readiness),
            operator_gate: Some(operator_gate),
            command_admissions,
            review_next: Some(review_next),
            review_outcome_route: Some(review_outcome_route),
            route_admission: Some(route_admission),
            completion_apply: Some(completion_apply),
            rework_preparation: Some(rework_preparation),
            scm_handoff: Some(scm_handoff),
        }),
    ))
}

fn command_admissions<B>(
    handler: &LocalControlRequestHandler<B>,
    query: &SelectedTaskProductAggregateQuery,
) -> Result<Vec<crate::SelectedTaskCommandAdmission>, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    SelectedTaskActionFamily::ORDERED
        .into_iter()
        .map(|family| {
            expect_command_admission(
                selected_task_command_admission::selected_task_command_admission_query(
                    handler,
                    SelectedTaskCommandAdmissionQuery {
                        project_id: query.project_id.clone(),
                        task_id: query.task_id.clone(),
                        family,
                        expected_revision: query.expected_revision.clone(),
                        reason: None,
                        operator_ref: query.operator_ref.clone(),
                    },
                )?,
            )
        })
        .collect()
}

fn expect_drilldown(
    result: ServerQueryResult,
) -> Result<crate::TaskWorkflowDrilldown, ServerControlError> {
    match result {
        ServerQueryResult::TaskWorkflowDrilldown(value) => Ok(value),
        _ => unexpected("task workflow drilldown"),
    }
}

fn expect_action_readiness(
    result: ServerQueryResult,
) -> Result<crate::SelectedTaskActionReadiness, ServerControlError> {
    match result {
        ServerQueryResult::SelectedTaskActionReadiness(value) => Ok(value),
        _ => unexpected("selected task action readiness"),
    }
}

fn expect_operator_gate(
    result: ServerQueryResult,
) -> Result<crate::SelectedTaskOperatorActionGate, ServerControlError> {
    match result {
        ServerQueryResult::SelectedTaskOperatorActionGate(value) => Ok(value),
        _ => unexpected("selected task operator gate"),
    }
}

fn expect_review_next(
    result: ServerQueryResult,
) -> Result<crate::SelectedTaskReviewNext, ServerControlError> {
    match result {
        ServerQueryResult::SelectedTaskReviewNext(value) => Ok(value),
        _ => unexpected("selected task review next"),
    }
}

fn expect_review_outcome_route(
    result: ServerQueryResult,
) -> Result<crate::SelectedTaskReviewOutcomeRoute, ServerControlError> {
    match result {
        ServerQueryResult::SelectedTaskReviewOutcomeRoute(value) => Ok(value),
        _ => unexpected("selected task review outcome route"),
    }
}

fn expect_route_admission(
    result: ServerQueryResult,
) -> Result<crate::SelectedTaskRouteAdmission, ServerControlError> {
    match result {
        ServerQueryResult::SelectedTaskRouteAdmission(value) => Ok(value),
        _ => unexpected("selected task route admission"),
    }
}

fn expect_completion_apply(
    result: ServerQueryResult,
) -> Result<crate::SelectedTaskCompletionRouteApply, ServerControlError> {
    match result {
        ServerQueryResult::SelectedTaskCompletionRouteApply(value) => Ok(value),
        _ => unexpected("selected task completion route apply"),
    }
}

fn expect_rework_preparation(
    result: ServerQueryResult,
) -> Result<crate::SelectedTaskReworkPreparation, ServerControlError> {
    match result {
        ServerQueryResult::SelectedTaskReworkPreparation(value) => Ok(value),
        _ => unexpected("selected task rework preparation"),
    }
}

fn expect_scm_handoff(
    result: ServerQueryResult,
) -> Result<crate::SelectedTaskScmHandoffReadiness, ServerControlError> {
    match result {
        ServerQueryResult::SelectedTaskScmHandoff(value) => Ok(value),
        _ => unexpected("selected task SCM handoff"),
    }
}

fn expect_command_admission(
    result: ServerQueryResult,
) -> Result<crate::SelectedTaskCommandAdmission, ServerControlError> {
    match result {
        ServerQueryResult::SelectedTaskCommandAdmission(value) => Ok(value),
        _ => unexpected("selected task command admission"),
    }
}

fn unexpected<T>(label: &str) -> Result<T, ServerControlError> {
    Err(ServerControlError::InvalidRequest {
        reason: format!("{label} query returned an unexpected result"),
    })
}
