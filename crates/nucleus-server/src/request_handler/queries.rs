use nucleus_core::PersistenceRecordId;
use nucleus_local_store::{LocalStoreBackend, LocalStoreError};

use super::handler::LocalControlRequestHandler;
use crate::control_api::{
    AdapterSessionQuery, ModelRouteQuery, RuntimeMetadataQuery, ServerControlError,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus, ServerQuery,
    ServerQueryKind, ServerQueryResult, ServerStateRecordSet, StateRecordQuery,
    StateRecordQueryScope,
};
use crate::ids::ServerControlRequestId;
use crate::state::{ServerStateDomain, ServerStateDomainService};

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

    read_state_records(handler.state.domain(query.domain), query.scope)
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
        RuntimeMetadataQuery::ListArtifactMetadata => read_state_records(
            handler.state.artifact_metadata(),
            StateRecordQueryScope::List,
        )
        .map(ServerQueryResult::RuntimeMetadata),
        RuntimeMetadataQuery::StoredEffects(_) | RuntimeMetadataQuery::ResolveRuntimeRef(_) => {
            Ok(ServerQueryResult::Unsupported {
                reason: "runtime metadata ref queries are not implemented".to_owned(),
            })
        }
    }
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

fn storage_error(error: LocalStoreError) -> ServerControlError {
    ServerControlError::StorageUnavailable {
        reason: format!("{error:?}"),
    }
}
