//! Transport-neutral local control request handler skeleton.
//!
//! This handler accepts control request values and returns control responses.
//! It executes read-only state queries. It does not mutate state, run commands,
//! start providers, open transports, or deliver subscriptions yet.

use nucleus_core::PersistenceRecordId;
use nucleus_local_store::{LocalStoreBackend, LocalStoreError};

use crate::client_auth::{ClientAuthReadiness, ClientAuthReadinessStatus};
use crate::commands::{AgentSessionCommand, ServerCommand, ServerCommandKind};
use crate::control_api::{
    AdapterSessionQuery, ModelRouteQuery, RuntimeMetadataQuery, ServerCommandReceipt,
    ServerCommandReceiptStatus, ServerControlError, ServerControlRequest, ServerControlRequestKind,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus, ServerQuery,
    ServerQueryKind, ServerQueryResult, ServerStateRecordSet, StateRecordQuery,
    StateRecordQueryScope,
};
use crate::event_replay::ServerEventReplayService;
use crate::ids::ServerControlRequestId;
use crate::scheduler::{
    RuntimeSchedulerAdmissionDecision, RuntimeSchedulerAdmissionRejection, RuntimeSchedulerQueue,
    RuntimeSchedulerRequest, RuntimeSchedulerRequestId, RuntimeSchedulerRequestKind,
    RuntimeSchedulerRequestRefs,
};
use crate::state::{ServerStateDomain, ServerStateDomainService, ServerStateService};

/// Boundary marker for the first local control request handler.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalControlRequestHandlerBoundary;

/// Local, transport-neutral request handler.
#[derive(Clone, Debug)]
pub struct LocalControlRequestHandler<B> {
    state: ServerStateService<B>,
    replay: ServerEventReplayService<B>,
    scheduler: RuntimeSchedulerQueue,
    auth_readiness: Option<ClientAuthReadiness>,
}

impl<B> LocalControlRequestHandler<B>
where
    B: LocalStoreBackend + Clone,
{
    /// Create a handler from local services.
    pub fn new(backend: B, auth_readiness: Option<ClientAuthReadiness>) -> Self {
        Self {
            state: ServerStateService::new(backend.clone()),
            replay: ServerEventReplayService::new(ServerStateService::new(backend)),
            scheduler: RuntimeSchedulerQueue::new(),
            auth_readiness,
        }
    }

    /// Access server-owned state services for later handler cards.
    pub fn state(&self) -> &ServerStateService<B> {
        &self.state
    }

    /// Access replay services for later handler cards.
    pub fn replay(&self) -> &ServerEventReplayService<B> {
        &self.replay
    }

    /// Access the inert scheduler queue for later handler cards.
    pub fn scheduler(&self) -> &RuntimeSchedulerQueue {
        &self.scheduler
    }

    /// Handle one local control request.
    pub fn handle(&mut self, request: ServerControlRequest) -> ServerControlResponse {
        if let Some(auth) = &self.auth_readiness {
            match auth.status {
                ClientAuthReadinessStatus::Denied => {
                    return error_response(
                        request,
                        ServerControlError::Unauthorized {
                            reason: "client auth readiness denied".to_owned(),
                        },
                    );
                }
                ClientAuthReadinessStatus::Deferred => {
                    return error_response(
                        request,
                        ServerControlError::Deferred {
                            reason: "client auth readiness deferred".to_owned(),
                        },
                    );
                }
                ClientAuthReadinessStatus::Ready => {}
            }
        }

        match request.kind {
            ServerControlRequestKind::Command(command) => self.handle_command(request.id, command),
            ServerControlRequestKind::Query(query) => self.handle_query(request.id, query),
        }
    }

    fn handle_command(
        &mut self,
        request_id: ServerControlRequestId,
        command: ServerCommand,
    ) -> ServerControlResponse {
        let status = match command.kind {
            ServerCommandKind::Project(_)
            | ServerCommandKind::Task(_)
            | ServerCommandKind::Workspace(_)
            | ServerCommandKind::ConfigureModelRoute(_) => {
                ServerCommandReceiptStatus::AcceptedForStateMutation
            }
            ServerCommandKind::AgentSession(AgentSessionCommand::RegisterAdapter(_)) => {
                ServerCommandReceiptStatus::AcceptedForStateMutation
            }
            ServerCommandKind::AgentSession(AgentSessionCommand::StartSession {
                adapter_id: _,
                project_id,
            }) => {
                let decision = self.scheduler.submit(RuntimeSchedulerRequest {
                    id: RuntimeSchedulerRequestId(format!("scheduler:{}", command.id.0)),
                    kind: RuntimeSchedulerRequestKind::Custom("agent-session-start".to_owned()),
                    refs: RuntimeSchedulerRequestRefs {
                        project_id,
                        task_id: None,
                        adapter: None,
                        command_request_id: None,
                        server_event_id: None,
                        runtime_effect_record_id: None,
                        retained_refs: Vec::new(),
                    },
                    summary: Some("agent session start requires runtime admission".to_owned()),
                });
                scheduler_receipt_status(decision)
            }
            ServerCommandKind::AgentSession(
                AgentSessionCommand::CancelActiveTurn { .. }
                | AgentSessionCommand::CloseSession { .. },
            ) => ServerCommandReceiptStatus::Rejected(ServerControlError::Deferred {
                reason: "agent session runtime control is not implemented".to_owned(),
            }),
        };

        let response_status = match status {
            ServerCommandReceiptStatus::AcceptedForStateMutation
            | ServerCommandReceiptStatus::AcceptedForRuntimeScheduling => {
                ServerControlResponseStatus::Accepted
            }
            ServerCommandReceiptStatus::Rejected(_) => ServerControlResponseStatus::Rejected,
        };

        ServerControlResponse {
            request_id,
            status: response_status,
            body: ServerControlResponseBody::Command(ServerCommandReceipt {
                command_id: command.id,
                status,
            }),
        }
    }

    fn handle_query(
        &self,
        request_id: ServerControlRequestId,
        query: ServerQuery,
    ) -> ServerControlResponse {
        match self.execute_query(query) {
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

    fn execute_query(&self, query: ServerQuery) -> Result<ServerQueryResult, ServerControlError> {
        match query.kind {
            ServerQueryKind::Project(query) => self
                .state_record_query(query, ServerStateDomain::Projects)
                .map(ServerQueryResult::StateRecords),
            ServerQueryKind::Task(query) => self
                .state_record_query(query, ServerStateDomain::Tasks)
                .map(ServerQueryResult::StateRecords),
            ServerQueryKind::Workspace(query) => self
                .state_record_query(query, ServerStateDomain::Workspaces)
                .map(ServerQueryResult::StateRecords),
            ServerQueryKind::AdapterSession(query) => self.adapter_session_query(query),
            ServerQueryKind::ModelRoute(query) => self.model_route_query(query),
            ServerQueryKind::RuntimeMetadata(query) => self.runtime_metadata_query(query),
        }
    }

    fn state_record_query(
        &self,
        query: StateRecordQuery,
        expected_domain: ServerStateDomain,
    ) -> Result<ServerStateRecordSet, ServerControlError> {
        if query.domain != expected_domain {
            return Err(ServerControlError::InvalidRequest {
                reason: format!(
                    "query domain {:?} does not match {:?}",
                    query.domain, expected_domain
                ),
            });
        }

        read_state_records(self.state.domain(query.domain), query.scope)
    }

    fn adapter_session_query(
        &self,
        query: AdapterSessionQuery,
    ) -> Result<ServerQueryResult, ServerControlError> {
        match query {
            AdapterSessionQuery::ListAdapters => {
                read_state_records(self.state.adapter_registry(), StateRecordQueryScope::List)
                    .map(ServerQueryResult::AdapterSessions)
            }
            AdapterSessionQuery::GetAdapter(adapter) => read_state_records(
                self.state.adapter_registry(),
                StateRecordQueryScope::Get(PersistenceRecordId(adapter.adapter_id)),
            )
            .map(ServerQueryResult::AdapterSessions),
            AdapterSessionQuery::ListSessions => {
                read_state_records(self.state.agent_sessions(), StateRecordQueryScope::List)
                    .map(ServerQueryResult::AdapterSessions)
            }
            AdapterSessionQuery::GetSession(session_id) => read_state_records(
                self.state.agent_sessions(),
                StateRecordQueryScope::Get(PersistenceRecordId(session_id.0)),
            )
            .map(ServerQueryResult::AdapterSessions),
            AdapterSessionQuery::ListSessionsForProject(_) => Ok(ServerQueryResult::Unsupported {
                reason: "session project indexes are not implemented".to_owned(),
            }),
        }
    }

    fn model_route_query(
        &self,
        query: ModelRouteQuery,
    ) -> Result<ServerQueryResult, ServerControlError> {
        match query {
            ModelRouteQuery::ListRoutes => {
                read_state_records(self.state.model_routes(), StateRecordQueryScope::List)
                    .map(ServerQueryResult::ModelRoutes)
            }
            ModelRouteQuery::GetRoute(route_id) => read_state_records(
                self.state.model_routes(),
                StateRecordQueryScope::Get(PersistenceRecordId(route_id)),
            )
            .map(ServerQueryResult::ModelRoutes),
            ModelRouteQuery::ResolveRouteForProject(_)
            | ModelRouteQuery::ResolveRouteForTask(_) => Ok(ServerQueryResult::Unsupported {
                reason: "model route resolution is not implemented".to_owned(),
            }),
        }
    }

    fn runtime_metadata_query(
        &self,
        query: RuntimeMetadataQuery,
    ) -> Result<ServerQueryResult, ServerControlError> {
        match query {
            RuntimeMetadataQuery::GetStoredEffect(record_id) => read_state_records(
                self.state.runtime_effects(),
                StateRecordQueryScope::Get(PersistenceRecordId(record_id.0)),
            )
            .map(ServerQueryResult::RuntimeMetadata),
            RuntimeMetadataQuery::ListCommandEvidence => {
                read_state_records(self.state.command_evidence(), StateRecordQueryScope::List)
                    .map(ServerQueryResult::RuntimeMetadata)
            }
            RuntimeMetadataQuery::ListArtifactMetadata => {
                read_state_records(self.state.artifact_metadata(), StateRecordQueryScope::List)
                    .map(ServerQueryResult::RuntimeMetadata)
            }
            RuntimeMetadataQuery::StoredEffects(_) | RuntimeMetadataQuery::ResolveRuntimeRef(_) => {
                Ok(ServerQueryResult::Unsupported {
                    reason: "runtime metadata ref queries are not implemented".to_owned(),
                })
            }
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

fn error_response(
    request: ServerControlRequest,
    error: ServerControlError,
) -> ServerControlResponse {
    ServerControlResponse {
        request_id: request.id,
        status: ServerControlResponseStatus::Rejected,
        body: ServerControlResponseBody::Error(error),
    }
}

fn storage_error(error: LocalStoreError) -> ServerControlError {
    ServerControlError::StorageUnavailable {
        reason: format!("{error:?}"),
    }
}

fn scheduler_receipt_status(
    decision: RuntimeSchedulerAdmissionDecision,
) -> ServerCommandReceiptStatus {
    match decision {
        RuntimeSchedulerAdmissionDecision::Accepted(_) => {
            ServerCommandReceiptStatus::AcceptedForRuntimeScheduling
        }
        RuntimeSchedulerAdmissionDecision::Rejected(rejection) => {
            ServerCommandReceiptStatus::Rejected(ServerControlError::RuntimeUnavailable {
                reason: scheduler_rejection_reason(rejection),
            })
        }
    }
}

fn scheduler_rejection_reason(rejection: RuntimeSchedulerAdmissionRejection) -> String {
    match rejection {
        RuntimeSchedulerAdmissionRejection::MissingProject => {
            "scheduler admission requires a project ref".to_owned()
        }
        RuntimeSchedulerAdmissionRejection::MissingCommandAuthority => {
            "scheduler admission requires command authority".to_owned()
        }
        RuntimeSchedulerAdmissionRejection::MissingAdapter => {
            "scheduler admission requires an adapter ref".to_owned()
        }
        RuntimeSchedulerAdmissionRejection::MissingEventMetadata => {
            "scheduler admission requires event metadata refs".to_owned()
        }
        RuntimeSchedulerAdmissionRejection::UnsupportedRequestKind => {
            "scheduler request kind is unsupported".to_owned()
        }
        RuntimeSchedulerAdmissionRejection::RuntimeExecutionDeferred => {
            "runtime execution is deferred".to_owned()
        }
        RuntimeSchedulerAdmissionRejection::Custom(reason) => reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_core::{PersistenceDomain, PersistenceRecordKind};
    use nucleus_local_store::{fixture_record, RevisionExpectation, SqliteBackend};
    use nucleus_tasks::TaskId;

    use crate::client_auth::{
        ClientAuthPosture, ClientAuthReadinessBlocker, ClientAuthReadinessStatus,
    };
    use crate::clients::{ClientIdentity, ClientKind};
    use crate::commands::{AgentSessionCommand, ServerCommand, ServerCommandKind, TaskCommand};
    use crate::control_api::{
        ServerQuery, ServerQueryKind, StateRecordQuery, StateRecordQueryScope,
    };
    use crate::ids::{ClientId, ServerCommandId, ServerControlRequestId, ServerQueryId};
    use crate::state::ServerStateDomain;

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
    fn handler_accepts_state_command_receipt_without_mutation_execution() {
        let (_temp_dir, mut handler) = handler(None);
        let response = handler.handle(ServerControlRequest {
            id: ServerControlRequestId("request:command".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerControlRequestKind::Command(ServerCommand {
                id: ServerCommandId("command:start-task".to_owned()),
                client_id: ClientId("client:desktop".to_owned()),
                kind: ServerCommandKind::Task(TaskCommand::Start(TaskId("task:1".to_owned()))),
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
}
