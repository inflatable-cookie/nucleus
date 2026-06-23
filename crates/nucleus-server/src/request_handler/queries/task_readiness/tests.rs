use nucleus_local_store::SqliteBackend;
use nucleus_projects::ProjectId;
use nucleus_tasks::{TaskActionType, TaskImportance};

use super::*;
use crate::task_seed::{seed_local_task, LocalTaskSeed};

#[test]
fn task_readiness_query_composes_project_scoped_candidates() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let handler = crate::request_handler::LocalControlRequestHandler::new(backend, None);

    seed_local_task(
        handler.state(),
        LocalTaskSeed {
            task_id: "task:readiness".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            title: "Readiness task".to_owned(),
            action_type: TaskActionType::Plan,
            importance: TaskImportance::Normal,
        },
    )
    .expect("seed local task");
    seed_local_task(
        handler.state(),
        LocalTaskSeed {
            task_id: "task:other-project".to_owned(),
            project_id: "project:other".to_owned(),
            title: "Other task".to_owned(),
            action_type: TaskActionType::Review,
            importance: TaskImportance::Low,
        },
    )
    .expect("seed other task");

    let result = task_readiness_query(
        &handler,
        TaskReadinessQuery {
            project_id: ProjectId("project:nucleus-local".to_owned()),
        },
    )
    .expect("task readiness query");

    assert!(matches!(
        result,
        ServerQueryResult::TaskReadiness(projection)
            if projection.project_id.0 == "project:nucleus-local"
                && projection.candidates.len() == 1
                && projection.candidates[0].task_id.0 == "task:readiness"
                && !projection.client_can_mutate
                && !projection.provider_execution_available
    ));
}
