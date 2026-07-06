use nucleus_local_store::LocalStoreBackend;

use crate::control_api::{
    PlanningSessionsQuery, PlanningTaskSeedsQuery, ProductWorkflowSummaryQuery, ServerControlError,
    ServerQueryResult,
};
use crate::planning_sessions_projection::PlanningSessionSummaryStatus;
use crate::request_handler::LocalControlRequestHandler;

#[derive(Debug, Default, Eq, PartialEq)]
pub(super) struct ProductWorkflowPlanningRefs {
    pub(super) planning_session_refs: Vec<String>,
    pub(super) task_seed_refs: Vec<String>,
    pub(super) accepted_planning_refs: Vec<String>,
}

pub(super) fn planning_context<B>(
    handler: &LocalControlRequestHandler<B>,
    query: &ProductWorkflowSummaryQuery,
) -> Result<ProductWorkflowPlanningRefs, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let sessions = match super::super::planning_sessions::planning_sessions_query(
        handler,
        PlanningSessionsQuery {
            project_id: query.project_id.clone(),
        },
    )? {
        ServerQueryResult::PlanningSessions(sessions) => sessions,
        _ => {
            return Err(ServerControlError::StorageUnavailable {
                reason: "planning sessions query returned unexpected result".to_owned(),
            });
        }
    };
    let task_seeds = match super::super::planning_task_seeds::planning_task_seeds_query(
        handler,
        PlanningTaskSeedsQuery {
            project_id: query.project_id.clone(),
        },
    )? {
        ServerQueryResult::PlanningTaskSeeds(task_seeds) => task_seeds,
        _ => {
            return Err(ServerControlError::StorageUnavailable {
                reason: "planning task seeds query returned unexpected result".to_owned(),
            });
        }
    };

    let planning_session_refs = sessions
        .sessions
        .iter()
        .map(|session| session.session_id.clone())
        .collect();
    let mut task_seed_refs: Vec<String> = sessions
        .sessions
        .iter()
        .flat_map(|session| session.output_refs.task_seed_refs.clone())
        .chain(
            task_seeds
                .candidates
                .iter()
                .map(|candidate| candidate.seed_id.0.clone()),
        )
        .collect();
    let accepted_planning_refs = sessions
        .sessions
        .iter()
        .filter(|session| session.status == PlanningSessionSummaryStatus::Accepted)
        .flat_map(|session| session.output_refs.artifact_refs.clone())
        .collect();

    task_seed_refs.sort();
    task_seed_refs.dedup();

    Ok(ProductWorkflowPlanningRefs {
        planning_session_refs,
        task_seed_refs,
        accepted_planning_refs,
    })
}
