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

    Ok(ServerQueryResult::ProductWorkflowSummary(
        product_workflow_summary(ProductWorkflowSummaryInput {
            project_id: query.project_id,
            project_display_name,
            project_status,
            authority_refs: Vec::new(),
            task_candidates,
            planning_session_refs: Vec::new(),
            task_seed_refs: Vec::new(),
            accepted_planning_refs: Vec::new(),
            memory_proposal_refs: Vec::new(),
            accepted_memory_refs: Vec::new(),
            research_run_refs: Vec::new(),
            runtime_evidence_refs: Vec::new(),
            command_evidence_refs: Vec::new(),
            review_refs: Vec::new(),
            scm_readiness_refs: Vec::new(),
            next_step: None,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_seed::{seed_local_project, LocalProjectSeed};
    use crate::task_seed::{seed_local_task, LocalTaskSeed};
    use nucleus_projects::ProjectId;

    #[test]
    fn product_workflow_summary_query_reads_project_and_task_sources_without_effects() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = nucleus_local_store::SqliteBackend::new(temp_dir.path().join("state.sqlite"));
        let handler = crate::request_handler::LocalControlRequestHandler::new(backend, None);
        seed_local_project(handler.state(), LocalProjectSeed::nucleus_local()).expect("project");
        seed_local_task(handler.state(), LocalTaskSeed::nucleus_local_bootstrap()).expect("task");

        let result = product_workflow_summary_query(
            &handler,
            ProductWorkflowSummaryQuery {
                project_id: ProjectId("project:nucleus-local".to_owned()),
            },
        )
        .expect("product workflow summary");

        let ServerQueryResult::ProductWorkflowSummary(summary) = result else {
            panic!("expected product workflow summary result");
        };

        assert_eq!(summary.project_id.0, "project:nucleus-local");
        assert_eq!(
            summary.project.display_name,
            Some("Nucleus Local".to_owned())
        );
        assert_eq!(summary.project.status, Some("active".to_owned()));
        assert_eq!(summary.source_counts.task_candidates, 1);
        assert_eq!(
            summary
                .task_lanes
                .iter()
                .find(|lane| lane.lane == ProductWorkflowTaskLane::Ready)
                .expect("ready lane")
                .count,
            1
        );
        assert!(summary
            .gaps
            .iter()
            .all(|gap| gap.area != crate::ProductWorkflowGapArea::Tasks));
        assert!(!summary.no_effects.task_mutation_performed);
        assert!(!summary.no_effects.provider_execution_performed);
        assert!(!summary.no_effects.scm_or_forge_mutation_performed);
        assert!(!summary.no_effects.ui_effect_performed);
    }
}
