use nucleus_core::PersistenceRecordId;
use nucleus_engine::{
    EngineReadModelError, EngineReadModelService, EngineReadRecordSet, EngineReadScope,
    EngineStateDomain, EngineStateRecordReader,
};
use nucleus_local_store::{LocalStoreBackend, LocalStoreError, LocalStoreRecord};

use super::{storage_error, LocalControlRequestHandler};
use crate::control_api::{
    AdapterSessionQuery, ModelRouteQuery, ServerControlError, ServerQueryResult,
    ServerStateRecordSet, StateRecordQuery, StateRecordQueryScope,
};
use crate::state::{ServerStateDomain, ServerStateDomainService, ServerStateService};

pub(super) fn state_record_query<B>(
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

    if query.domain == ServerStateDomain::Goals {
        let mut records = read_state_records(handler.state.goals(), query.scope)?;
        records
            .records
            .retain(|record| record.kind == nucleus_core::PersistenceRecordKind::Goal);
        return Ok(records);
    }

    read_engine_state_records(&handler.state, query.domain, query.scope)
}

pub(super) fn adapter_session_query<B>(
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

pub(super) fn model_route_query<B>(
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

pub(crate) fn read_state_records<B>(
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
    mut records: EngineReadRecordSet<LocalStoreRecord>,
) -> ServerStateRecordSet {
    if domain == ServerStateDomain::Projects {
        records
            .records
            .retain(|record| record.kind == nucleus_core::PersistenceRecordKind::Project);
    }
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
