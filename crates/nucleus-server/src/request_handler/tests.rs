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
    AgentSessionCommand, ServerCommand, ServerCommandKind, TaskCommand, TaskDelegationCommand,
    TaskTransitionCommand,
};
use crate::control_api::{
    AdapterSessionQuery, DiagnosticsQuery, ProjectAuthorityMapQuery, RuntimeMetadataQuery,
    ServerCommandReceipt, ServerCommandReceiptStatus, ServerControlError, ServerControlRequest,
    ServerControlRequestKind, ServerControlResponseBody, ServerControlResponseStatus,
    ServerDiagnosticsQueryResult, ServerQuery, ServerQueryKind, ServerQueryResult,
    ServerStateRecordSet, StateRecordQuery, StateRecordQueryScope, TaskTimelineQuery,
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
mod project_queries;
mod read_only_commands;
mod runtime_auth;
mod steward_commands;
mod task_work_progress_query;
mod task_authoring;
mod task_transitions;

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
