use serde::{Deserialize, Serialize};

use crate::control_api::{
    ServerCommandReceiptStatus, ServerControlError, ServerControlResponse,
    ServerControlResponseBody, ServerControlResponseStatus, ServerQueryResult,
    ServerStateRecordSet,
};
use crate::control_serialization_readiness::{
    CONTROL_API_PROTOCOL_FAMILY, CONTROL_API_PROTOCOL_VERSION_V1,
};
use crate::state::ServerStateDomain;

use super::{
    ControlApiCodecError, ControlProjectRecordDto, ControlStateRecordDto, ControlTaskRecordDto,
};

/// Serializable response envelope for the first control API wire format.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
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
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
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

/// Serializable response body DTO.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlResponseBodyDto {
    QueryEmpty,
    QueryUnsupported {
        reason: String,
    },
    StateRecords {
        domain: String,
        records: Vec<ControlStateRecordDto>,
    },
    ProjectRecords {
        records: Vec<ControlProjectRecordDto>,
    },
    TaskRecords {
        records: Vec<ControlTaskRecordDto>,
    },
    CommandReceipt {
        command_id: String,
        status: String,
    },
    Error {
        kind: String,
        reason: String,
    },
}

impl TryFrom<&ServerControlResponseBody> for ControlResponseBodyDto {
    type Error = ControlApiCodecError;

    fn try_from(
        body: &ServerControlResponseBody,
    ) -> Result<Self, <ControlResponseBodyDto as TryFrom<&ServerControlResponseBody>>::Error> {
        match body {
            ServerControlResponseBody::Query(ServerQueryResult::Empty) => Ok(Self::QueryEmpty),
            ServerControlResponseBody::Query(ServerQueryResult::Unsupported { reason }) => {
                Ok(Self::QueryUnsupported {
                    reason: reason.clone(),
                })
            }
            ServerControlResponseBody::Query(ServerQueryResult::StateRecords(records))
            | ServerControlResponseBody::Query(ServerQueryResult::AdapterSessions(records))
            | ServerControlResponseBody::Query(ServerQueryResult::ModelRoutes(records))
            | ServerControlResponseBody::Query(ServerQueryResult::RuntimeMetadata(records)) => {
                state_record_set_dto(records)
            }
            ServerControlResponseBody::Command(receipt) => Ok(Self::CommandReceipt {
                command_id: receipt.command_id.0.clone(),
                status: command_receipt_status_dto(&receipt.status),
            }),
            ServerControlResponseBody::Error(error) => {
                let (kind, reason) = control_error_dto(error);
                Ok(Self::Error { kind, reason })
            }
        }
    }
}

fn state_record_set_dto(
    records: &ServerStateRecordSet,
) -> Result<ControlResponseBodyDto, ControlApiCodecError> {
    if records.domain == ServerStateDomain::Projects {
        return Ok(ControlResponseBodyDto::ProjectRecords {
            records: records
                .records
                .iter()
                .map(ControlProjectRecordDto::try_from)
                .collect::<Result<Vec<_>, _>>()?,
        });
    }

    if records.domain == ServerStateDomain::Tasks {
        return Ok(ControlResponseBodyDto::TaskRecords {
            records: records
                .records
                .iter()
                .map(ControlTaskRecordDto::try_from)
                .collect::<Result<Vec<_>, _>>()?,
        });
    }

    Ok(ControlResponseBodyDto::StateRecords {
        domain: format!("{:?}", records.domain),
        records: records
            .records
            .iter()
            .map(ControlStateRecordDto::from)
            .collect(),
    })
}

fn control_error_dto(error: &ServerControlError) -> (String, String) {
    match error {
        ServerControlError::Unauthorized { reason } => ("unauthorized".to_owned(), reason.clone()),
        ServerControlError::Unsupported { reason } => ("unsupported".to_owned(), reason.clone()),
        ServerControlError::InvalidRequest { reason } => {
            ("invalid_request".to_owned(), reason.clone())
        }
        ServerControlError::NotFound { reason } => ("not_found".to_owned(), reason.clone()),
        ServerControlError::Conflict { reason } => ("conflict".to_owned(), reason.clone()),
        ServerControlError::StorageUnavailable { reason } => {
            ("storage_unavailable".to_owned(), reason.clone())
        }
        ServerControlError::RuntimeUnavailable { reason } => {
            ("runtime_unavailable".to_owned(), reason.clone())
        }
        ServerControlError::Deferred { reason } => ("deferred".to_owned(), reason.clone()),
    }
}

fn command_receipt_status_dto(status: &ServerCommandReceiptStatus) -> String {
    match status {
        ServerCommandReceiptStatus::AcceptedForStateMutation => {
            "accepted_for_state_mutation".to_owned()
        }
        ServerCommandReceiptStatus::AcceptedForRuntimeScheduling => {
            "accepted_for_runtime_scheduling".to_owned()
        }
        ServerCommandReceiptStatus::Rejected(_) => "rejected".to_owned(),
    }
}
