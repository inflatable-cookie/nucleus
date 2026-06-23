use super::*;

#[test]
fn task_timeline_query_round_trips_timeline_action() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:task-timeline".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:task-timeline".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::TaskTimeline(TaskTimelineQuery {
                task_id: nucleus_tasks::TaskId("task:timeline".to_owned()),
            }),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("\"kind\":\"task_timeline\""));
    assert!(json.contains("\"action\":\"timeline\""));
    assert!(json.contains("\"task_id\":\"task:timeline\""));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::TaskTimeline(TaskTimelineQuery { task_id }),
            ..
        }) if task_id.0 == "task:timeline"
    ));
}

#[test]
fn task_timeline_query_rejects_unknown_action() {
    let dto = ControlRequestEnvelopeDto {
        protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
        protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
        request_id: "request:dto:task-timeline:unsupported".to_owned(),
        client_id: "client:desktop".to_owned(),
        body: ControlRequestBodyDto::Query {
            query: ControlQueryDto::TaskTimeline {
                query_id: "query:dto:task-timeline:unsupported".to_owned(),
                action: "mutate_task".to_owned(),
                task_id: "task:timeline".to_owned(),
            },
        },
    };

    let error = ServerControlRequest::try_from(dto).expect_err("unsupported action");

    assert_eq!(
        error.failure,
        ControlApiCodecFailure::UnsupportedPayloadShape
    );
    assert!(error.reason.contains("unsupported task timeline"));
}

#[test]
fn task_readiness_query_round_trips_candidates_action() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:task-readiness".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:task-readiness".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::TaskReadiness(TaskReadinessQuery {
                project_id: ProjectId("project:nucleus".to_owned()),
            }),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("\"kind\":\"task_readiness\""));
    assert!(json.contains("\"action\":\"candidates\""));
    assert!(json.contains("\"project_id\":\"project:nucleus\""));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::TaskReadiness(TaskReadinessQuery { project_id }),
            ..
        }) if project_id.0 == "project:nucleus"
    ));
}

#[test]
fn task_readiness_query_rejects_unknown_action() {
    let dto = ControlRequestEnvelopeDto {
        protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
        protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
        request_id: "request:dto:task-readiness:unsupported".to_owned(),
        client_id: "client:desktop".to_owned(),
        body: ControlRequestBodyDto::Query {
            query: ControlQueryDto::TaskReadiness {
                query_id: "query:dto:task-readiness:unsupported".to_owned(),
                action: "mutate_task".to_owned(),
                project_id: "project:nucleus".to_owned(),
            },
        },
    };

    let error = ServerControlRequest::try_from(dto).expect_err("unsupported action");

    assert_eq!(
        error.failure,
        ControlApiCodecFailure::UnsupportedPayloadShape
    );
    assert!(error.reason.contains("unsupported task readiness"));
}

#[test]
fn planning_task_seeds_query_round_trips_candidates_action() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:planning-task-seeds".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:planning-task-seeds".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::PlanningTaskSeeds(PlanningTaskSeedsQuery {
                project_id: ProjectId("project:nucleus".to_owned()),
            }),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("\"kind\":\"planning_task_seeds\""));
    assert!(json.contains("\"action\":\"candidates\""));
    assert!(json.contains("\"project_id\":\"project:nucleus\""));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::PlanningTaskSeeds(PlanningTaskSeedsQuery { project_id }),
            ..
        }) if project_id.0 == "project:nucleus"
    ));
}

#[test]
fn planning_task_seeds_query_rejects_unknown_action() {
    let dto = ControlRequestEnvelopeDto {
        protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
        protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
        request_id: "request:dto:planning-task-seeds:unsupported".to_owned(),
        client_id: "client:desktop".to_owned(),
        body: ControlRequestBodyDto::Query {
            query: ControlQueryDto::PlanningTaskSeeds {
                query_id: "query:dto:planning-task-seeds:unsupported".to_owned(),
                action: "promote".to_owned(),
                project_id: "project:nucleus".to_owned(),
            },
        },
    };

    let error = ServerControlRequest::try_from(dto).expect_err("unsupported action");

    assert_eq!(
        error.failure,
        ControlApiCodecFailure::UnsupportedPayloadShape
    );
    assert!(error.reason.contains("unsupported planning task seed"));
}

#[test]
fn project_authority_map_query_round_trips_publication_action() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:project-authority-map".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:project-authority-map".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::ProjectAuthorityMap(ProjectAuthorityMapQuery {
                project_id: ProjectId("project:nucleus".to_owned()),
                expected_domains: vec![
                    ProjectAuthorityDomain::Project,
                    ProjectAuthorityDomain::Task,
                    ProjectAuthorityDomain::Execution,
                ],
            }),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("\"kind\":\"project_authority_map\""));
    assert!(json.contains("\"action\":\"publication\""));
    assert!(json.contains("\"project_id\":\"project:nucleus\""));
    assert!(json.contains("\"expected_domains\":[\"project\",\"task\",\"execution\"]"));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::ProjectAuthorityMap(ProjectAuthorityMapQuery {
                project_id,
                expected_domains,
            }),
            ..
        }) if project_id.0 == "project:nucleus"
            && expected_domains == vec![
                ProjectAuthorityDomain::Project,
                ProjectAuthorityDomain::Task,
                ProjectAuthorityDomain::Execution,
            ]
    ));
}

#[test]
fn project_authority_map_query_rejects_empty_project_id() {
    let dto = ControlRequestEnvelopeDto {
        protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
        protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
        request_id: "request:dto:project-authority-map:unsupported".to_owned(),
        client_id: "client:desktop".to_owned(),
        body: ControlRequestBodyDto::Query {
            query: ControlQueryDto::ProjectAuthorityMap {
                query_id: "query:dto:project-authority-map:unsupported".to_owned(),
                action: "publication".to_owned(),
                project_id: "".to_owned(),
                expected_domains: vec!["project".to_owned()],
            },
        },
    };

    let error = ServerControlRequest::try_from(dto).expect_err("empty project id");

    assert_eq!(
        error.failure,
        ControlApiCodecFailure::UnsupportedPayloadShape
    );
    assert!(error.reason.contains("requires a project id"));
}
