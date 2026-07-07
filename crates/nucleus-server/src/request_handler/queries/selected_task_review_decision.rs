use nucleus_local_store::LocalStoreBackend;

use super::task_workflow_drilldown;
use super::{storage_error, LocalControlRequestHandler};
use crate::control_api::{
    SelectedTaskReviewDecisionAdmissionQuery, SelectedTaskReviewDecisionApplyQuery,
    ServerControlError, ServerQueryResult, TaskWorkflowDrilldownQuery,
};
use crate::{
    persist_selected_task_review_decision, read_selected_task_review_decisions,
    selected_task_review_decision_admission, selected_task_review_next,
    SelectedTaskReviewDecisionAdmissionInput, SelectedTaskReviewDecisionIntent,
    SelectedTaskReviewDecisionPersistenceInput, SelectedTaskReviewNext,
};

pub(crate) fn selected_task_review_decision_admission_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: SelectedTaskReviewDecisionAdmissionQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    validate_request(
        &query.project_id.0,
        &query.task_id.0,
        &query.operator_ref,
        &query.idempotency_key,
    )?;

    let review_next = review_next(handler, query.project_id, query.task_id)?;
    let existing_decision_ids = existing_decision_ids(handler)?;
    let admission =
        selected_task_review_decision_admission(SelectedTaskReviewDecisionAdmissionInput {
            review_next,
            intent: SelectedTaskReviewDecisionIntent {
                action: query.action,
                expected_revision: query.expected_revision,
                operator_ref: query.operator_ref,
                reviewed_evidence_refs: query.reviewed_evidence_refs,
                idempotency_key: query.idempotency_key,
                reason: query.reason,
            },
            current_revision: query.current_revision,
            existing_decision_ids,
        });

    Ok(ServerQueryResult::SelectedTaskReviewDecisionAdmission(
        admission,
    ))
}

pub(crate) fn selected_task_review_decision_apply_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: SelectedTaskReviewDecisionApplyQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    validate_request(
        &query.project_id.0,
        &query.task_id.0,
        &query.operator_ref,
        &query.idempotency_key,
    )?;

    let review_next = review_next(handler, query.project_id, query.task_id)?;
    let existing_decision_ids = existing_decision_ids(handler)?;
    let admission =
        selected_task_review_decision_admission(SelectedTaskReviewDecisionAdmissionInput {
            review_next: review_next.clone(),
            intent: SelectedTaskReviewDecisionIntent {
                action: query.action,
                expected_revision: query.expected_revision,
                operator_ref: query.operator_ref,
                reviewed_evidence_refs: query.reviewed_evidence_refs,
                idempotency_key: query.idempotency_key,
                reason: query.reason,
            },
            current_revision: query.current_revision,
            existing_decision_ids: existing_decision_ids.clone(),
        });

    let record = persist_selected_task_review_decision(
        handler.state(),
        SelectedTaskReviewDecisionPersistenceInput {
            admission,
            review_next,
            existing_decision_ids,
            raw_provider_material_present: false,
            raw_command_output_present: false,
            task_lifecycle_mutation_requested: false,
            provider_execution_requested: false,
            scm_or_forge_mutation_requested: false,
            memory_or_planning_apply_requested: false,
            ui_effect_requested: false,
        },
    )
    .map_err(storage_error)?;

    Ok(ServerQueryResult::SelectedTaskReviewDecisionApply(record))
}

fn review_next<B>(
    handler: &LocalControlRequestHandler<B>,
    project_id: nucleus_projects::ProjectId,
    task_id: nucleus_tasks::TaskId,
) -> Result<SelectedTaskReviewNext, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let drilldown = task_workflow_drilldown::task_workflow_drilldown_query(
        handler,
        TaskWorkflowDrilldownQuery {
            project_id,
            task_id,
        },
    )?;
    let ServerQueryResult::TaskWorkflowDrilldown(drilldown) = drilldown else {
        return Err(ServerControlError::InvalidRequest {
            reason: "task workflow drilldown query returned an unexpected result".to_owned(),
        });
    };

    Ok(selected_task_review_next(&drilldown))
}

fn existing_decision_ids<B>(
    handler: &LocalControlRequestHandler<B>,
) -> Result<Vec<String>, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    Ok(read_selected_task_review_decisions(handler.state())
        .map_err(storage_error)?
        .into_iter()
        .map(|record| record.decision_id)
        .collect())
}

fn validate_request(
    project_id: &str,
    task_id: &str,
    operator_ref: &str,
    idempotency_key: &str,
) -> Result<(), ServerControlError> {
    if project_id.trim().is_empty()
        || task_id.trim().is_empty()
        || operator_ref.trim().is_empty()
        || idempotency_key.trim().is_empty()
    {
        return Err(ServerControlError::InvalidRequest {
            reason: "selected task review-decision query requires project id, task id, operator ref, and idempotency key"
                .to_owned(),
        });
    }
    Ok(())
}
