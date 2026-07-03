use nucleus_core::PersistenceRecordId;
use nucleus_engine::{
    EngineReadModelError, EngineReadModelService, EngineReadRecordSet, EngineReadScope,
    EngineStateDomain, EngineStateRecordReader,
};
use nucleus_local_store::LocalStoreRecord;
use nucleus_local_store::{LocalStoreBackend, LocalStoreError};

use super::handler::LocalControlRequestHandler;
use crate::control_api::{
    AdapterSessionQuery, DiagnosticsQuery, ModelRouteQuery, ServerControlError,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerDiagnosticsQueryResult, ServerDiagnosticsSnapshot, ServerQuery, ServerQueryKind,
    ServerQueryResult, ServerStateRecordSet, StateRecordQuery, StateRecordQueryScope,
};
use crate::diagnostics_read_models::{
    codex_callback_diagnostics, codex_callback_response_execution_diagnostics,
    codex_ingestion_diagnostics, codex_interruption_diagnostics,
    codex_interruption_execution_diagnostics, codex_live_executor_diagnostics,
    codex_live_spawn_smoke_diagnostics, codex_provider_diagnostics, codex_recovery_diagnostics,
    codex_recovery_execution_diagnostics, codex_subscription_diagnostics,
    codex_task_backed_live_execution_diagnostics, codex_transport_executor_diagnostics,
    codex_turn_start_diagnostics, durable_provider_executor_diagnostics, effigy_diagnostics,
    scm_session_diagnostics, steward_diagnostics, sync_diagnostics, task_agent_diagnostics,
};
use crate::ids::ServerControlRequestId;
use crate::state::ServerStateService;
use crate::state::{ServerStateDomain, ServerStateDomainService};
use crate::{
    completion_scm_capture_control_dto,
    completion_scm_capture_diagnostics_from_persisted_admissions,
    completion_scm_capture_preparation_control_dto,
    completion_scm_capture_preparation_diagnostics_from_persisted_records,
    completion_scm_control_dto, completion_scm_read_model, git_dry_run_execution_control_dto,
    git_dry_run_execution_diagnostics_from_persisted_records, live_evidence_completion_control_dto,
    live_evidence_completion_read_model, live_evidence_task_state_history_from_persisted_controls,
    read_codex_live_executor_outcome_records, read_completion_scm_capture_admissions,
    read_completion_scm_capture_preparations, read_durable_provider_executor_command_records,
    read_git_dry_run_executions, read_live_evidence_task_completions,
    read_live_evidence_task_state_control_records, read_scm_capture_dry_run_execution_receipts,
    read_scm_capture_dry_run_plans, scm_capture_dry_run_control_dto,
    scm_capture_dry_run_diagnostics_from_persisted_records,
    scm_capture_dry_run_execution_control_dto,
    scm_capture_dry_run_execution_diagnostics_from_persisted_records,
    scm_capture_review_control_dto, scm_capture_review_decision_control_dto,
    scm_capture_review_decision_diagnostics, scm_capture_review_diagnostics,
    scm_capture_review_readiness, scm_capture_workflow_control_dto,
    scm_capture_workflow_diagnostics, scm_capture_workflow_projection,
    scm_change_request_prep_control_dto,
    scm_change_request_prep_diagnostics_from_persisted_records, CompletionScmReadModelInput,
    LiveEvidenceCompletionReadModelInput, ScmCaptureReviewReadinessInput,
    ScmCaptureWorkflowProjectionInput,
};

mod authority_map;
mod diagnostics;
mod planning_capture_publication_diagnostics;
mod planning_projection_file_write_diagnostics;
mod planning_projection_import_diagnostics;
mod planning_task_seeds;
mod provider_live_read_executor;
mod provider_live_read_smoke_evidence;
mod provider_read_intent;
mod provider_readiness_overview;
mod runtime_metadata;
mod task_readiness;
mod task_seed_promotion_diagnostics;
mod task_timeline;

pub(crate) fn handle_query<B>(
    handler: &LocalControlRequestHandler<B>,
    request_id: ServerControlRequestId,
    query: ServerQuery,
) -> ServerControlResponse
where
    B: LocalStoreBackend + Clone,
{
    match execute_query(handler, query) {
        Ok(result) => ServerControlResponse {
            request_id,
            status: ServerControlResponseStatus::Complete,
            body: ServerControlResponseBody::Query(result),
        },
        Err(error) => ServerControlResponse {
            request_id,
            status: ServerControlResponseStatus::Rejected,
            body: ServerControlResponseBody::Error(error),
        },
    }
}

fn execute_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: ServerQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    match query.kind {
        ServerQueryKind::Project(query) => {
            state_record_query(handler, query, ServerStateDomain::Projects)
                .map(ServerQueryResult::StateRecords)
        }
        ServerQueryKind::Task(query) => {
            state_record_query(handler, query, ServerStateDomain::Tasks)
                .map(ServerQueryResult::StateRecords)
        }
        ServerQueryKind::Workspace(query) => {
            state_record_query(handler, query, ServerStateDomain::Workspaces)
                .map(ServerQueryResult::StateRecords)
        }
        ServerQueryKind::AdapterSession(query) => adapter_session_query(handler, query),
        ServerQueryKind::ModelRoute(query) => model_route_query(handler, query),
        ServerQueryKind::RuntimeMetadata(query) => {
            runtime_metadata::runtime_metadata_query(handler, query)
        }
        ServerQueryKind::Diagnostics(query) => diagnostics::diagnostics_query(handler, query),
        ServerQueryKind::ProviderReadIntent(query) => {
            provider_read_intent::provider_read_intent_query(handler, query)
        }
        ServerQueryKind::ProviderReadinessOverview(query) => {
            provider_readiness_overview::provider_readiness_overview_query(handler, query)
        }
        ServerQueryKind::ProviderLiveReadExecutor(query) => {
            provider_live_read_executor::provider_live_read_executor_query(handler, query)
        }
        ServerQueryKind::ProviderLiveReadSmokeEvidence(query) => {
            provider_live_read_smoke_evidence::provider_live_read_smoke_evidence_query(
                handler, query,
            )
        }
        ServerQueryKind::TaskTimeline(query) => task_timeline::task_timeline_query(handler, query),
        ServerQueryKind::TaskReadiness(query) => {
            task_readiness::task_readiness_query(handler, query)
        }
        ServerQueryKind::PlanningTaskSeeds(query) => {
            planning_task_seeds::planning_task_seeds_query(handler, query)
        }
        ServerQueryKind::TaskSeedPromotionDiagnostics(query) => {
            task_seed_promotion_diagnostics::task_seed_promotion_diagnostics_query(handler, query)
        }
        ServerQueryKind::PlanningProjectionFileWriteDiagnostics(query) => {
            planning_projection_file_write_diagnostics::planning_projection_file_write_diagnostics_query(query)
        }
        ServerQueryKind::PlanningProjectionImportDiagnostics(query) => {
            planning_projection_import_diagnostics::planning_projection_import_diagnostics_query(query)
        }
        ServerQueryKind::PlanningCapturePublicationDiagnostics(query) => {
            planning_capture_publication_diagnostics::planning_capture_publication_diagnostics_query(handler, query)
        }
        ServerQueryKind::ProjectAuthorityMap(query) => {
            authority_map::project_authority_map_query(query)
        }
    }
}

fn state_record_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: StateRecordQuery,
    expected_domain: ServerStateDomain,
) -> Result<ServerStateRecordSet, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if query.domain != expected_domain {
        return Err(ServerControlError::InvalidRequest {
            reason: format!(
                "query domain {:?} does not match {:?}",
                query.domain, expected_domain
            ),
        });
    }

    read_engine_state_records(&handler.state, query.domain, query.scope)
}

fn adapter_session_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: AdapterSessionQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    match query {
        AdapterSessionQuery::ListAdapters => read_state_records(
            handler.state.adapter_registry(),
            StateRecordQueryScope::List,
        )
        .map(ServerQueryResult::AdapterSessions),
        AdapterSessionQuery::GetAdapter(adapter) => read_state_records(
            handler.state.adapter_registry(),
            StateRecordQueryScope::Get(PersistenceRecordId(adapter.adapter_id)),
        )
        .map(ServerQueryResult::AdapterSessions),
        AdapterSessionQuery::ListSessions => {
            read_state_records(handler.state.agent_sessions(), StateRecordQueryScope::List)
                .map(ServerQueryResult::AdapterSessions)
        }
        AdapterSessionQuery::GetSession(session_id) => read_state_records(
            handler.state.agent_sessions(),
            StateRecordQueryScope::Get(PersistenceRecordId(session_id.0)),
        )
        .map(ServerQueryResult::AdapterSessions),
        AdapterSessionQuery::ListSessionsForProject(_) => Ok(ServerQueryResult::Unsupported {
            reason: "session project indexes are not implemented".to_owned(),
        }),
    }
}

fn model_route_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: ModelRouteQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    match query {
        ModelRouteQuery::ListRoutes => {
            read_state_records(handler.state.model_routes(), StateRecordQueryScope::List)
                .map(ServerQueryResult::ModelRoutes)
        }
        ModelRouteQuery::GetRoute(route_id) => read_state_records(
            handler.state.model_routes(),
            StateRecordQueryScope::Get(PersistenceRecordId(route_id)),
        )
        .map(ServerQueryResult::ModelRoutes),
        ModelRouteQuery::ResolveRouteForProject(_) | ModelRouteQuery::ResolveRouteForTask(_) => {
            Ok(ServerQueryResult::Unsupported {
                reason: "model route resolution is not implemented".to_owned(),
            })
        }
    }
}

pub(super) fn read_state_records<B>(
    service: ServerStateDomainService<'_, B>,
    scope: StateRecordQueryScope,
) -> Result<ServerStateRecordSet, ServerControlError>
where
    B: LocalStoreBackend,
{
    let domain = service.domain().clone();
    let records = match scope {
        StateRecordQueryScope::Get(id) => match service.get(&id).map_err(storage_error)? {
            Some(record) => vec![record],
            None => {
                return Err(ServerControlError::NotFound {
                    reason: format!("record not found: {}", id.0),
                });
            }
        },
        StateRecordQueryScope::List => service.list().map_err(storage_error)?,
        StateRecordQueryScope::ListByProject(_)
        | StateRecordQueryScope::ListByTask(_)
        | StateRecordQueryScope::ListByWorkspace(_)
        | StateRecordQueryScope::ListByRepo(_) => {
            return Ok(ServerStateRecordSet {
                domain,
                records: Vec::new(),
            });
        }
    };

    Ok(ServerStateRecordSet { domain, records })
}

fn read_engine_state_records<B>(
    state: &ServerStateService<B>,
    domain: ServerStateDomain,
    scope: StateRecordQueryScope,
) -> Result<ServerStateRecordSet, ServerControlError>
where
    B: LocalStoreBackend,
{
    let engine_domain = engine_domain_from_server_domain(&domain)?;
    let engine_scope = engine_scope_from_server_scope(scope);
    let reader = ServerEngineStateReader { state };
    let service = EngineReadModelService::new(reader);
    let records = service
        .read(engine_domain, engine_scope)
        .map_err(engine_read_error)?;

    Ok(server_record_set_from_engine(domain, records))
}

fn engine_domain_from_server_domain(
    domain: &ServerStateDomain,
) -> Result<EngineStateDomain, ServerControlError> {
    match domain {
        ServerStateDomain::Projects => Ok(EngineStateDomain::Projects),
        ServerStateDomain::Tasks => Ok(EngineStateDomain::Tasks),
        ServerStateDomain::Workspaces => Ok(EngineStateDomain::Workspaces),
        _ => Err(ServerControlError::Unsupported {
            reason: format!("engine read domain is not implemented for {domain:?}"),
        }),
    }
}

fn engine_scope_from_server_scope(scope: StateRecordQueryScope) -> EngineReadScope {
    match scope {
        StateRecordQueryScope::Get(id) => EngineReadScope::Get(id),
        StateRecordQueryScope::List => EngineReadScope::List,
        StateRecordQueryScope::ListByProject(_)
        | StateRecordQueryScope::ListByTask(_)
        | StateRecordQueryScope::ListByWorkspace(_)
        | StateRecordQueryScope::ListByRepo(_) => EngineReadScope::UnsupportedIndex,
    }
}

fn server_record_set_from_engine(
    domain: ServerStateDomain,
    records: EngineReadRecordSet<LocalStoreRecord>,
) -> ServerStateRecordSet {
    ServerStateRecordSet {
        domain,
        records: records.records,
    }
}

fn engine_read_error(error: EngineReadModelError<LocalStoreError>) -> ServerControlError {
    match error {
        EngineReadModelError::NotFound { id } => ServerControlError::NotFound {
            reason: format!("record not found: {}", id.0),
        },
        EngineReadModelError::Reader(error) => storage_error(error),
    }
}

struct ServerEngineStateReader<'a, B> {
    state: &'a ServerStateService<B>,
}

impl<B> EngineStateRecordReader for ServerEngineStateReader<'_, B>
where
    B: LocalStoreBackend,
{
    type Error = LocalStoreError;
    type Record = LocalStoreRecord;

    fn get(
        &self,
        domain: EngineStateDomain,
        id: &PersistenceRecordId,
    ) -> Result<Option<Self::Record>, Self::Error> {
        self.service(domain).get(id)
    }

    fn list(&self, domain: EngineStateDomain) -> Result<Vec<Self::Record>, Self::Error> {
        self.service(domain).list()
    }
}

impl<'a, B> ServerEngineStateReader<'a, B>
where
    B: LocalStoreBackend,
{
    fn service(&self, domain: EngineStateDomain) -> ServerStateDomainService<'a, B> {
        match domain {
            EngineStateDomain::Projects => self.state.projects(),
            EngineStateDomain::Tasks => self.state.tasks(),
            EngineStateDomain::Workspaces => self.state.workspaces(),
        }
    }
}

pub(super) fn storage_error(error: LocalStoreError) -> ServerControlError {
    ServerControlError::StorageUnavailable {
        reason: format!("{error:?}"),
    }
}
