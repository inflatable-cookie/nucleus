/// First supported client protocol family.
pub const CLIENT_PROTOCOL_FAMILY: &str = "nucleus.client";

/// First supported client protocol version.
pub const CLIENT_PROTOCOL_VERSION_V1: u16 = 1;

/// Client protocol profile advertised by a host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientProtocolProfile {
    pub family: String,
    pub version: u16,
    pub compatibility: ClientProtocolCompatibility,
    pub authority: ClientProtocolAuthority,
    pub messages: Vec<ClientProtocolMessageShape>,
}

impl ClientProtocolProfile {
    /// First profile shared by embedded, sidecar, and local proof clients.
    pub fn v1_control_and_events() -> Self {
        Self {
            family: CLIENT_PROTOCOL_FAMILY.to_owned(),
            version: CLIENT_PROTOCOL_VERSION_V1,
            compatibility: ClientProtocolCompatibility::ExactVersionOnly,
            authority: ClientProtocolAuthority::ProtocolBoundaryOnly,
            messages: vec![
                ClientProtocolMessageShape::control_request(),
                ClientProtocolMessageShape::control_response(),
                ClientProtocolMessageShape::server_event(),
            ],
        }
    }

    /// Returns true when this profile includes the message kind.
    pub fn supports_message(&self, kind: ClientProtocolMessageKind) -> bool {
        self.messages.iter().any(|message| message.kind == kind)
    }

    /// Assess protocol shape readiness without choosing or opening a transport.
    pub fn assess_readiness(
        &self,
        request_response_envelopes_defined: bool,
        event_envelope_defined: bool,
        version_policy_defined: bool,
        dto_authority_defined: bool,
    ) -> ClientProtocolReadiness {
        let mut blockers = Vec::new();

        if !request_response_envelopes_defined {
            blockers.push(ClientProtocolReadinessBlocker::ControlEnvelopeShapeDeferred);
        }
        if !event_envelope_defined {
            blockers.push(ClientProtocolReadinessBlocker::EventEnvelopeShapeDeferred);
        }
        if !version_policy_defined {
            blockers.push(ClientProtocolReadinessBlocker::VersionPolicyDeferred);
        }
        if !dto_authority_defined {
            blockers.push(ClientProtocolReadinessBlocker::DtoAuthorityDeferred);
        }
        if !self.supports_message(ClientProtocolMessageKind::ControlRequest)
            || !self.supports_message(ClientProtocolMessageKind::ControlResponse)
        {
            blockers.push(ClientProtocolReadinessBlocker::ControlMessageMissing);
        }
        if !self.supports_message(ClientProtocolMessageKind::ServerEvent) {
            blockers.push(ClientProtocolReadinessBlocker::EventMessageMissing);
        }
        if self.authority != ClientProtocolAuthority::ProtocolBoundaryOnly {
            blockers.push(ClientProtocolReadinessBlocker::ProtocolAuthorityAmbiguous);
        }

        let status = if blockers.is_empty() {
            ClientProtocolReadinessStatus::Ready
        } else {
            ClientProtocolReadinessStatus::Deferred
        };

        ClientProtocolReadiness { status, blockers }
    }
}

/// Compatibility posture for one protocol family.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientProtocolCompatibility {
    ExactVersionOnly,
    BackwardCompatibleWithinMajor,
    Custom(String),
}

/// Authority carried by client protocol records.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientProtocolAuthority {
    ProtocolBoundaryOnly,
    EngineHostAuthority,
    Custom(String),
}

/// Message kind carried by the client protocol.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClientProtocolMessageKind {
    ControlRequest,
    ControlResponse,
    ServerEvent,
}

/// Shape of one protocol message envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientProtocolMessageShape {
    pub kind: ClientProtocolMessageKind,
    pub fields: Vec<ClientProtocolEnvelopeField>,
}

impl ClientProtocolMessageShape {
    pub fn control_request() -> Self {
        Self {
            kind: ClientProtocolMessageKind::ControlRequest,
            fields: vec![
                ClientProtocolEnvelopeField::ProtocolFamily,
                ClientProtocolEnvelopeField::ProtocolVersion,
                ClientProtocolEnvelopeField::MessageKind,
                ClientProtocolEnvelopeField::RequestId,
                ClientProtocolEnvelopeField::ClientId,
                ClientProtocolEnvelopeField::Payload,
            ],
        }
    }

    pub fn control_response() -> Self {
        Self {
            kind: ClientProtocolMessageKind::ControlResponse,
            fields: vec![
                ClientProtocolEnvelopeField::ProtocolFamily,
                ClientProtocolEnvelopeField::ProtocolVersion,
                ClientProtocolEnvelopeField::MessageKind,
                ClientProtocolEnvelopeField::RequestId,
                ClientProtocolEnvelopeField::ResponseStatus,
                ClientProtocolEnvelopeField::Payload,
                ClientProtocolEnvelopeField::ErrorShape,
            ],
        }
    }

    pub fn server_event() -> Self {
        Self {
            kind: ClientProtocolMessageKind::ServerEvent,
            fields: vec![
                ClientProtocolEnvelopeField::ProtocolFamily,
                ClientProtocolEnvelopeField::ProtocolVersion,
                ClientProtocolEnvelopeField::MessageKind,
                ClientProtocolEnvelopeField::EventId,
                ClientProtocolEnvelopeField::EventKind,
                ClientProtocolEnvelopeField::ClientId,
                ClientProtocolEnvelopeField::ReplayToken,
                ClientProtocolEnvelopeField::Payload,
            ],
        }
    }
}

/// Required fields for a protocol envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientProtocolEnvelopeField {
    ProtocolFamily,
    ProtocolVersion,
    MessageKind,
    RequestId,
    ClientId,
    ResponseStatus,
    EventId,
    EventKind,
    ReplayToken,
    Payload,
    ErrorShape,
    Custom(String),
}

/// Readiness assessment for using a protocol profile.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientProtocolReadiness {
    pub status: ClientProtocolReadinessStatus,
    pub blockers: Vec<ClientProtocolReadinessBlocker>,
}

/// Readiness status for one protocol profile.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientProtocolReadinessStatus {
    Ready,
    Deferred,
}

/// Reason the protocol profile is not ready for transport implementation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientProtocolReadinessBlocker {
    ControlEnvelopeShapeDeferred,
    EventEnvelopeShapeDeferred,
    VersionPolicyDeferred,
    DtoAuthorityDeferred,
    ControlMessageMissing,
    EventMessageMissing,
    ProtocolAuthorityAmbiguous,
    Custom(String),
}
