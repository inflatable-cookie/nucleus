use nucleus_engine::{
    EngineTaskReadinessClass, EngineTaskReadinessInput, EngineTaskReadinessProjection,
};
use nucleus_local_store::LocalStoreBackend;
use nucleus_projects::{decode_project_storage_record, ProjectStorageStatus};
use nucleus_tasks::{decode_task_storage_record, task_from_storage_record};

use super::{storage_error, LocalControlRequestHandler};
use crate::control_api::{ProductWorkflowSummaryQuery, ServerControlError, ServerQueryResult};
use crate::{
    product_workflow_summary, ProductWorkflowSummaryInput, ProductWorkflowTaskCandidateInput,
    ProductWorkflowTaskLane,
};

mod context;
mod planning_context;
mod runtime_review;
mod scm_next;
#[cfg(test)]
mod tests;

use context::context_refs;
use planning_context::planning_context;
use runtime_review::runtime_review_refs;
use scm_next::scm_next_refs;

pub(crate) fn product_workflow_summary_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: ProductWorkflowSummaryQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if query.project_id.0.trim().is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "product workflow summary requires a project".to_owned(),
        });
    }

    let (project_display_name, project_status) = project_display(handler, &query)?;
    let task_candidates = task_candidates(handler, &query)?;
    let planning_context = planning_context(handler, &query)?;
    let context = context_refs(handler, &query)?;
    let runtime_review = runtime_review_refs(handler, &task_candidates)?;
    let scm_next = scm_next_refs(
        handler,
        &task_candidates,
        &planning_context,
        &runtime_review,
    )?;

    Ok(ServerQueryResult::ProductWorkflowSummary(
        product_workflow_summary(ProductWorkflowSummaryInput {
            project_id: query.project_id,
            project_display_name,
            project_status,
            authority_refs: Vec::new(),
            task_candidates,
            planning_session_refs: planning_context.planning_session_refs,
            task_seed_refs: planning_context.task_seed_refs,
            accepted_planning_refs: planning_context.accepted_planning_refs,
            memory_proposal_refs: context.memory_proposal_refs,
            accepted_memory_refs: context.accepted_memory_refs,
            research_run_refs: context.research_run_refs,
            runtime_evidence_refs: runtime_review.runtime_evidence_refs,
            command_evidence_refs: runtime_review.command_evidence_refs,
            review_refs: runtime_review.review_refs,
            scm_readiness_refs: scm_next.scm_readiness_refs,
            next_step: scm_next.next_step,
        }),
    ))
}

fn project_display<B>(
    handler: &LocalControlRequestHandler<B>,
    query: &ProductWorkflowSummaryQuery,
) -> Result<(Option<String>, Option<String>), ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    for record in handler.state().projects().list().map_err(storage_error)? {
        let project = decode_project_storage_record(&record.payload.bytes).map_err(|error| {
            ServerControlError::StorageUnavailable {
                reason: format!("project record decode failed: {}", error.reason),
            }
        })?;

        if project.project_id == query.project_id.0 {
            return Ok((
                Some(project.display_name),
                Some(project_status_label(&project.status).to_owned()),
            ));
        }
    }

    Ok((None, None))
}

fn task_candidates<B>(
    handler: &LocalControlRequestHandler<B>,
    query: &ProductWorkflowSummaryQuery,
) -> Result<Vec<ProductWorkflowTaskCandidateInput>, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let mut tasks = Vec::new();
    for record in handler.state().tasks().list().map_err(storage_error)? {
        let storage_record =
            decode_task_storage_record(&record.payload.bytes).map_err(|error| {
                ServerControlError::StorageUnavailable {
                    reason: format!("task record decode failed: {}", error.reason),
                }
            })?;
        let task = task_from_storage_record(&storage_record);
        tasks.push(EngineTaskReadinessInput::from(&task));
    }

    Ok(
        EngineTaskReadinessProjection::from_tasks(query.project_id.clone(), tasks)
            .candidates
            .into_iter()
            .map(|candidate| ProductWorkflowTaskCandidateInput {
                task_ref: candidate.task_id.0,
                lane: task_lane(&candidate.readiness),
                rationale_refs: candidate
                    .blocker_refs
                    .into_iter()
                    .chain(candidate.evidence_refs)
                    .collect(),
            })
            .collect(),
    )
}

fn task_lane(readiness: &EngineTaskReadinessClass) -> ProductWorkflowTaskLane {
    match readiness {
        EngineTaskReadinessClass::AgentDelegationReady
        | EngineTaskReadinessClass::HumanPlanningReady => ProductWorkflowTaskLane::Ready,
        EngineTaskReadinessClass::ActiveWorkPresent => ProductWorkflowTaskLane::Active,
        EngineTaskReadinessClass::AwaitingReview => ProductWorkflowTaskLane::AwaitingReview,
        EngineTaskReadinessClass::Blocked => ProductWorkflowTaskLane::Blocked,
        EngineTaskReadinessClass::RepairRequired => ProductWorkflowTaskLane::RepairRequired,
        EngineTaskReadinessClass::Completed => ProductWorkflowTaskLane::Completed,
        EngineTaskReadinessClass::Archived => ProductWorkflowTaskLane::Archived,
    }
}

fn project_status_label(status: &ProjectStorageStatus) -> &'static str {
    match status {
        ProjectStorageStatus::Active => "active",
        ProjectStorageStatus::Parked => "parked",
        ProjectStorageStatus::Archived => "archived",
    }
}
