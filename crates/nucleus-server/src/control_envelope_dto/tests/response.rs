use crate::client_protocol::{
    ProjectAuthorityDomainPublication, ProjectAuthorityMapPublicationRecord,
    ProjectAuthorityPublicationState, ProjectAuthorityValidationIssue,
};
use crate::control_api::{
    ServerControlError, ServerControlResponse, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQueryResult, ServerStateRecordSet,
};
use crate::control_envelope_dto::*;
use crate::host_authority::ProjectAuthorityDomain;
use crate::ids::{ServerCommandId, ServerControlRequestId};
use crate::read_only_command_control::ReadOnlyCommandControlResult;
use crate::runtime_readiness_diagnostics::local_host_runtime_readiness_diagnostics;
use crate::{unsupported_local_host_runtime_discovery, EngineHostId};
use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{LocalStoreRecord, LocalStoreRecordPayload};
use nucleus_projects::{
    encode_project_storage_record, ImportanceBaseline, ImportanceLevel, Project, ProjectActivity,
    ProjectId, ProjectStatus,
};
use nucleus_tasks::{
    encode_task_storage_record, AcceptanceCriterion, AgentReadiness, AssignmentState, NeglectLevel,
    NeglectSignal, Task, TaskActionType, TaskActivityState, TaskId, TaskImportance, TaskTimestamps,
};

#[test]
fn response_envelope_dto_serializes_project_authority_map() {
    let record = ProjectAuthorityMapPublicationRecord {
        project_id: ProjectId("project:authority".to_owned()),
        domains: vec![
            ProjectAuthorityDomainPublication {
                domain: ProjectAuthorityDomain::Execution,
                state: ProjectAuthorityPublicationState::Assigned {
                    authoritative_host_id: EngineHostId("host:remote-worker".to_owned()),
                    fallback_host_ids: vec![EngineHostId("host:local".to_owned())],
                    mutation_allowed: true,
                },
                note: Some("remote execution host".to_owned()),
            },
            ProjectAuthorityDomainPublication {
                domain: ProjectAuthorityDomain::Projection,
                state: ProjectAuthorityPublicationState::MutationDenied {
                    authoritative_host_id: EngineHostId("host:local".to_owned()),
                    fallback_host_ids: Vec::new(),
                },
                note: None,
            },
        ],
        issues: vec![ProjectAuthorityValidationIssue::DomainUnassigned {
            domain: ProjectAuthorityDomain::Task,
        }],
    };
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:authority-map".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::ProjectAuthorityMap(record)),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlResponseEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");

    assert!(matches!(
        decoded.body,
        ControlResponseBodyDto::ProjectAuthorityMap { record }
            if record.project_id == "project:authority"
                && record.domains.len() == 2
                && record.domains[0].domain == "execution"
                && record.domains[0].state == "assigned"
                && record.domains[0].authoritative_host_id.as_deref()
                    == Some("host:remote-worker")
                && record.domains[1].state == "mutation_denied"
                && record.issues.len() == 1
    ));
}

#[test]
fn response_envelope_dto_serializes_status_error_and_state_records() {
    let project = Project {
        id: ProjectId("project:dto".to_owned()),
        display_name: "DTO Project".to_owned(),
        status: ProjectStatus::Active,
        importance_baseline: ImportanceBaseline {
            level: ImportanceLevel::High,
            notes: None,
        },
        repos: Vec::new(),
        task_ids: Vec::new(),
        workspace_layout_refs: Vec::new(),
        activity: ProjectActivity {
            created_at: None,
            last_focused_at: None,
            last_agent_activity_at: None,
            last_task_activity_at: None,
        },
    };
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:response".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::StateRecords(
            ServerStateRecordSet {
                domain: ServerStateDomain::Projects,
                records: vec![LocalStoreRecord {
                    id: PersistenceRecordId("project:dto".to_owned()),
                    domain: PersistenceDomain::Projects,
                    kind: PersistenceRecordKind::Project,
                    revision_id: RevisionId("rev:1".to_owned()),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: encode_project_storage_record(&project).expect("project json"),
                    },
                }],
            },
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlResponseEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");

    assert_eq!(decoded.status, ControlResponseStatusDto::Complete);
    assert!(matches!(
        decoded.body,
        ControlResponseBodyDto::ProjectRecords { records } if records.len() == 1
    ));
}

#[test]
fn response_envelope_dto_serializes_task_records() {
    let task = Task {
        id: TaskId("task:dto".to_owned()),
        project_id: ProjectId("project:dto".to_owned()),
        title: "DTO Task".to_owned(),
        description: Some("Display task records".to_owned()),
        acceptance_criteria: vec![AcceptanceCriterion {
            text: "Task appears in typed response".to_owned(),
            required: true,
        }],
        importance: TaskImportance::Critical,
        neglect: NeglectSignal {
            level: NeglectLevel::Fresh,
            last_addressed_at: None,
            note: None,
        },
        action_type: TaskActionType::Check,
        assignment: AssignmentState::Human("tom".to_owned()),
        activity: TaskActivityState::Active,
        agent_readiness: AgentReadiness {
            ready_for_agent: false,
            required_context_refs: Vec::new(),
            allowed_actions: vec![TaskActionType::Check],
            stop_conditions: Vec::new(),
            validation_commands: Vec::new(),
        },
        assignment_plan: None,
        assignment_snapshot: None,
        history: Vec::new(),
        model_preferences: None,
        timestamps: TaskTimestamps {
            created_at: None,
            updated_at: None,
            started_at: None,
            completed_at: None,
        },
    };
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:task-response".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::StateRecords(
            ServerStateRecordSet {
                domain: ServerStateDomain::Tasks,
                records: vec![LocalStoreRecord {
                    id: PersistenceRecordId("task:dto".to_owned()),
                    domain: PersistenceDomain::Tasks,
                    kind: PersistenceRecordKind::Task,
                    revision_id: RevisionId("rev:task:1".to_owned()),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: encode_task_storage_record(&task).expect("task json"),
                    },
                }],
            },
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlResponseEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");

    assert!(matches!(
        decoded.body,
        ControlResponseBodyDto::TaskRecords { records }
            if records.len() == 1
                && records[0].task_id == "task:dto"
                && records[0].project_id == "project:dto"
                && records[0].title == "DTO Task"
                && records[0].importance == "critical"
                && records[0].action_type == "check"
                && records[0].activity == "active"
    ));
}

#[test]
fn response_error_shape_is_explicit() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:error".to_owned()),
        status: ServerControlResponseStatus::Rejected,
        body: ServerControlResponseBody::Error(ServerControlError::Deferred {
            reason: "not wired".to_owned(),
        }),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");

    assert_eq!(dto.status, ControlResponseStatusDto::Rejected);
    assert_eq!(
        dto.body,
        ControlResponseBodyDto::Error {
            kind: "deferred".to_owned(),
            reason: "not wired".to_owned(),
        }
    );
}

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
