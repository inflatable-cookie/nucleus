use nucleus_core::PersistenceRecordId;
use nucleus_engine::{
    EngineReadModelError, EngineReadModelService, EngineReadRecordSet, EngineReadScope,
    EngineStateDomain, EngineStateRecordReader, EngineTaskTimelineProjection,
};
use nucleus_local_store::LocalStoreRecord;
use nucleus_local_store::{LocalStoreBackend, LocalStoreError};
use nucleus_orchestration::{OrchestrationEventRecord, OrchestrationEventStoreRepository};

use super::event_store::ServerOrchestrationEventStore;
use super::handler::LocalControlRequestHandler;
use crate::checkpoint_diff_state::{read_checkpoint_records, read_diff_summary_records};
use crate::control_api::{
    AdapterSessionQuery, ModelRouteQuery, RuntimeMetadataQuery, ServerControlError,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus, ServerQuery,
    ServerQueryKind, ServerQueryResult, ServerStateRecordSet, StateRecordQuery,
    StateRecordQueryScope, TaskTimelineQuery,
};
use crate::ids::ServerControlRequestId;
use crate::runtime_readiness_diagnostics::local_host_runtime_readiness_diagnostics;
use crate::runtime_receipt_state::read_runtime_receipts;
use crate::state::ServerStateService;
use crate::state::{ServerStateDomain, ServerStateDomainService};
use crate::{unsupported_local_host_runtime_discovery, EngineHostId};

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
        ServerQueryKind::RuntimeMetadata(query) => runtime_metadata_query(handler, query),
        ServerQueryKind::TaskTimeline(query) => task_timeline_query(handler, query),
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

fn runtime_metadata_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: RuntimeMetadataQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    match query {
        RuntimeMetadataQuery::GetStoredEffect(record_id) => read_state_records(
            handler.state.runtime_effects(),
            StateRecordQueryScope::Get(PersistenceRecordId(record_id.0)),
        )
        .map(ServerQueryResult::RuntimeMetadata),
        RuntimeMetadataQuery::ListCommandEvidence => read_state_records(
            handler.state.command_evidence(),
            StateRecordQueryScope::List,
        )
        .map(ServerQueryResult::RuntimeMetadata),
        RuntimeMetadataQuery::ListRuntimeReceipts => read_runtime_receipts(handler.state())
            .map(ServerQueryResult::RuntimeReceipts)
            .map_err(storage_error),
        RuntimeMetadataQuery::ListCheckpointRecords => read_checkpoint_records(handler.state())
            .map(ServerQueryResult::CheckpointRecords)
            .map_err(storage_error),
        RuntimeMetadataQuery::ListDiffSummaryRecords => read_diff_summary_records(handler.state())
            .map(ServerQueryResult::DiffSummaryRecords)
            .map_err(storage_error),
        RuntimeMetadataQuery::ListArtifactMetadata => read_state_records(
            handler.state.artifact_metadata(),
            StateRecordQueryScope::List,
        )
        .map(ServerQueryResult::RuntimeMetadata),
        RuntimeMetadataQuery::GetLocalRuntimeReadiness => {
            let discovery =
                unsupported_local_host_runtime_discovery(EngineHostId("host:local".to_owned()));
            Ok(ServerQueryResult::RuntimeReadiness(vec![
                local_host_runtime_readiness_diagnostics(&discovery),
            ]))
        }
        RuntimeMetadataQuery::StoredEffects(_) | RuntimeMetadataQuery::ResolveRuntimeRef(_) => {
            Ok(ServerQueryResult::Unsupported {
                reason: "runtime metadata ref queries are not implemented".to_owned(),
            })
        }
    }
}

fn task_timeline_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: TaskTimelineQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let events = ServerOrchestrationEventStore::new(handler.state())
        .list_events()
        .map_err(storage_error)?
        .into_iter()
        .map(|event_store_record| event_store_record.into_payload())
        .collect::<Vec<OrchestrationEventRecord>>();
    let projection = EngineTaskTimelineProjection::rebuild(query.task_id, &events);

    Ok(ServerQueryResult::TaskTimeline(projection))
}

fn read_state_records<B>(
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

fn storage_error(error: LocalStoreError) -> ServerControlError {
    ServerControlError::StorageUnavailable {
        reason: format!("{error:?}"),
    }
}
