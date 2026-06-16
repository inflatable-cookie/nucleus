use crate::control_api::ServerControlRequest;
use crate::local_transport::{
    LocalControlTransport, LocalControlTransportError, LocalControlTransportExchange,
};
use crate::request_handler::LocalControlRequestHandler;
use crate::transport_readiness::{
    LocalTransportCandidate, LocalTransportReadiness, LocalTransportReadinessStatus,
};
use nucleus_local_store::LocalStoreBackend;

/// In-process transport fixture backed by the local request handler.
#[derive(Clone, Debug)]
pub struct InProcessControlHandlerFixture<B> {
    handler: LocalControlRequestHandler<B>,
    exchanges: Vec<LocalControlTransportExchange>,
}

impl<B> InProcessControlHandlerFixture<B>
where
    B: LocalStoreBackend + Clone,
{
    /// Create a handler-backed in-process transport fixture.
    pub fn new(handler: LocalControlRequestHandler<B>) -> Self {
        Self {
            handler,
            exchanges: Vec::new(),
        }
    }

    /// Access the backing handler.
    pub fn handler(&self) -> &LocalControlRequestHandler<B> {
        &self.handler
    }

    /// Access the backing handler mutably for fixture setup.
    pub fn handler_mut(&mut self) -> &mut LocalControlRequestHandler<B> {
        &mut self.handler
    }

    /// Recorded request/response exchanges.
    pub fn exchanges(&self) -> &[LocalControlTransportExchange] {
        &self.exchanges
    }
}

impl<B> LocalControlTransport for InProcessControlHandlerFixture<B>
where
    B: LocalStoreBackend + Clone,
{
    fn candidate(&self) -> LocalTransportCandidate {
        LocalTransportCandidate::InProcess
    }

    fn readiness(&self) -> LocalTransportReadiness {
        LocalTransportReadiness {
            candidate: self.candidate(),
            status: LocalTransportReadinessStatus::Ready,
            blockers: Vec::new(),
        }
    }

    fn exchange(
        &mut self,
        request: ServerControlRequest,
    ) -> Result<LocalControlTransportExchange, LocalControlTransportError> {
        let response = self.handler.handle(request.clone());
        let exchange = LocalControlTransportExchange { request, response };
        self.exchanges.push(exchange.clone());
        Ok(exchange)
    }
}
