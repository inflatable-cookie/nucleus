use std::collections::HashSet;

use nucleus_local_store::LocalStoreBackend;

use crate::control_api::ServerControlError;
use crate::request_handler::queries::product_workflow_summary::planning_context::ProductWorkflowPlanningRefs;
use crate::request_handler::queries::product_workflow_summary::runtime_review::ProductWorkflowRuntimeReviewRefs;
use crate::request_handler::queries::storage_error;
use crate::request_handler::LocalControlRequestHandler;
use crate::{
    ProductWorkflowNextStepInput, ProductWorkflowNextStepSource, ProductWorkflowTaskCandidateInput,
    ProductWorkflowTaskLane,
};

#[derive(Debug, Default, Eq, PartialEq)]
pub(super) struct ProductWorkflowScmNextRefs {
    pub(super) scm_readiness_refs: Vec<String>,
    pub(super) next_step: Option<ProductWorkflowNextStepInput>,
}

pub(super) fn scm_next_refs<B>(
    handler: &LocalControlRequestHandler<B>,
    task_candidates: &[ProductWorkflowTaskCandidateInput],
    planning_context: &ProductWorkflowPlanningRefs,
    runtime_review: &ProductWorkflowRuntimeReviewRefs,
) -> Result<ProductWorkflowScmNextRefs, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let task_ids = task_candidates
        .iter()
        .map(|candidate| candidate.task_ref.as_str())
        .collect::<HashSet<_>>();
    let scm_readiness_refs = scm_readiness_refs(handler, &task_ids)?;

    Ok(ProductWorkflowScmNextRefs {
        next_step: next_step(
            task_candidates,
            planning_context,
            runtime_review,
            &scm_readiness_refs,
        ),
        scm_readiness_refs,
    })
}

fn scm_readiness_refs<B>(
    handler: &LocalControlRequestHandler<B>,
    task_ids: &HashSet<&str>,
) -> Result<Vec<String>, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let mut refs = Vec::new();

    refs.extend(
        crate::provider_completion_scm_capture_admission_persistence::read_completion_scm_capture_admissions(handler.state())
            .map_err(storage_error)?
            .into_iter()
            .filter(|record| task_ids.contains(record.task_id.as_str()))
            .map(|record| record.persisted_admission_id),
    );
    refs.extend(
        crate::provider_completion_scm_capture_preparation_persistence::read_completion_scm_capture_preparations(handler.state())
            .map_err(storage_error)?
            .into_iter()
            .filter(|record| task_ids.contains(record.task_id.as_str()))
            .map(|record| record.persisted_preparation_id),
    );
    refs.extend(
        crate::provider_scm_capture_dry_run_persistence::read_scm_capture_dry_run_plans(
            handler.state(),
        )
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| task_ids.contains(record.task_id.as_str()))
        .map(|record| record.persisted_dry_run_plan_id),
    );
    refs.extend(
        crate::provider_scm_capture_dry_run_execution_persistence::read_scm_capture_dry_run_execution_receipts(handler.state())
            .map_err(storage_error)?
            .into_iter()
            .filter(|record| task_ids.contains(record.task_id.as_str()))
            .map(|record| record.persisted_execution_receipt_id),
    );
    refs.extend(
        crate::provider_scm_capture_review_decision_persistence::read_scm_capture_review_decisions(
            handler.state(),
        )
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| task_ids.contains(record.task_id.as_str()))
        .flat_map(|record| [record.readiness_id, record.decision_id]),
    );
    refs.extend(
        crate::provider_scm_change_request_prep_persistence::read_scm_change_request_prep_records(
            handler.state(),
        )
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| task_ids.contains(record.task_id.as_str()))
        .map(|record| record.persisted_preparation_id),
    );

    refs.sort();
    refs.dedup();
    Ok(refs)
}

fn next_step(
    task_candidates: &[ProductWorkflowTaskCandidateInput],
    planning_context: &ProductWorkflowPlanningRefs,
    runtime_review: &ProductWorkflowRuntimeReviewRefs,
    scm_readiness_refs: &[String],
) -> Option<ProductWorkflowNextStepInput> {
    if let Some(candidate) = first_candidate(task_candidates, ProductWorkflowTaskLane::Ready) {
        return Some(ProductWorkflowNextStepInput {
            source: ProductWorkflowNextStepSource::Task,
            next_ref: Some(candidate.task_ref.clone()),
            summary: "Continue the first ready task candidate".to_owned(),
            rationale_refs: candidate.rationale_refs.clone(),
        });
    }

    if let Some(candidate) =
        first_candidate(task_candidates, ProductWorkflowTaskLane::AwaitingReview)
    {
        return Some(ProductWorkflowNextStepInput {
            source: ProductWorkflowNextStepSource::Review,
            next_ref: Some(candidate.task_ref.clone()),
            summary: "Review the first task awaiting review".to_owned(),
            rationale_refs: candidate.rationale_refs.clone(),
        });
    }

    if let Some(review_ref) = runtime_review.review_refs.first() {
        return Some(ProductWorkflowNextStepInput {
            source: ProductWorkflowNextStepSource::Review,
            next_ref: Some(review_ref.clone()),
            summary: "Review the latest workflow review evidence".to_owned(),
            rationale_refs: runtime_review.review_refs.clone(),
        });
    }

    if let Some(scm_ref) = scm_readiness_refs.first() {
        return Some(ProductWorkflowNextStepInput {
            source: ProductWorkflowNextStepSource::Review,
            next_ref: Some(scm_ref.clone()),
            summary: "Review the available SCM readiness evidence".to_owned(),
            rationale_refs: scm_readiness_refs.to_vec(),
        });
    }

    if let Some(seed_ref) = planning_context.task_seed_refs.first() {
        return Some(ProductWorkflowNextStepInput {
            source: ProductWorkflowNextStepSource::Planning,
            next_ref: Some(seed_ref.clone()),
            summary: "Review the next planning task seed".to_owned(),
            rationale_refs: planning_context.task_seed_refs.clone(),
        });
    }

    if let Some(session_ref) = planning_context.planning_session_refs.first() {
        return Some(ProductWorkflowNextStepInput {
            source: ProductWorkflowNextStepSource::Planning,
            next_ref: Some(session_ref.clone()),
            summary: "Continue from the active planning session".to_owned(),
            rationale_refs: planning_context.planning_session_refs.clone(),
        });
    }

    None
}

fn first_candidate(
    candidates: &[ProductWorkflowTaskCandidateInput],
    lane: ProductWorkflowTaskLane,
) -> Option<&ProductWorkflowTaskCandidateInput> {
    candidates
        .iter()
        .filter(|candidate| candidate.lane == lane && !candidate.task_ref.trim().is_empty())
        .min_by(|left, right| left.task_ref.cmp(&right.task_ref))
}
