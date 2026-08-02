use std::sync::{Arc, Mutex};

use longhorn_bridge::{
    AuthenticationPosture, AuthorityEpoch, BridgeCommandEnvelope, BridgeCommandOutcome,
    BridgeCommandReply, BridgeConnectionReason, BridgeConnectionState, BridgeConnectionStatus,
    BridgeFailure, BridgeFailureMessage, BridgeFailurePhase, BridgeHelloRequest,
    BridgeHostDescriptor, BridgeHostForm, BridgeNegotiationReceipt, BridgeQueryEnvelope,
    BridgeQueryOutcome, BridgeQueryReply, BridgeRetryClass, DomainAuthorityDescriptor,
    DomainAvailability, DomainCapabilityDescriptor, ExecutionAuthority, ReadAuthority,
    WriteAuthority,
};
use longhorn_core::{
    AuthorityScopeId, BridgeCapabilityId, BridgeErrorCode, BridgeSessionId, DomainId,
    HostInstanceId,
};
use longhorn_tauri_bridge::{
    BridgeAuthorityProvider, BridgeCommandService, BridgeDomainRegistry, BridgeHandlerAssembly,
    BridgeHostError, BridgeHostErrorCode, TauriBridgeState,
};
use nucleus_local_store::SqliteBackend;
use nucleus_server::{
    ControlRequestBodyDto, ControlRequestEnvelopeDto, ControlResponseEnvelopeDto,
    ControlResponseStatusDto, TauriIpcControlCommandAdapter,
};
use tauri::Manager;

const DOMAIN_ID: &str = "nucleus.control";
const QUERY_CAPABILITY: &str = "nucleus.control.query";
const COMMAND_CAPABILITY: &str = "nucleus.control.command";
const QUERY_ROUTE: &str = "nucleus.control.query";
const COMMAND_ROUTE: &str = "nucleus.control.command";
const AUTHORITY_SCOPE: &str = "scope:nucleus-control-local";
const HOST_INSTANCE: &str = "host:nucleus-desktop";

type Adapter = Arc<Mutex<TauriIpcControlCommandAdapter<SqliteBackend>>>;

pub(crate) fn install(app: &tauri::App, adapter: Adapter) -> Result<(), String> {
    let assembly: Arc<dyn BridgeCommandService> = Arc::new(build_assembly(adapter)?);
    app.manage(TauriBridgeState::new(assembly));
    Ok(())
}

fn build_assembly(
    adapter: Adapter,
) -> Result<BridgeHandlerAssembly<NucleusBridgeAuthority>, String> {
    let mut registry = BridgeDomainRegistry::new();
    registry
        .register_domain(domain_capabilities()?)
        .map_err(|error| error.to_string())?;

    let query_adapter = Arc::clone(&adapter);
    registry
        .register_query::<ControlRequestEnvelopeDto, ControlResponseEnvelopeDto, ControlResponseEnvelopeDto, _>(
            domain_id(),
            QUERY_ROUTE,
            capability(QUERY_CAPABILITY),
            move |request: BridgeQueryEnvelope<ControlRequestEnvelopeDto>| {
                let request_id = request.context().request_id().clone();
                let payload = request.into_payload();
                validate_correlation(request_id.as_str(), &payload)?;
                if !matches!(payload.body, ControlRequestBodyDto::Query { .. }) {
                    return Err(payload_error("query route received a command control envelope"));
                }
                let response = submit(&query_adapter, payload)?;
                Ok(BridgeQueryReply::new(
                    request_id,
                    query_outcome(response)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;

    registry
        .register_command::<ControlRequestEnvelopeDto, ControlResponseEnvelopeDto, ControlResponseEnvelopeDto, _>(
            domain_id(),
            COMMAND_ROUTE,
            capability(COMMAND_CAPABILITY),
            move |request: BridgeCommandEnvelope<ControlRequestEnvelopeDto>| {
                if request.expected_revision().is_some() || request.idempotency_key().is_some() {
                    return Err(BridgeHostError::new(
                        BridgeHostErrorCode::InvalidAuthority,
                        "bridge-level revision and replay evidence are not mapped onto the Nucleus control envelope",
                        false,
                    ));
                }
                let request_id = request.context().request_id().clone();
                let payload = request.into_payload();
                validate_correlation(request_id.as_str(), &payload)?;
                if !matches!(payload.body, ControlRequestBodyDto::Command { .. }) {
                    return Err(payload_error("command route received a query control envelope"));
                }
                let response = submit(&adapter, payload)?;
                Ok(BridgeCommandReply::new(
                    request_id,
                    None,
                    command_outcome(response)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;

    Ok(BridgeHandlerAssembly::new(
        NucleusBridgeAuthority { next_session: 1 },
        registry,
    ))
}

struct NucleusBridgeAuthority {
    next_session: u64,
}

impl BridgeAuthorityProvider for NucleusBridgeAuthority {
    fn negotiate(
        &mut self,
        caller: &str,
        request: &BridgeHelloRequest,
        registered_domains: &[DomainCapabilityDescriptor],
    ) -> Result<BridgeNegotiationReceipt, BridgeHostError> {
        authorize(caller)?;
        let capabilities = registered_domains
            .iter()
            .filter(|descriptor| request.requested_domains().contains(descriptor.domain_id()))
            .cloned()
            .collect::<Vec<_>>();
        let authorities = capabilities
            .iter()
            .map(|descriptor| domain_authority(descriptor.domain_id().clone()))
            .collect::<Result<Vec<_>, _>>()?;
        let session = BridgeSessionId::new(format!("session:nucleus-local-{}", self.next_session))
            .map_err(negotiation_error)?;
        self.next_session = self.next_session.saturating_add(1);
        receipt(session, capabilities, authorities)
    }

    fn refresh(
        &mut self,
        caller: &str,
        current: &BridgeNegotiationReceipt,
    ) -> Result<BridgeNegotiationReceipt, BridgeHostError> {
        authorize(caller)?;
        receipt(
            current.session_id().clone(),
            current.domain_capabilities().to_vec(),
            current.domain_authorities().to_vec(),
        )
    }
}

fn receipt(
    session: BridgeSessionId,
    capabilities: Vec<DomainCapabilityDescriptor>,
    authorities: Vec<DomainAuthorityDescriptor>,
) -> Result<BridgeNegotiationReceipt, BridgeHostError> {
    BridgeNegotiationReceipt::new(
        BridgeHostDescriptor {
            host_instance_id: HostInstanceId::new(HOST_INSTANCE).map_err(negotiation_error)?,
            form: BridgeHostForm::TauriLocal,
        },
        session,
        BridgeConnectionStatus::new(
            BridgeConnectionState::Ready,
            Some(BridgeConnectionReason::NegotiationAccepted),
        )
        .map_err(negotiation_error)?,
        AuthenticationPosture::NotRequired,
        Vec::new(),
        capabilities,
        authorities,
        Vec::new(),
    )
    .map_err(negotiation_error)
}

fn domain_authority(domain: DomainId) -> Result<DomainAuthorityDescriptor, BridgeHostError> {
    DomainAuthorityDescriptor::new(
        domain,
        AuthorityScopeId::new(AUTHORITY_SCOPE).map_err(negotiation_error)?,
        DomainAvailability::Available,
        ReadAuthority::Authoritative,
        WriteAuthority::Authoritative,
        ExecutionAuthority::None,
        AuthorityEpoch::new(1).map_err(negotiation_error)?,
        None,
    )
    .map_err(negotiation_error)
}

fn domain_capabilities() -> Result<DomainCapabilityDescriptor, String> {
    DomainCapabilityDescriptor::new(
        domain_id(),
        vec![capability(QUERY_CAPABILITY), capability(COMMAND_CAPABILITY)],
    )
    .map_err(|error| error.to_string())
}

fn domain_id() -> DomainId {
    DomainId::new(DOMAIN_ID).expect("static bridge domain must be valid")
}

fn capability(value: &str) -> BridgeCapabilityId {
    BridgeCapabilityId::new(value).expect("static bridge capability must be valid")
}

fn authorize(caller: &str) -> Result<(), BridgeHostError> {
    if caller == "main" {
        Ok(())
    } else {
        Err(BridgeHostError::authority(
            "bridge caller is not authorized for the local Nucleus host",
            false,
        ))
    }
}

fn validate_correlation(
    bridge_request_id: &str,
    payload: &ControlRequestEnvelopeDto,
) -> Result<(), BridgeHostError> {
    if payload.request_id == bridge_request_id {
        Ok(())
    } else {
        Err(BridgeHostError::new(
            BridgeHostErrorCode::InvalidAuthority,
            "bridge and Nucleus control request correlation do not match",
            false,
        ))
    }
}

fn submit(
    adapter: &Adapter,
    request: ControlRequestEnvelopeDto,
) -> Result<ControlResponseEnvelopeDto, BridgeHostError> {
    let expected = request.request_id.clone();
    let response = adapter
        .lock()
        .map_err(|_| {
            BridgeHostError::new(
                BridgeHostErrorCode::StateUnavailable,
                "Nucleus control adapter is unavailable",
                true,
            )
        })?
        .submit_control_envelope(request)
        .map_err(|error| payload_error(error.reason))?;
    if response.request_id != expected {
        return Err(BridgeHostError::new(
            BridgeHostErrorCode::InvalidReply,
            "Nucleus control response correlation does not match the request",
            false,
        ));
    }
    Ok(response)
}

fn query_outcome(
    response: ControlResponseEnvelopeDto,
) -> Result<
    BridgeQueryOutcome<ControlResponseEnvelopeDto, ControlResponseEnvelopeDto>,
    BridgeHostError,
> {
    if response.status == ControlResponseStatusDto::Rejected {
        Ok(BridgeQueryOutcome::Rejected(domain_failure(response)?))
    } else {
        Ok(BridgeQueryOutcome::Success(response))
    }
}

fn command_outcome(
    response: ControlResponseEnvelopeDto,
) -> Result<
    BridgeCommandOutcome<ControlResponseEnvelopeDto, ControlResponseEnvelopeDto>,
    BridgeHostError,
> {
    if response.status == ControlResponseStatusDto::Rejected {
        Ok(BridgeCommandOutcome::Rejected(domain_failure(response)?))
    } else {
        Ok(BridgeCommandOutcome::Applied(response))
    }
}

fn domain_failure(
    response: ControlResponseEnvelopeDto,
) -> Result<BridgeFailure<ControlResponseEnvelopeDto>, BridgeHostError> {
    Ok(BridgeFailure::new(
        BridgeErrorCode::new("nucleus.control.rejected").map_err(negotiation_error)?,
        BridgeFailureMessage::new("Nucleus control authority rejected the request")
            .map_err(negotiation_error)?,
        BridgeRetryClass::Never,
        BridgeFailurePhase::Execution,
        Some(response),
    ))
}

fn payload_error(message: impl Into<String>) -> BridgeHostError {
    BridgeHostError::new(BridgeHostErrorCode::PayloadCodec, message, false)
}

fn negotiation_error(error: impl std::fmt::Display) -> BridgeHostError {
    BridgeHostError::new(
        BridgeHostErrorCode::InvalidAuthority,
        error.to_string(),
        false,
    )
}

#[cfg(test)]
mod tests;
