use nucleus_local_store::SqliteBackend;
use nucleus_projects::ProjectId;
use nucleus_tasks::{TaskActionType, TaskImportance};

use super::*;
use crate::control_api::{
    PlanningTaskSeedsQuery, ServerControlRequest, ServerControlRequestKind,
    ServerControlResponseBody, ServerQuery, ServerQueryKind, ServerQueryResult,
};
use crate::ids::{ClientId, ServerControlRequestId, ServerQueryId};
use crate::request_handler::LocalControlRequestHandler;

#[test]
fn local_planning_task_seed_is_idempotent_and_queryable_without_creating_tasks() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let mut handler = LocalControlRequestHandler::new(backend, None);

    let first = seed_local_planning_task_seed(
        handler.state(),
        LocalPlanningTaskSeed {
            seed_id: "seed:planning".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            source_artifact_id: Some("artifact:planning".to_owned()),
            title: "Planning Seed".to_owned(),
            action_type: TaskActionType::Plan,
            importance: TaskImportance::High,
        },
    )
    .expect("first seed");
    let second = seed_local_planning_task_seed(
        handler.state(),
        LocalPlanningTaskSeed {
            seed_id: "seed:planning".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            source_artifact_id: None,
            title: "Changed Seed".to_owned(),
            action_type: TaskActionType::Review,
            importance: TaskImportance::Low,
        },
    )
    .expect("second seed");

    assert_eq!(first, second);
    assert_eq!(handler.state().tasks().list().expect("tasks").len(), 0);

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:planning-seed:query".to_owned()),
        client_id: ClientId("client:test".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:planning-seed".to_owned()),
            client_id: ClientId("client:test".to_owned()),
            kind: ServerQueryKind::PlanningTaskSeeds(PlanningTaskSeedsQuery {
                project_id: ProjectId("project:nucleus-local".to_owned()),
            }),
        }),
    });

    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::PlanningTaskSeeds(projection))
            if projection.candidates.len() == 1
                && projection.candidates[0].seed_id.0 == "seed:planning"
                && projection.candidates[0].source_artifact_id.as_ref().map(|id| id.0.as_str())
                    == Some("artifact:planning")
                && !projection.client_can_promote
                && !projection.task_creation_performed
    ));
}
