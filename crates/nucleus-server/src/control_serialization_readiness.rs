//! Control API serialization envelope readiness.
//!
//! These types name the request/response envelope fields and blockers needed
//! before an app transport can serialize control API values. They do not add
//! serde derives, choose a wire format, or implement transport behavior.

/// Serialization-readiness plan for control API envelopes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ControlApiSerializationReadinessPlan {
    pub request_envelope: ControlApiEnvelopeShape,
    pub response_envelope: ControlApiEnvelopeShape,
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
}
