//! Control API serialization envelope readiness.
//!
//! These types name the request/response envelope fields and blockers needed
//! before an app transport can serialize control API values. They do not add
//! serde derives or implement transport behavior.

use serde::{Deserialize, Serialize};

/// First supported control API protocol family.
pub const CONTROL_API_PROTOCOL_FAMILY: &str = "nucleus.control";

/// First supported control API protocol version.
pub const CONTROL_API_PROTOCOL_VERSION_V1: u16 = 1;

/// Serialization-readiness plan for control API envelopes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ControlApiSerializationReadinessPlan {
    pub request_envelope: ControlApiEnvelopeShape,
    pub response_envelope: ControlApiEnvelopeShape,
    pub wire_format: ControlApiWireFormat,
    pub codec_boundary: ControlApiCodecBoundary,
    pub version_policy: ControlApiProtocolVersionPolicy,
}

impl ControlApiSerializationReadinessPlan {
    /// First envelope plan needed by Tauri IPC.
    pub fn first_tauri_ipc_plan() -> Self {
        Self {
            request_envelope: ControlApiEnvelopeShape {
                fields: vec![
                    ControlApiEnvelopeField::ProtocolVersion,
                    ControlApiEnvelopeField::RequestId,
                    ControlApiEnvelopeField::ClientId,
                    ControlApiEnvelopeField::RequestKind,
                ],
            },
            response_envelope: ControlApiEnvelopeShape {
                fields: vec![
                    ControlApiEnvelopeField::ProtocolVersion,
                    ControlApiEnvelopeField::RequestId,
                    ControlApiEnvelopeField::ResponseStatus,
                    ControlApiEnvelopeField::ResponseBody,
                    ControlApiEnvelopeField::ErrorShape,
                ],
            },
            wire_format: ControlApiWireFormat::Json,
            codec_boundary: ControlApiCodecBoundary::desktop_ipc_json(),
            version_policy: ControlApiProtocolVersionPolicy::v1_only(),
        }
    }

    /// Assess envelope serialization readiness without implementing it.
    pub fn assess(
        &self,
        stable_identity_defined: bool,
        versioning_defined: bool,
        error_shape_defined: bool,
        payload_compatibility_defined: bool,
        codec_defined: bool,
    ) -> ControlApiSerializationReadiness {
        let mut blockers = Vec::new();

        if !self
            .request_envelope
            .fields
            .contains(&ControlApiEnvelopeField::RequestId)
            || !self
                .response_envelope
                .fields
                .contains(&ControlApiEnvelopeField::RequestId)
        {
            blockers.push(ControlApiSerializationReadinessBlocker::RequestIdMissing);
        }
        if !self
            .request_envelope
            .fields
            .contains(&ControlApiEnvelopeField::ClientId)
        {
            blockers.push(ControlApiSerializationReadinessBlocker::ClientIdMissing);
        }
        if !self
            .request_envelope
            .fields
            .contains(&ControlApiEnvelopeField::RequestKind)
        {
            blockers.push(ControlApiSerializationReadinessBlocker::RequestKindMissing);
        }
        if !self
            .response_envelope
            .fields
            .contains(&ControlApiEnvelopeField::ResponseStatus)
            || !self
                .response_envelope
                .fields
                .contains(&ControlApiEnvelopeField::ResponseBody)
        {
            blockers.push(ControlApiSerializationReadinessBlocker::ResponseShapeMissing);
        }
        if !stable_identity_defined {
            blockers.push(ControlApiSerializationReadinessBlocker::StableIdentityDeferred);
        }
        if !versioning_defined {
            blockers.push(ControlApiSerializationReadinessBlocker::VersioningDeferred);
        }
        if !error_shape_defined {
            blockers.push(ControlApiSerializationReadinessBlocker::ErrorShapeDeferred);
        }
        if !payload_compatibility_defined {
            blockers.push(ControlApiSerializationReadinessBlocker::PayloadCompatibilityDeferred);
        }
        if !codec_defined {
            blockers.push(ControlApiSerializationReadinessBlocker::CodecDeferred);
        }

        let status = if blockers.is_empty() {
            ControlApiSerializationReadinessStatus::Ready
        } else if blockers
            .iter()
            .any(ControlApiSerializationReadinessBlocker::is_deferred)
        {
            ControlApiSerializationReadinessStatus::Deferred
        } else {
            ControlApiSerializationReadinessStatus::Blocked
        };

        ControlApiSerializationReadiness { status, blockers }
    }
}

/// Wire format used by a control API transport boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlApiWireFormat {
    Json,
    MessagePack,
    Cbor,
    Custom(String),
}

/// Codec boundary for transport DTOs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ControlApiCodecBoundary {
    pub name: String,
    pub wire_format: ControlApiWireFormat,
    pub request_message_kind: ControlApiWireMessageKind,
    pub response_message_kind: ControlApiWireMessageKind,
    pub authority: ControlApiDtoAuthority,
    pub failures: Vec<ControlApiCodecFailure>,
}

impl ControlApiCodecBoundary {
    /// First codec boundary for desktop IPC.
    pub fn desktop_ipc_json() -> Self {
        Self {
            name: "desktop-ipc-json".to_owned(),
            wire_format: ControlApiWireFormat::Json,
            request_message_kind: ControlApiWireMessageKind::ControlRequest,
            response_message_kind: ControlApiWireMessageKind::ControlResponse,
            authority: ControlApiDtoAuthority::TransportBoundaryOnly,
            failures: vec![
                ControlApiCodecFailure::UnsupportedProtocolVersion,
                ControlApiCodecFailure::MalformedEnvelope,
                ControlApiCodecFailure::MissingRequiredField,
                ControlApiCodecFailure::UnknownMessageKind,
                ControlApiCodecFailure::UnsupportedPayloadShape,
            ],
        }
    }
}

/// Control API wire message kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlApiWireMessageKind {
    ControlRequest,
    ControlResponse,
    ControlError,
    Custom(String),
}

/// Authority boundary for transport DTOs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlApiDtoAuthority {
    TransportBoundaryOnly,
    ServerAuthority,
    Custom(String),
}

/// Codec failure vocabulary, distinct from server control errors.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ControlApiCodecFailure {
    UnsupportedProtocolVersion,
    MalformedEnvelope,
    MissingRequiredField,
    UnknownMessageKind,
    UnsupportedPayloadShape,
    IdentityMismatch,
    ServerErrorPayload,
    Custom(String),
}

/// Versioning policy for control API wire envelopes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ControlApiProtocolVersionPolicy {
    pub family: String,
    pub supported_versions: Vec<u16>,
    pub default_version: u16,
    pub compatibility: ControlApiVersionCompatibility,
}

impl ControlApiProtocolVersionPolicy {
    /// First policy: support only v1 until an upgrade contract exists.
    pub fn v1_only() -> Self {
        Self {
            family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
            supported_versions: vec![CONTROL_API_PROTOCOL_VERSION_V1],
            default_version: CONTROL_API_PROTOCOL_VERSION_V1,
            compatibility: ControlApiVersionCompatibility::ExactVersionOnly,
        }
    }

    /// Returns true when the version is supported by this policy.
    pub fn supports(&self, version: u16) -> bool {
        self.supported_versions.contains(&version)
    }
}

/// Version compatibility posture.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlApiVersionCompatibility {
    ExactVersionOnly,
    BackwardCompatibleWithinMajor,
    Custom(String),
}

/// Envelope field expected by an app transport.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlApiEnvelopeField {
    ProtocolVersion,
    RequestId,
    ClientId,
    RequestKind,
    ResponseStatus,
    ResponseBody,
    ErrorShape,
    Custom(String),
}

/// One control API envelope shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ControlApiEnvelopeShape {
    pub fields: Vec<ControlApiEnvelopeField>,
}

/// Control API serialization readiness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ControlApiSerializationReadiness {
    pub status: ControlApiSerializationReadinessStatus,
    pub blockers: Vec<ControlApiSerializationReadinessBlocker>,
}

/// Control API serialization readiness status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlApiSerializationReadinessStatus {
    Ready,
    Blocked,
    Deferred,
}

/// Reason control API serialization is not ready.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlApiSerializationReadinessBlocker {
    RequestIdMissing,
    ClientIdMissing,
    RequestKindMissing,
    ResponseShapeMissing,
    StableIdentityDeferred,
    VersioningDeferred,
    ErrorShapeDeferred,
    PayloadCompatibilityDeferred,
    CodecDeferred,
    WireFormatDeferred,
    DtoAuthorityAmbiguous,
    Custom(String),
}

impl ControlApiSerializationReadinessBlocker {
    fn is_deferred(&self) -> bool {
        matches!(
            self,
            Self::StableIdentityDeferred
                | Self::VersioningDeferred
                | Self::ErrorShapeDeferred
                | Self::PayloadCompatibilityDeferred
                | Self::CodecDeferred
                | Self::WireFormatDeferred
                | Self::DtoAuthorityAmbiguous
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_tauri_ipc_plan_names_request_and_response_envelope_fields() {
        let plan = ControlApiSerializationReadinessPlan::first_tauri_ipc_plan();

        assert!(plan
            .request_envelope
            .fields
            .contains(&ControlApiEnvelopeField::RequestId));
        assert!(plan
            .request_envelope
            .fields
            .contains(&ControlApiEnvelopeField::ClientId));
        assert!(plan
            .response_envelope
            .fields
            .contains(&ControlApiEnvelopeField::ResponseStatus));
        assert!(plan
            .response_envelope
            .fields
            .contains(&ControlApiEnvelopeField::ErrorShape));
        assert_eq!(plan.wire_format, ControlApiWireFormat::Json);
        assert_eq!(
            plan.codec_boundary.authority,
            ControlApiDtoAuthority::TransportBoundaryOnly
        );
    }

    #[test]
    fn serialization_readiness_is_deferred_until_codec_and_policy_are_defined() {
        let plan = ControlApiSerializationReadinessPlan::first_tauri_ipc_plan();

        let readiness = plan.assess(false, false, false, false, false);

        assert_eq!(
            readiness.status,
            ControlApiSerializationReadinessStatus::Deferred
        );
        assert!(readiness
            .blockers
            .contains(&ControlApiSerializationReadinessBlocker::CodecDeferred));
        assert!(readiness
            .blockers
            .contains(&ControlApiSerializationReadinessBlocker::VersioningDeferred));
    }

    #[test]
    fn serialization_readiness_can_be_ready_without_transport_implementation() {
        let plan = ControlApiSerializationReadinessPlan::first_tauri_ipc_plan();

        let readiness = plan.assess(true, true, true, true, true);

        assert_eq!(
            readiness.status,
            ControlApiSerializationReadinessStatus::Ready
        );
        assert!(readiness.blockers.is_empty());
    }

    #[test]
    fn first_version_policy_is_v1_exact_match_only() {
        let policy = ControlApiProtocolVersionPolicy::v1_only();

        assert_eq!(policy.family, CONTROL_API_PROTOCOL_FAMILY);
        assert_eq!(policy.default_version, CONTROL_API_PROTOCOL_VERSION_V1);
        assert!(policy.supports(CONTROL_API_PROTOCOL_VERSION_V1));
        assert!(!policy.supports(2));
        assert_eq!(
            policy.compatibility,
            ControlApiVersionCompatibility::ExactVersionOnly
        );
    }

    #[test]
    fn desktop_ipc_json_codec_boundary_keeps_dtos_transport_only() {
        let boundary = ControlApiCodecBoundary::desktop_ipc_json();

        assert_eq!(boundary.wire_format, ControlApiWireFormat::Json);
        assert_eq!(
            boundary.request_message_kind,
            ControlApiWireMessageKind::ControlRequest
        );
        assert_eq!(
            boundary.response_message_kind,
            ControlApiWireMessageKind::ControlResponse
        );
        assert_eq!(
            boundary.authority,
            ControlApiDtoAuthority::TransportBoundaryOnly
        );
        assert!(boundary
            .failures
            .contains(&ControlApiCodecFailure::UnsupportedProtocolVersion));
        assert!(boundary
            .failures
            .contains(&ControlApiCodecFailure::UnsupportedPayloadShape));
    }
}
