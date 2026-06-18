use crate::control_api::{
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult, ServerStateRecordSet,
};
use crate::control_envelope_dto::*;
use crate::ids::{ServerCommandId, ServerControlRequestId};
use crate::read_only_command_control::ReadOnlyCommandControlResult;
use crate::runtime_readiness_diagnostics::local_host_runtime_readiness_diagnostics;
use crate::{unsupported_local_host_runtime_discovery, EngineHostId};
use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{LocalStoreRecord, LocalStoreRecordPayload};

#[test]
fn response_envelope_dto_serializes_read_only_command_result_without_raw_output() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:readonly-response".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::ReadOnlyCommand(ReadOnlyCommandControlResult {
            command_id: ServerCommandId("command:dto:readonly".to_owned()),
            command_request_id: nucleus_command_policy::CommandRequestId(
                "command:dto:readonly:request".to_owned(),
            ),
            evidence_id: nucleus_command_policy::CommandEvidenceId(
                "command:dto:readonly:evidence".to_owned(),
            ),
            status: nucleus_command_policy::CommandExecutionStatus::Succeeded,
            exit_status: Some(0),
            retention: nucleus_command_policy::CommandOutputRetention::SummaryOnly,
            summary: Some("sanitized summary".to_owned()),
            stdout_captured_bytes: 16,
            stderr_captured_bytes: 0,
            stdout_truncated: true,
            stderr_truncated: false,
            events: 3,
            rejection: None,
        }),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::ReadOnlyCommandResult {
            status,
            retention,
            stdout_captured_bytes: 16,
            stdout_truncated: true,
            rejection: None,
            ..
        } if status == "succeeded" && retention == "summary_only"
    ));
    assert!(!json.contains("raw_stdout"));
    assert!(!json.contains("raw_stderr"));
}

#[test]
fn response_envelope_dto_serializes_command_evidence_records_without_raw_output() {
    let evidence = nucleus_command_policy::CommandEvidence {
        id: nucleus_command_policy::CommandEvidenceId("command:evidence:dto".to_owned()),
        request_id: nucleus_command_policy::CommandRequestId("command:request:dto".to_owned()),
        status: nucleus_command_policy::CommandExecutionStatus::Succeeded,
        exit_status: Some(0),
        retention: nucleus_command_policy::CommandOutputRetention::ArtifactReference,
        summary: Some("sanitized command summary".to_owned()),
        stdout_artifact_ref: Some("artifact:stdout".to_owned()),
        stderr_artifact_ref: None,
    };
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:command-evidence".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::RuntimeMetadata(
            ServerStateRecordSet {
                domain: ServerStateDomain::CommandEvidence,
                records: vec![LocalStoreRecord {
                    id: PersistenceRecordId("command:evidence:dto".to_owned()),
                    domain: PersistenceDomain::CommandEvidence,
                    kind: PersistenceRecordKind::CommandEvidence,
                    revision_id: RevisionId("rev:command-evidence:1".to_owned()),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: nucleus_command_policy::encode_command_evidence_storage_record(
                            &evidence,
                        )
                        .expect("evidence json"),
                    },
                }],
            },
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::CommandEvidenceRecords { records }
            if records.len() == 1
                && records[0].evidence_id == "command:evidence:dto"
                && records[0].command_request_id == "command:request:dto"
                && records[0].status == "succeeded"
                && records[0].retention == "artifact_reference"
                && records[0].stdout_artifact_ref == Some("artifact:stdout".to_owned())
    ));
    assert!(!json.contains("raw_stdout"));
    assert!(!json.contains("raw_stderr"));
    assert!(!json.contains("raw_output"));
}

#[test]
fn response_envelope_dto_serializes_runtime_readiness_without_payloads() {
    let diagnostics = local_host_runtime_readiness_diagnostics(
        &unsupported_local_host_runtime_discovery(EngineHostId("host:local".to_owned())),
    );
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:runtime-readiness".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::RuntimeReadiness(vec![
            diagnostics,
        ])),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::RuntimeReadinessDiagnostics { records }
            if records.len() == 1
                && records[0].host_id == "host:local"
                && records[0].runtime_surface == "local_host_command_execution"
                && records[0].status == "unsupported"
                && records[0].blockers.iter().any(|blocker| blocker.code == "sandbox_backend_unsupported")
                && records[0].evidence_refs.iter().any(|item| item == "evidence:host:local:local-host-runtime:unsupported")
    ));
    for forbidden in [
        "raw_stdout",
        "raw_stderr",
        "payload",
        "bytes",
        "credential",
        "secret",
        "environment",
    ] {
        assert!(
            !json.contains(forbidden),
            "runtime readiness DTO should not contain {forbidden}"
        );
    }
}
