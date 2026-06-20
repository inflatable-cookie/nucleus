use super::*;

#[test]
fn request_envelope_dto_serializes_diagnostics_query() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:diagnostics".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:diagnostics".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::All),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("\"kind\":\"diagnostics\""));
    assert!(json.contains("\"domain\":\"all\""));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::All),
            ..
        })
    ));
}

#[test]
fn request_envelope_dto_round_trips_codex_provider_diagnostics_query() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:diagnostics:codex".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:diagnostics:codex".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::CodexProvider),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let server_request = ServerControlRequest::try_from(decoded).expect("server request");

    assert!(json.contains("\"domain\":\"codex_provider\""));
    assert!(matches!(
        server_request.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::CodexProvider),
            ..
        })
    ));
}

#[test]
fn live_evidence_completion_query_vocabulary_round_trips_diagnostics_domain() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:diagnostics:completion".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:diagnostics:completion".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::LiveEvidenceCompletion),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let server_request = ServerControlRequest::try_from(decoded).expect("server request");

    assert!(json.contains("\"domain\":\"live_evidence_completion\""));
    assert!(matches!(
        server_request.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::LiveEvidenceCompletion),
            ..
        })
    ));
}

#[test]
fn completion_scm_query_vocabulary_round_trips_diagnostics_domain() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:completion-scm".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:completion-scm".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::CompletionScmReadiness),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("\"domain\":\"completion_scm_readiness\""));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::CompletionScmReadiness),
            ..
        })
    ));
}

#[test]
fn completion_scm_capture_query_vocabulary_round_trips_diagnostics_domain() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:completion-scm-capture".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:completion-scm-capture".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::CompletionScmCapture),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("\"domain\":\"completion_scm_capture\""));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::CompletionScmCapture),
            ..
        })
    ));
}

#[test]
fn completion_scm_capture_preparation_query_vocabulary_round_trips_diagnostics_domain() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:completion-scm-preparation".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:completion-scm-preparation".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::CompletionScmCapturePreparation),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("\"domain\":\"completion_scm_capture_preparation\""));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::CompletionScmCapturePreparation),
            ..
        })
    ));
}

#[test]
fn scm_capture_dry_run_query_vocabulary_round_trips_diagnostics_domain() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:scm-capture-dry-run".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:scm-capture-dry-run".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::ScmCaptureDryRun),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("\"domain\":\"scm_capture_dry_run\""));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::ScmCaptureDryRun),
            ..
        })
    ));
}

#[test]
fn scm_capture_dry_run_execution_query_vocabulary_round_trips_diagnostics_domain() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:scm-capture-dry-run-execution".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:scm-capture-dry-run-execution".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::ScmCaptureDryRunExecution),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("\"domain\":\"scm_capture_dry_run_execution\""));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::ScmCaptureDryRunExecution),
            ..
        })
    ));
}

#[test]
fn git_dry_run_execution_query_vocabulary_round_trips_diagnostics_domain() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:git-dry-run-execution".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:git-dry-run-execution".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::GitDryRunExecution),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("\"domain\":\"git_dry_run_execution\""));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::GitDryRunExecution),
            ..
        })
    ));
}

#[test]
fn scm_capture_workflow_query_vocabulary_round_trips_diagnostics_domain() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:scm-capture-workflow".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:scm-capture-workflow".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::ScmCaptureWorkflow),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("\"domain\":\"scm_capture_workflow\""));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::ScmCaptureWorkflow),
            ..
        })
    ));
}

#[test]
fn scm_capture_review_query_vocabulary_round_trips_diagnostics_domain() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:scm-capture-review".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:scm-capture-review".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::ScmCaptureReview),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("\"domain\":\"scm_capture_review\""));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::ScmCaptureReview),
            ..
        })
    ));
}

#[test]
fn scm_capture_review_decision_query_vocabulary_round_trips_diagnostics_domain() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:scm-capture-review-decision".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:scm-capture-review-decision".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::ScmCaptureReviewDecision),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("\"domain\":\"scm_capture_review_decision\""));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::ScmCaptureReviewDecision),
            ..
        })
    ));
}

#[test]
fn scm_change_request_prep_query_vocabulary_round_trips_diagnostics_domain() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:scm-change-request-prep".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:scm-change-request-prep".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::ScmChangeRequestPreparation),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("\"domain\":\"scm_change_request_preparation\""));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::ScmChangeRequestPreparation),
            ..
        })
    ));
}

#[test]
fn request_envelope_rejects_unknown_diagnostics_domain() {
    let dto = ControlRequestEnvelopeDto {
        protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
        protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
        request_id: "request:dto:bad-diagnostics".to_owned(),
        client_id: "client:desktop".to_owned(),
        body: ControlRequestBodyDto::Query {
            query: ControlQueryDto::Diagnostics {
                query_id: "query:dto:bad-diagnostics".to_owned(),
                domain: "provider_shell".to_owned(),
            },
        },
    };

    let error = ServerControlRequest::try_from(dto).expect_err("bad diagnostics domain");

    assert_eq!(
        error.failure,
        ControlApiCodecFailure::UnsupportedPayloadShape
    );
}
