//! Response envelope and status DTOs.

use serde::{Deserialize, Serialize};

use crate::control_api::{ServerControlResponse, ServerControlResponseStatus};
use crate::control_serialization_readiness::{
    CONTROL_API_PROTOCOL_FAMILY, CONTROL_API_PROTOCOL_VERSION_V1,
};

use super::body::ControlResponseBodyDto;
use crate::control_envelope_dto::ControlApiCodecError;

/// Serializable response envelope for the first control API wire format.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlResponseEnvelopeDto {
    pub protocol_family: String,
    pub protocol_version: u16,
    pub request_id: String,
    pub status: ControlResponseStatusDto,
    pub body: ControlResponseBodyDto,
}

impl TryFrom<&ServerControlResponse> for ControlResponseEnvelopeDto {
    type Error = ControlApiCodecError;

    fn try_from(response: &ServerControlResponse) -> Result<Self, Self::Error> {
        Ok(Self {
            protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
            protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
            request_id: response.request_id.0.clone(),
            status: ControlResponseStatusDto::from(&response.status),
            body: ControlResponseBodyDto::try_from(&response.body)?,
        })
    }
}

/// Serializable response status DTO.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ControlResponseStatusDto {
    Accepted,
    Complete,
    Rejected,
    Partial,
}

impl From<&ServerControlResponseStatus> for ControlResponseStatusDto {
    fn from(status: &ServerControlResponseStatus) -> Self {
        match status {
            ServerControlResponseStatus::Accepted => Self::Accepted,
            ServerControlResponseStatus::Complete => Self::Complete,
            ServerControlResponseStatus::Rejected => Self::Rejected,
            ServerControlResponseStatus::Partial => Self::Partial,
        }
    }
}
