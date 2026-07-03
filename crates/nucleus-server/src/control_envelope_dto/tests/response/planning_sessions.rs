use nucleus_projects::ProjectId;

use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, PlanningSessionOutputRefs,
    PlanningSessionSourceCounts, PlanningSessionSummary, PlanningSessionSummaryKind,
    PlanningSessionSummaryStatus, PlanningSessionsProjection, ServerControlRequestId,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_planning_sessions_without_effects() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:planning-sessions".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::PlanningSessions(
            PlanningSessionsProjection {
                project_id: ProjectId("project:nucleus".to_owned()),
                sessions: vec![PlanningSessionSummary {
                    session_id: "planning-session:nucleus:intake".to_owned(),
                    kind: PlanningSessionSummaryKind::ProjectIntake,
                    status: PlanningSessionSummaryStatus::Active,
                    prompt_or_template_refs: vec!["template:intake".to_owned()],
                    participant_count: 1,
                    source_ref_count: 1,
                    source_kind_counts: Vec::new(),
                    output_refs: PlanningSessionOutputRefs {
                        artifact_refs: vec!["artifact:vision".to_owned()],
                        task_seed_refs: vec!["seed:planning".to_owned()],
                        memory_proposal_refs: Vec::new(),
                        research_run_brief_refs: Vec::new(),
                    },
                }],
                status_counts: Vec::new(),
                source_counts: PlanningSessionSourceCounts {
                    planning_session_records: 1,
                    exploration_session_records: 0,
                    prompt_or_template_refs: 1,
                    participant_refs: 1,
                    source_refs: 1,
                    output_refs: 2,
                },
                client_can_mutate: false,
                provider_execution_available: false,
            },
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::PlanningSessions {
            project_id,
            sessions,
            source_counts,
            client_can_mutate,
            provider_execution_available,
            ..
        } if project_id == "project:nucleus"
            && sessions.len() == 1
            && sessions[0].session_id == "planning-session:nucleus:intake"
            && source_counts.planning_session_records == 1
            && source_counts.output_refs == 2
            && !client_can_mutate
            && !provider_execution_available
    ));
    assert!(json.contains("\"type\":\"planning_sessions\""));
    assert!(json.contains("\"client_can_mutate\":false"));
    assert!(json.contains("\"provider_execution_available\":false"));
    assert!(!json.contains("raw_transcript"));
    assert!(!json.contains("provider_payload"));
}
