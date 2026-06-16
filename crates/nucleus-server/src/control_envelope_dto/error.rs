use serde::{Deserialize, Serialize};

use crate::control_serialization_readiness::ControlApiCodecFailure;

/// Codec error at the control API transport boundary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlApiCodecError {
    pub failure: ControlApiCodecFailure,
    pub reason: String,
}

impl ControlApiCodecError {
    pub(crate) fn unsupported(reason: impl Into<String>) -> Self {
        Self {
            failure: ControlApiCodecFailure::UnsupportedPayloadShape,
            reason: reason.into(),
        }
    }

    pub(crate) fn malformed(reason: impl Into<String>) -> Self {
        Self {
            failure: ControlApiCodecFailure::MalformedEnvelope,
            reason: reason.into(),
        }
    }

    pub(crate) fn unsupported_version(version: u16) -> Self {
        Self {
            failure: ControlApiCodecFailure::UnsupportedProtocolVersion,
            reason: format!("unsupported protocol version: {version}"),
        }
    }
}
