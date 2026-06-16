use crate::control_api::{ServerControlRequest, ServerControlResponse};
use crate::local_transport::{
    LocalControlTransport, LocalControlTransportError, LocalControlTransportExchange,
};
use crate::transport_readiness::{
    LocalTransportCandidate, LocalTransportReadiness, LocalTransportReadinessBlocker,
    LocalTransportReadinessStatus,
};

/// Non-production in-process client fixture.
///
/// This fixture carries request/response exchanges without a server handler.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct InProcessControlClientFixture {
    ready: bool,
    scripted_responses: Vec<ServerControlResponse>,
    exchanges: Vec<LocalControlTransportExchange>,
}

impl InProcessControlClientFixture {
    /// Create a ready in-process fixture with scripted responses.
    pub fn ready(scripted_responses: Vec<ServerControlResponse>) -> Self {
        Self {
            ready: true,
            scripted_responses,
            exchanges: Vec::new(),
        }
    }

    /// Create a blocked in-process fixture.
    pub fn blocked() -> Self {
        Self {
            ready: false,
            scripted_responses: Vec::new(),
            exchanges: Vec::new(),
        }
    }

    /// Recorded request/response exchanges.
    pub fn exchanges(&self) -> &[LocalControlTransportExchange] {
        &self.exchanges
    }
}

impl LocalControlTransport for InProcessControlClientFixture {
    fn candidate(&self) -> LocalTransportCandidate {
        LocalTransportCandidate::InProcess
    }

    fn readiness(&self) -> LocalTransportReadiness {
        if self.ready {
            LocalTransportReadiness {
                candidate: self.candidate(),
                status: LocalTransportReadinessStatus::Ready,
                blockers: Vec::new(),
            }
        } else {
            LocalTransportReadiness {
                candidate: self.candidate(),
                status: LocalTransportReadinessStatus::Blocked,
                blockers: vec![LocalTransportReadinessBlocker::RequestHandlerMissing],
            }
        }
    }

    fn exchange(
        &mut self,
        request: ServerControlRequest,
    ) -> Result<LocalControlTransportExchange, LocalControlTransportError> {
        if !self.ready {
            return Err(LocalControlTransportError::Unavailable {
                reason: "in-process fixture is blocked".to_owned(),
            });
        }

        let Some(response) = self.scripted_responses.first().cloned() else {
            return Err(LocalControlTransportError::Unavailable {
                reason: "in-process fixture has no scripted response".to_owned(),
            });
        };
        self.scripted_responses.remove(0);

        let exchange = LocalControlTransportExchange { request, response };
        self.exchanges.push(exchange.clone());
        Ok(exchange)
    }
}
