use super::*;
use nucleus_core::{PersistenceDomain, PersistenceRecordKind, RevisionId};
use nucleus_engine::{
    EngineCheckpointFamily, EngineCheckpointRecord, EngineCheckpointRecordId,
    EngineCheckpointRecoveryState, EngineCheckpointRef, EngineDiffSummaryConfidence,
    EngineDiffSummaryKind, EngineDiffSummaryRecord, EngineDiffSummaryRecordId,
    EngineTaskAgentWorkUnitReviewStatus, EngineTaskAgentWorkUnitRuntimeStatus,
    EngineTaskAgentWorkUnitSourceCursor, EngineTaskAgentWorkUnitSourceId,
    EngineTaskAgentWorkUnitSourceRecord, EngineTaskWorkItemId, EngineTaskWorkItemRefs,
};
use nucleus_local_store::{fixture_record, RevisionExpectation, SqliteBackend};
use nucleus_orchestration::{
    decode_orchestration_event_store_record, OrchestrationCommandFamily, OrchestrationEventKind,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use super::command_projection::rebuild_command_admission_projection;
use crate::checkpoint_diff_state::{write_checkpoint_record, write_diff_summary_record};
use crate::client_auth::{
    ClientAuthPosture, ClientAuthReadiness, ClientAuthReadinessBlocker, ClientAuthReadinessStatus,
};
use crate::clients::{ClientIdentity, ClientKind};
use crate::commands::{
    AgentSessionCommand, ServerCommand, ServerCommandKind, TaskCommand, TaskDelegationCommand,
    TaskTransitionCommand,
};
use crate::control_api::{
    AdapterSessionQuery, DiagnosticsQuery, ProjectAuthorityMapQuery, ProviderReadIntentQuery,
    ProviderReadinessOverviewQuery, RuntimeMetadataQuery, ServerCommandReceipt,
    ServerCommandReceiptStatus, ServerControlError, ServerControlRequest, ServerControlRequestKind,
    ServerControlResponseBody, ServerControlResponseStatus, ServerDiagnosticsQueryResult,
    ServerQuery, ServerQueryKind, ServerQueryResult, ServerStateRecordSet, StateRecordQuery,
    StateRecordQueryScope, TaskTimelineQuery,
};
use crate::host_authority::ProjectAuthorityDomain;
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

mod checkpoint_diff;
mod diagnostics_queries;
mod host_authority;
mod memory_proposal_review;
mod project_queries;
mod provider_live_read_smoke_evidence;
mod provider_read_intent;
mod provider_readiness_overview;
mod read_only_commands;
mod runtime_auth;
mod steward_commands;
mod task_authoring;
mod task_transitions;
mod task_work_progress_query;

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

fn persist_task_agent_source(
    handler: &LocalControlRequestHandler<SqliteBackend>,
) -> EngineTaskAgentWorkUnitSourceRecord {
    let scheduled = EngineTaskAgentWorkUnitSourceRecord {
        source_id: EngineTaskAgentWorkUnitSourceId("source:task-agent:1".to_owned()),
        source_cursor: EngineTaskAgentWorkUnitSourceCursor("0001".to_owned()),
        work_item_id: EngineTaskWorkItemId("work:item:1".to_owned()),
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        command_id: "command:delegate:1".to_owned(),
        actor_ref: "operator:tom".to_owned(),
        adapter_id: "adapter:codex".to_owned(),
        provider_instance_id: "provider:codex:local".to_owned(),
        idempotency_key: "idem:task-agent:1".to_owned(),
        task_revision: Some(RevisionId("task:rev:1".to_owned())),
        runtime: EngineTaskAgentWorkUnitRuntimeStatus::Scheduled,
        review: EngineTaskAgentWorkUnitReviewStatus::NotReady,
        refs: EngineTaskWorkItemRefs::default(),
        previous_source_id: None,
        summary: "work unit scheduled from persisted task history".to_owned(),
    };
    crate::task_agent_work_unit_state::write_task_agent_work_unit_source_record(
        handler.state(),
        scheduled.clone(),
        RevisionId("rev:source:1".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write scheduled task-agent source record");

    let running = EngineTaskAgentWorkUnitSourceRecord {
        source_id: EngineTaskAgentWorkUnitSourceId("source:task-agent:2".to_owned()),
        source_cursor: EngineTaskAgentWorkUnitSourceCursor("0002".to_owned()),
        runtime: EngineTaskAgentWorkUnitRuntimeStatus::Running,
        previous_source_id: Some(scheduled.source_id.clone()),
        summary: "work unit running from persisted task history".to_owned(),
        ..scheduled
    };
    crate::task_agent_work_unit_state::write_task_agent_work_unit_source_record(
        handler.state(),
        running.clone(),
        RevisionId("rev:source:2".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write running task-agent source record");
    running
}
