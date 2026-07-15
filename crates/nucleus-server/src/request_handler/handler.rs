use nucleus_local_store::LocalStoreBackend;

use super::{commands, queries};
use crate::client_auth::{ClientAuthReadiness, ClientAuthReadinessStatus};
use crate::control_api::{
    ServerControlError, ServerControlRequest, ServerControlRequestKind, ServerControlResponse,
    ServerControlResponseBody, ServerControlResponseStatus,
};
use crate::event_replay::ServerEventReplayService;
use crate::scheduler::RuntimeSchedulerQueue;
use crate::state::ServerStateService;

/// Local, transport-neutral request handler.
#[derive(Clone, Debug)]
pub struct LocalControlRequestHandler<B> {
    pub(crate) state: ServerStateService<B>,
    pub(crate) replay: ServerEventReplayService<B>,
    pub(crate) scheduler: RuntimeSchedulerQueue,
    auth_readiness: Option<ClientAuthReadiness>,
    authority_host_id: crate::EngineHostId,
}

impl<B> LocalControlRequestHandler<B>
where
    B: LocalStoreBackend + Clone,
{
    /// Create a handler from local services.
    pub fn new(backend: B, auth_readiness: Option<ClientAuthReadiness>) -> Self {
        Self::new_on_host(
            backend,
            auth_readiness,
            crate::EngineHostId("host:embedded-desktop".to_owned()),
        )
    }

    pub fn new_on_host(
        backend: B,
        auth_readiness: Option<ClientAuthReadiness>,
        authority_host_id: crate::EngineHostId,
    ) -> Self {
        Self {
            state: ServerStateService::new(backend.clone()),
            replay: ServerEventReplayService::new(ServerStateService::new(backend)),
            scheduler: RuntimeSchedulerQueue::new(),
            auth_readiness,
            authority_host_id,
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

    pub fn authority_host_id(&self) -> &crate::EngineHostId {
        &self.authority_host_id
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
            ServerControlRequestKind::Command(command) => {
                commands::handle_command(self, request.id, command)
            }
            ServerControlRequestKind::Query(query) => {
                queries::handle_query(self, request.id, query)
            }
        }
    }
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
