use super::*;
use nucleus_core::{PersistenceDomain, PersistenceRecordKind};
use nucleus_engine::{
    EngineCheckpointFamily, EngineCheckpointRecord, EngineCheckpointRecordId,
    EngineCheckpointRecoveryState, EngineCheckpointRef, EngineDiffSummaryConfidence,
    EngineDiffSummaryKind, EngineDiffSummaryRecord, EngineDiffSummaryRecordId,
};
use nucleus_local_store::{fixture_record, RevisionExpectation, SqliteBackend};
use nucleus_orchestration::{
    decode_orchestration_event_store_record, OrchestrationCommandFamily, OrchestrationEventKind,
};
use nucleus_tasks::TaskId;

use super::command_projection::rebuild_command_admission_projection;
use crate::checkpoint_diff_state::{write_checkpoint_record, write_diff_summary_record};
use crate::client_auth::{
    ClientAuthPosture, ClientAuthReadiness, ClientAuthReadinessBlocker, ClientAuthReadinessStatus,
};
use crate::clients::{ClientIdentity, ClientKind};
use crate::commands::{
    AgentSessionCommand, ServerCommand, ServerCommandKind, TaskCommand, TaskTransitionCommand,
};
use crate::control_api::{
    AdapterSessionQuery, RuntimeMetadataQuery, ServerCommandReceipt, ServerCommandReceiptStatus,
    ServerControlError, ServerControlRequest, ServerControlRequestKind, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQuery, ServerQueryKind, ServerQueryResult,
    ServerStateRecordSet, StateRecordQuery, StateRecordQueryScope, TaskTimelineQuery,
};
use crate::ids::{ClientId, ServerCommandId, ServerControlRequestId, ServerQueryId};
use crate::project_seed::{seed_local_project, LocalProjectSeed};
use crate::state::ServerStateDomain;
use crate::task_seed::{seed_local_task, LocalTaskSeed};

fn handler(
    auth_readiness: Option<ClientAuthReadiness>,
) -> (tempfile::TempDir, LocalControlRequestHandler<SqliteBackend>) {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    (
        temp_dir,
        LocalControlRequestHandler::new(backend, auth_readiness),
    )
}

mod read_only_commands;

fn query_request() -> ServerControlRequest {
    ServerControlRequest {
        id: ServerControlRequestId("request:query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:projects".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Project(StateRecordQuery {
                domain: ServerStateDomain::Projects,
                scope: StateRecordQueryScope::List,
            }),
        }),
    }
}

#[test]
fn handler_executes_project_list_query() {
    let (_temp_dir, mut handler) = handler(None);
    let record = fixture_record(
        PersistenceDomain::Projects,
        PersistenceRecordKind::Project,
        "project:1",
        "rev:1",
    );
    handler
        .state()
        .projects()
        .put(record.clone(), RevisionExpectation::MustNotExist)
        .expect("seed project");

    let response = handler.handle(query_request());

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::StateRecords(
            ServerStateRecordSet { records, .. }
        )) if records == vec![record]
    ));
}

#[test]
fn handler_executes_task_transition_command_and_reads_back_task_dto() {
    let (_temp_dir, mut handler) = handler(None);
    seed_local_task(
        handler.state(),
        LocalTaskSeed {
            task_id: "task:1".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            title: "Seed Task".to_owned(),
            action_type: nucleus_tasks::TaskActionType::Plan,
            importance: nucleus_tasks::TaskImportance::Normal,
        },
    )
    .expect("seed task");

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:command".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:start-task".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Task(TaskCommand::Start(TaskTransitionCommand {
                task_id: TaskId("task:1".to_owned()),
                expected_revision: None,
            })),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Accepted);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Command(ServerCommandReceipt {
            status: ServerCommandReceiptStatus::AcceptedForStateMutation,
            ..
        })
    ));
    let events = handler.state().event_journal().list().expect("events");
    assert_eq!(events.len(), 1);
    let event_store_record = decode_orchestration_event_store_record(&events[0].payload.bytes)
        .expect("decode event record");
    assert_eq!(
        event_store_record.stream_ref.0,
        "stream:command-admission:task:1"
    );
    let event = event_store_record.into_payload();
    assert_eq!(event.kind, OrchestrationEventKind::CommandAdmitted);
    assert_eq!(event.command_id.0, "command:start-task");
    assert_eq!(event.family, OrchestrationCommandFamily::Task);
    assert_eq!(event.target_ref.as_deref(), Some("task:1"));
    let projection =
        rebuild_command_admission_projection(handler.state()).expect("command projection");
    assert_eq!(projection.admitted_total, 1);
    assert_eq!(projection.task_commands, 1);

    let query_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:task-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:tasks".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Task(StateRecordQuery {
                domain: ServerStateDomain::Tasks,
                scope: StateRecordQueryScope::List,
            }),
        }),
    });
    let dto = crate::control_envelope_dto::ControlResponseEnvelopeDto::try_from(&query_response)
        .expect("task dto response");

    assert!(matches!(
        dto.body,
        crate::control_envelope_dto::ControlResponseBodyDto::TaskRecords { records }
            if records.len() == 1 && records[0].activity == "active"
    ));
}

#[test]
fn handler_projects_task_timeline_from_command_events() {
    let (_temp_dir, mut handler) = handler(None);
    seed_local_task(
        handler.state(),
        LocalTaskSeed {
            task_id: "task:timeline".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            title: "Timeline Task".to_owned(),
            action_type: nucleus_tasks::TaskActionType::Plan,
            importance: nucleus_tasks::TaskImportance::Normal,
        },
    )
    .expect("seed task");

    let command_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:timeline-command".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:start-timeline-task".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Task(TaskCommand::Start(TaskTransitionCommand {
                task_id: TaskId("task:timeline".to_owned()),
                expected_revision: None,
            })),
        }),
    });
    assert_eq!(
        command_response.status,
        ServerControlResponseStatus::Accepted
    );

    let timeline_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:timeline-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:task-timeline".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::TaskTimeline(TaskTimelineQuery {
                task_id: TaskId("task:timeline".to_owned()),
            }),
        }),
    });

    assert_eq!(
        timeline_response.status,
        ServerControlResponseStatus::Complete
    );
    assert!(matches!(
        timeline_response.body,
        ServerControlResponseBody::Query(ServerQueryResult::TaskTimeline(projection))
            if projection.task_id.0 == "task:timeline"
                && projection.entries.len() == 1
                && projection.entries[0].source_command_id == "command:start-timeline-task"
                && projection.entries[0].source_event_id == "event:command:start-timeline-task:admitted"
    ));
}

#[test]
fn handler_lists_checkpoint_and_diff_records_without_runtime_receipt_collision() {
    let (_temp_dir, mut handler) = handler(None);
    let checkpoint = EngineCheckpointRecord {
        checkpoint_id: EngineCheckpointRecordId("checkpoint:task:handler".to_owned()),
        family: EngineCheckpointFamily::TaskWork,
        primary_workflow_ref: EngineCheckpointRef::TaskId("task:handler".to_owned()),
        project_ref: EngineCheckpointRef::ProjectId("project:nucleus-local".to_owned()),
        source_ref: Some(EngineCheckpointRef::SnapshotRef(
            "convergence:snapshot:handler".to_owned(),
        )),
        scm_adapter_ref: Some(EngineCheckpointRef::ScmAdapterRef(
            "adapter:convergence".to_owned(),
        )),
        authority_host_ref: EngineCheckpointRef::AuthorityHostId("host:local".to_owned()),
        created_by_actor_ref: EngineCheckpointRef::ActorId("actor:user".to_owned()),
        causal_refs: vec![EngineCheckpointRef::CommandId(
            "command:checkpoint".to_owned(),
        )],
        parent_checkpoint_refs: Vec::new(),
        artifact_refs: Vec::new(),
        summary: Some("handler checkpoint".to_owned()),
        recovery_state: EngineCheckpointRecoveryState::Available,
    };
    let diff = EngineDiffSummaryRecord {
        diff_id: EngineDiffSummaryRecordId("diff:handler".to_owned()),
        kind: EngineDiffSummaryKind::Source,
        source_boundary_ref: EngineCheckpointRef::SnapshotRef("snapshot:before".to_owned()),
        target_boundary_ref: EngineCheckpointRef::SnapshotRef("snapshot:after".to_owned()),
        source_ref: Some(EngineCheckpointRef::RepoId("repo:nucleus".to_owned())),
        adapter_ref: Some(EngineCheckpointRef::ScmAdapterRef("adapter:scm".to_owned())),
        generated_by_ref: EngineCheckpointRef::CommandId("command:diff".to_owned()),
        confidence: EngineDiffSummaryConfidence::Partial,
        summary: "source summary".to_owned(),
        changed_paths: vec!["crates/nucleus-engine/src/lib.rs".to_owned()],
        evidence_refs: Vec::new(),
        artifact_refs: Vec::new(),
    };
    write_checkpoint_record(
        handler.state(),
        &checkpoint,
        nucleus_core::RevisionId("rev:checkpoint:handler".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write checkpoint");
    write_diff_summary_record(
        handler.state(),
        &diff,
        nucleus_core::RevisionId("rev:diff:handler".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write diff");

    let checkpoint_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:checkpoint-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:checkpoints".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::RuntimeMetadata(RuntimeMetadataQuery::ListCheckpointRecords),
        }),
    });
    let diff_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:diff-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:diffs".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::RuntimeMetadata(RuntimeMetadataQuery::ListDiffSummaryRecords),
        }),
    });
    let receipt_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:receipt-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:receipts-empty".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::RuntimeMetadata(RuntimeMetadataQuery::ListRuntimeReceipts),
        }),
    });

    assert!(matches!(
        checkpoint_response.body,
        ServerControlResponseBody::Query(ServerQueryResult::CheckpointRecords(ref records))
            if records.as_slice() == std::slice::from_ref(&checkpoint)
    ));
    assert!(matches!(
        diff_response.body,
        ServerControlResponseBody::Query(ServerQueryResult::DiffSummaryRecords(ref records))
            if records.as_slice() == std::slice::from_ref(&diff)
    ));
    assert!(matches!(
        receipt_response.body,
        ServerControlResponseBody::Query(ServerQueryResult::RuntimeReceipts(records))
            if records.is_empty()
    ));

    let checkpoint_dto =
        crate::control_envelope_dto::ControlResponseEnvelopeDto::try_from(&checkpoint_response)
            .expect("checkpoint dto");
    let diff_dto =
        crate::control_envelope_dto::ControlResponseEnvelopeDto::try_from(&diff_response)
            .expect("diff dto");
    assert!(matches!(
        checkpoint_dto.body,
        crate::control_envelope_dto::ControlResponseBodyDto::CheckpointRecords { records }
            if records.len() == 1
                && records[0].checkpoint_id == "checkpoint:task:handler"
                && records[0].scm_adapter_ref.as_deref() == Some("adapter:convergence")
    ));
    assert!(matches!(
        diff_dto.body,
        crate::control_envelope_dto::ControlResponseBodyDto::DiffSummaryRecords { records }
            if records.len() == 1
                && records[0].diff_id == "diff:handler"
                && records[0].changed_paths == vec!["crates/nucleus-engine/src/lib.rs".to_owned()]
    ));
}

#[test]
fn handler_executes_task_create_command_and_reads_back_task_dto() {
    let (_temp_dir, mut handler) = handler(None);
    seed_local_project(handler.state(), LocalProjectSeed::nucleus_local()).expect("seed project");

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:create-task".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:create-task".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Task(TaskCommand::Create(
                crate::commands::TaskCreateCommand {
                    project_id: nucleus_projects::ProjectId("project:nucleus-local".to_owned()),
                    title: "Create task through handler".to_owned(),
                    description: Some("Write a task record through server authority.".to_owned()),
                    acceptance_criteria: vec![nucleus_tasks::AcceptanceCriterion {
                        text: "Task appears in read-after-write DTO".to_owned(),
                        required: true,
                    }],
                    importance: nucleus_tasks::TaskImportance::High,
                    action_type: nucleus_tasks::TaskActionType::Plan,
                    activity: nucleus_tasks::TaskActivityState::Proposed,
                    agent_readiness: nucleus_tasks::AgentReadiness {
                        ready_for_agent: true,
                        required_context_refs: vec![
                            "docs/contracts/005-task-contract.md".to_owned()
                        ],
                        allowed_actions: vec![nucleus_tasks::TaskActionType::Plan],
                        stop_conditions: Vec::new(),
                        validation_commands: vec!["effigy test --plan".to_owned()],
                    },
                },
            )),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Accepted);

    let query_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:created-task-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:created-tasks".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Task(StateRecordQuery {
                domain: ServerStateDomain::Tasks,
                scope: StateRecordQueryScope::List,
            }),
        }),
    });
    let dto = crate::control_envelope_dto::ControlResponseEnvelopeDto::try_from(&query_response)
        .expect("task dto response");

    assert!(matches!(
        dto.body,
        crate::control_envelope_dto::ControlResponseBodyDto::TaskRecords { records }
            if records.len() == 1
                && records[0].task_id == "task:command:create-task"
                && records[0].title == "Create task through handler"
                && records[0].importance == "high"
                && records[0].agent_ready
    ));
}

#[test]
fn handler_executes_task_update_command_with_revision_check() {
    let (_temp_dir, mut handler) = handler(None);
    let seeded = seed_local_task(
        handler.state(),
        LocalTaskSeed {
            task_id: "task:update".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            title: "Seed Task".to_owned(),
            action_type: nucleus_tasks::TaskActionType::Plan,
            importance: nucleus_tasks::TaskImportance::Normal,
        },
    )
    .expect("seed task");

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:update-task".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:update-task".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Task(TaskCommand::Update(
                crate::commands::TaskUpdateCommand {
                    task_id: TaskId("task:update".to_owned()),
                    expected_revision: Some(seeded.revision_id.clone()),
                    changes: crate::commands::TaskUpdateChanges {
                        title: Some("Updated Task".to_owned()),
                        importance: Some(nucleus_tasks::TaskImportance::Critical),
                        activity: Some(nucleus_tasks::TaskActivityState::Ready),
                        ..Default::default()
                    },
                },
            )),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Accepted);

    let query_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:updated-task-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:updated-tasks".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Task(StateRecordQuery {
                domain: ServerStateDomain::Tasks,
                scope: StateRecordQueryScope::List,
            }),
        }),
    });
    let dto = crate::control_envelope_dto::ControlResponseEnvelopeDto::try_from(&query_response)
        .expect("task dto response");

    assert!(matches!(
        dto.body,
        crate::control_envelope_dto::ControlResponseBodyDto::TaskRecords { records }
            if records.len() == 1
                && records[0].title == "Updated Task"
                && records[0].importance == "critical"
                && records[0].activity == "ready"
    ));
}

#[test]
fn handler_rejects_runtime_session_start_until_scheduler_refs_exist() {
    let (_temp_dir, mut handler) = handler(None);
    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:start-session".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:start-session".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::AgentSession(AgentSessionCommand::StartSession {
                adapter_id: "adapter:codex".to_owned(),
                project_id: nucleus_projects::ProjectId("project:1".to_owned()),
            }),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Rejected);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Command(ServerCommandReceipt {
            status: ServerCommandReceiptStatus::Rejected(
                ServerControlError::RuntimeUnavailable { .. }
            ),
            ..
        })
    ));
    assert!(handler.scheduler().queued_items().is_empty());
}

#[test]
fn skeleton_denies_requests_when_auth_readiness_is_denied() {
    let auth_readiness = ClientAuthReadiness {
        client: ClientIdentity {
            id: ClientId("client:mobile".to_owned()),
            kind: ClientKind::Mobile,
            display_name: "mobile".to_owned(),
        },
        observed_posture: ClientAuthPosture::UnpairedLocal,
        status: ClientAuthReadinessStatus::Denied,
        blockers: vec![ClientAuthReadinessBlocker::UnsupportedClientKind {
            kind: ClientKind::Mobile,
        }],
    };
    let (_temp_dir, mut handler) = handler(Some(auth_readiness));
    let response = handler.handle(query_request());

    assert_eq!(response.status, ServerControlResponseStatus::Rejected);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Error(ServerControlError::Unauthorized { .. })
    ));
}

#[test]
fn handler_executes_adapter_session_and_runtime_metadata_queries() {
    let (_temp_dir, mut handler) = handler(None);
    let adapter_record = fixture_record(
        PersistenceDomain::AdapterRegistry,
        PersistenceRecordKind::AdapterInstance,
        "adapter:codex",
        "rev:1",
    );
    let evidence_record = fixture_record(
        PersistenceDomain::CommandEvidence,
        PersistenceRecordKind::CommandEvidence,
        "evidence:1",
        "rev:1",
    );
    handler
        .state()
        .adapter_registry()
        .put(adapter_record.clone(), RevisionExpectation::MustNotExist)
        .expect("seed adapter");
    handler
        .state()
        .command_evidence()
        .put(evidence_record.clone(), RevisionExpectation::MustNotExist)
        .expect("seed evidence");

    let adapter_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:adapters".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:adapters".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::AdapterSession(AdapterSessionQuery::ListAdapters),
        }),
    });
    let evidence_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:evidence".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:evidence".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::RuntimeMetadata(RuntimeMetadataQuery::ListCommandEvidence),
        }),
    });

    assert!(matches!(
        adapter_response.body,
        ServerControlResponseBody::Query(ServerQueryResult::AdapterSessions(
            ServerStateRecordSet { records, .. }
        )) if records == vec![adapter_record]
    ));
    assert!(matches!(
        evidence_response.body,
        ServerControlResponseBody::Query(ServerQueryResult::RuntimeMetadata(
            ServerStateRecordSet { records, .. }
        )) if records == vec![evidence_record]
    ));
}

#[test]
fn handler_reports_unsupported_indexed_filters_without_transport_errors() {
    let (_temp_dir, mut handler) = handler(None);
    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:project-index".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:sessions-for-project".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::AdapterSession(AdapterSessionQuery::ListSessionsForProject(
                nucleus_projects::ProjectId("project:1".to_owned()),
            )),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Unsupported { .. })
    ));
}
