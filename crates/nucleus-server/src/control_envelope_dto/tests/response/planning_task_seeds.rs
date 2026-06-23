use nucleus_engine::EngineTaskSeedCandidateProjection;
use nucleus_projects::ProjectId;

use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, ServerControlRequestId,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_empty_planning_task_seed_projection_without_effects() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:planning-task-seeds".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::PlanningTaskSeeds(
            EngineTaskSeedCandidateProjection::from_records(
                ProjectId("project:nucleus".to_owned()),
                Vec::new(),
            ),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::PlanningTaskSeeds {
            project_id,
            candidates,
            status_counts,
            source_counts,
            client_can_promote,
            task_creation_performed,
        } if project_id == "project:nucleus"
            && candidates.is_empty()
            && status_counts.is_empty()
            && source_counts.task_seed_records == 0
            && source_counts.source_artifact_refs == 0
            && source_counts.context_refs == 0
            && source_counts.validation_hint_refs == 0
            && !client_can_promote
            && !task_creation_performed
    ));
    assert!(json.contains("\"type\":\"planning_task_seeds\""));
    assert!(json.contains("\"client_can_promote\":false"));
    assert!(json.contains("\"task_creation_performed\":false"));
}
