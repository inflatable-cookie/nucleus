//! Serializable control API envelope DTOs.
//!
//! DTOs live at the transport boundary. They are not durable state authority and
//! do not replace server control API types.

use serde::{Deserialize, Serialize};

use crate::control_api::{
    RuntimeMetadataQuery, ServerCommandReceiptStatus, ServerControlError, ServerControlRequest,
    ServerControlRequestKind, ServerControlResponse, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQuery, ServerQueryKind, ServerQueryResult,
    ServerStateRecordSet, StateRecordQuery, StateRecordQueryScope,
};
use crate::control_serialization_readiness::{
    ControlApiCodecFailure, CONTROL_API_PROTOCOL_FAMILY, CONTROL_API_PROTOCOL_VERSION_V1,
};
use crate::ids::{ClientId, ServerControlRequestId, ServerQueryId};
use crate::state::ServerStateDomain;
use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::LocalStoreRecord;

/// Codec error at the control API transport boundary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlApiCodecError {
    pub failure: ControlApiCodecFailure,
    pub reason: String,
}

impl ControlApiCodecError {
    fn unsupported(reason: impl Into<String>) -> Self {
        Self {
            failure: ControlApiCodecFailure::UnsupportedPayloadShape,
            reason: reason.into(),
        }
    }

    fn malformed(reason: impl Into<String>) -> Self {
        Self {
            failure: ControlApiCodecFailure::MalformedEnvelope,
            reason: reason.into(),
        }
    }

    fn unsupported_version(version: u16) -> Self {
        Self {
            failure: ControlApiCodecFailure::UnsupportedProtocolVersion,
            reason: format!("unsupported protocol version: {version}"),
        }
    }
}

/// Serializable request envelope for the first control API wire format.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlRequestEnvelopeDto {
    pub protocol_family: String,
    pub protocol_version: u16,
    pub request_id: String,
    pub client_id: String,
    pub body: ControlRequestBodyDto,
}

impl TryFrom<&ServerControlRequest> for ControlRequestEnvelopeDto {
    type Error = ControlApiCodecError;

    fn try_from(request: &ServerControlRequest) -> Result<Self, Self::Error> {
        let body = ControlRequestBodyDto::try_from(&request.kind)?;

        Ok(Self {
            protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
            protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
            request_id: request.id.0.clone(),
            client_id: request.client_id.0.clone(),
            body,
        })
    }
}

impl TryFrom<ControlRequestEnvelopeDto> for ServerControlRequest {
    type Error = ControlApiCodecError;

    fn try_from(dto: ControlRequestEnvelopeDto) -> Result<Self, Self::Error> {
        validate_protocol(&dto.protocol_family, dto.protocol_version)?;
        let (query_id, kind) = <(ServerQueryId, ServerQueryKind)>::try_from(dto.body)?;
        let client_id = ClientId(dto.client_id.clone());

        Ok(Self {
            id: ServerControlRequestId(dto.request_id),
            client_id: client_id.clone(),
            kind: ServerControlRequestKind::Query(ServerQuery {
                id: query_id,
                client_id,
                kind,
            }),
        })
    }
}

/// Serializable request body.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlRequestBodyDto {
    Query { query: ControlQueryDto },
}

impl TryFrom<&ServerControlRequestKind> for ControlRequestBodyDto {
    type Error = ControlApiCodecError;

    fn try_from(kind: &ServerControlRequestKind) -> Result<Self, Self::Error> {
        match kind {
            ServerControlRequestKind::Query(query) => Ok(Self::Query {
                query: ControlQueryDto::try_from(query)?,
            }),
            ServerControlRequestKind::Command(_) => Err(ControlApiCodecError::unsupported(
                "command DTOs are not part of the first control envelope",
            )),
        }
    }
}

/// Serializable query DTO.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ControlQueryDto {
    State {
        query_id: String,
        domain: ControlStateDomainDto,
        scope: ControlQueryScopeDto,
    },
    RuntimeMetadata {
        query_id: String,
        action: String,
    },
}

impl TryFrom<&ServerQuery> for ControlQueryDto {
    type Error = ControlApiCodecError;

    fn try_from(query: &ServerQuery) -> Result<Self, Self::Error> {
        match &query.kind {
            ServerQueryKind::Project(state_query)
            | ServerQueryKind::Task(state_query)
            | ServerQueryKind::Workspace(state_query) => state_query_dto(&query.id, state_query),
            ServerQueryKind::RuntimeMetadata(RuntimeMetadataQuery::ListArtifactMetadata) => {
                Ok(Self::RuntimeMetadata {
                    query_id: query.id.0.clone(),
                    action: "list_artifact_metadata".to_owned(),
                })
            }
            ServerQueryKind::RuntimeMetadata(RuntimeMetadataQuery::ListCommandEvidence) => {
                Ok(Self::RuntimeMetadata {
                    query_id: query.id.0.clone(),
                    action: "list_command_evidence".to_owned(),
                })
            }
            _ => Err(ControlApiCodecError::unsupported(
                "query shape is not supported by the first control envelope",
            )),
        }
    }
}

impl TryFrom<ControlRequestBodyDto> for ServerQueryKind {
    type Error = ControlApiCodecError;

    fn try_from(body: ControlRequestBodyDto) -> Result<Self, Self::Error> {
        match body {
            ControlRequestBodyDto::Query { query } => ServerQueryKind::try_from(query),
        }
    }
}

impl TryFrom<ControlQueryDto> for ServerQueryKind {
    type Error = ControlApiCodecError;

    fn try_from(query: ControlQueryDto) -> Result<Self, Self::Error> {
        match query {
            ControlQueryDto::State {
                domain,
                scope,
                query_id: _,
            } => {
                let domain = ServerStateDomain::from(domain);
                let query = StateRecordQuery {
                    domain: domain.clone(),
                    scope: StateRecordQueryScope::try_from(scope)?,
                };
                Ok(match domain {
                    ServerStateDomain::Projects => ServerQueryKind::Project(query),
                    ServerStateDomain::Tasks => ServerQueryKind::Task(query),
                    ServerStateDomain::Workspaces => ServerQueryKind::Workspace(query),
                    _ => {
                        return Err(ControlApiCodecError::unsupported(
                            "state domain is not supported by the first control envelope",
                        ));
                    }
                })
            }
            ControlQueryDto::RuntimeMetadata { action, .. } => match action.as_str() {
                "list_artifact_metadata" => Ok(ServerQueryKind::RuntimeMetadata(
                    RuntimeMetadataQuery::ListArtifactMetadata,
                )),
                "list_command_evidence" => Ok(ServerQueryKind::RuntimeMetadata(
                    RuntimeMetadataQuery::ListCommandEvidence,
                )),
                _ => Err(ControlApiCodecError::unsupported(
                    "runtime metadata action is not supported",
                )),
            },
        }
    }
}

impl TryFrom<ControlRequestBodyDto> for (ServerQueryId, ServerQueryKind) {
    type Error = ControlApiCodecError;

    fn try_from(body: ControlRequestBodyDto) -> Result<Self, Self::Error> {
        match body {
            ControlRequestBodyDto::Query { query } => {
                let query_id = query.query_id();
                Ok((ServerQueryId(query_id), ServerQueryKind::try_from(query)?))
            }
        }
    }
}

impl ControlQueryDto {
    fn query_id(&self) -> String {
        match self {
            Self::State { query_id, .. } | Self::RuntimeMetadata { query_id, .. } => {
                query_id.clone()
            }
        }
    }
}

fn state_query_dto(
    query_id: &ServerQueryId,
    query: &StateRecordQuery,
) -> Result<ControlQueryDto, ControlApiCodecError> {
    Ok(ControlQueryDto::State {
        query_id: query_id.0.clone(),
        domain: ControlStateDomainDto::from(&query.domain),
        scope: ControlQueryScopeDto::try_from(&query.scope)?,
    })
}

/// Supported state domain DTOs for the first control envelope.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlStateDomainDto {
    Projects,
    Tasks,
    Workspaces,
}

impl From<&ServerStateDomain> for ControlStateDomainDto {
    fn from(domain: &ServerStateDomain) -> Self {
        match domain {
            ServerStateDomain::Projects => Self::Projects,
            ServerStateDomain::Tasks => Self::Tasks,
            ServerStateDomain::Workspaces => Self::Workspaces,
            _ => Self::Projects,
        }
    }
}

impl From<ControlStateDomainDto> for ServerStateDomain {
    fn from(domain: ControlStateDomainDto) -> Self {
        match domain {
            ControlStateDomainDto::Projects => Self::Projects,
            ControlStateDomainDto::Tasks => Self::Tasks,
            ControlStateDomainDto::Workspaces => Self::Workspaces,
        }
    }
}

/// Supported state query scopes for the first control envelope.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlQueryScopeDto {
    Get { id: String },
    List,
}

impl TryFrom<&StateRecordQueryScope> for ControlQueryScopeDto {
    type Error = ControlApiCodecError;

    fn try_from(scope: &StateRecordQueryScope) -> Result<Self, Self::Error> {
        match scope {
            StateRecordQueryScope::Get(id) => Ok(Self::Get { id: id.0.clone() }),
            StateRecordQueryScope::List => Ok(Self::List),
            _ => Err(ControlApiCodecError::unsupported(
                "indexed state scopes are not supported by the first control envelope",
            )),
        }
    }
}

impl TryFrom<ControlQueryScopeDto> for StateRecordQueryScope {
    type Error = ControlApiCodecError;

    fn try_from(scope: ControlQueryScopeDto) -> Result<Self, Self::Error> {
        Ok(match scope {
            ControlQueryScopeDto::Get { id } => StateRecordQueryScope::Get(PersistenceRecordId(id)),
            ControlQueryScopeDto::List => StateRecordQueryScope::List,
        })
    }
}

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
    Ok(ControlResponseBodyDto::StateRecords {
        domain: format!("{:?}", records.domain),
        records: records
            .records
            .iter()
            .map(ControlStateRecordDto::from)
            .collect(),
    })
}

/// Serializable state record DTO.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlStateRecordDto {
    pub id: String,
    pub domain: String,
    pub kind: String,
    pub revision_id: String,
    pub media_type: Option<String>,
    pub payload_bytes: Vec<u8>,
}

impl From<&LocalStoreRecord> for ControlStateRecordDto {
    fn from(record: &LocalStoreRecord) -> Self {
        Self {
            id: record.id.0.clone(),
            domain: persistence_domain_dto(&record.domain),
            kind: persistence_kind_dto(&record.kind),
            revision_id: record.revision_id.0.clone(),
            media_type: record.payload.media_type.clone(),
            payload_bytes: record.payload.bytes.clone(),
        }
    }
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

fn validate_protocol(family: &str, version: u16) -> Result<(), ControlApiCodecError> {
    if family != CONTROL_API_PROTOCOL_FAMILY {
        return Err(ControlApiCodecError::malformed(format!(
            "unsupported protocol family: {family}"
        )));
    }
    if version != CONTROL_API_PROTOCOL_VERSION_V1 {
        return Err(ControlApiCodecError::unsupported_version(version));
    }
    Ok(())
}

fn persistence_domain_dto(domain: &PersistenceDomain) -> String {
    format!("{domain:?}")
}

fn persistence_kind_dto(kind: &PersistenceRecordKind) -> String {
    format!("{kind:?}")
}

#[allow(dead_code)]
fn revision_id(value: String) -> RevisionId {
    RevisionId(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_api::{ServerControlResponse, StateRecordQuery, StateRecordQueryScope};
    use crate::ids::{ServerControlRequestId, ServerQueryId};
    use nucleus_core::{PersistenceRecordId, RevisionId};
    use nucleus_local_store::LocalStoreRecordPayload;

    #[test]
    fn request_envelope_dto_serializes_supported_state_query() {
        let request = ServerControlRequest {
            id: ServerControlRequestId("request:dto:1".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerControlRequestKind::Query(ServerQuery {
                id: ServerQueryId("query:dto:1".to_owned()),
                client_id: ClientId("client:desktop".to_owned()),
                kind: ServerQueryKind::Project(StateRecordQuery {
                    domain: ServerStateDomain::Projects,
                    scope: StateRecordQueryScope::List,
                }),
            }),
        };

        let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
        let json = serde_json::to_string(&dto).expect("json");
        let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
        let restored = ServerControlRequest::try_from(decoded).expect("restored request");

        assert_eq!(dto.protocol_family, CONTROL_API_PROTOCOL_FAMILY);
        assert_eq!(dto.protocol_version, CONTROL_API_PROTOCOL_VERSION_V1);
        assert_eq!(restored.id, request.id);
        assert!(matches!(
            restored.kind,
            ServerControlRequestKind::Query(ServerQuery {
                kind: ServerQueryKind::Project(StateRecordQuery {
                    scope: StateRecordQueryScope::List,
                    ..
                }),
                ..
            })
        ));
    }

    #[test]
    fn request_envelope_rejects_unsupported_command_payload() {
        let request = ServerControlRequest {
            id: ServerControlRequestId("request:dto:command".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerControlRequestKind::Command(crate::commands::ServerCommand {
                id: crate::ids::ServerCommandId("command:dto".to_owned()),
                client_id: ClientId("client:desktop".to_owned()),
                kind: crate::commands::ServerCommandKind::Task(
                    crate::commands::TaskCommand::Start(nucleus_tasks::TaskId(
                        "task:dto".to_owned(),
                    )),
                ),
            }),
        };

        let error = ControlRequestEnvelopeDto::try_from(&request).expect_err("unsupported");

        assert_eq!(
            error.failure,
            ControlApiCodecFailure::UnsupportedPayloadShape
        );
    }

    #[test]
    fn response_envelope_dto_serializes_status_error_and_state_records() {
        let response = ServerControlResponse {
            request_id: ServerControlRequestId("request:dto:response".to_owned()),
            status: ServerControlResponseStatus::Complete,
            body: ServerControlResponseBody::Query(ServerQueryResult::StateRecords(
                ServerStateRecordSet {
                    domain: ServerStateDomain::Projects,
                    records: vec![LocalStoreRecord {
                        id: PersistenceRecordId("project:dto".to_owned()),
                        domain: PersistenceDomain::Projects,
                        kind: PersistenceRecordKind::Project,
                        revision_id: RevisionId("rev:1".to_owned()),
                        payload: LocalStoreRecordPayload {
                            media_type: Some("application/json".to_owned()),
                            bytes: br#"{"name":"DTO"}"#.to_vec(),
                        },
                    }],
                },
            )),
        };

        let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
        let json = serde_json::to_string(&dto).expect("json");
        let decoded: ControlResponseEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");

        assert_eq!(decoded.status, ControlResponseStatusDto::Complete);
        assert!(matches!(
            decoded.body,
            ControlResponseBodyDto::StateRecords { records, .. } if records.len() == 1
        ));
    }

    #[test]
    fn response_error_shape_is_explicit() {
        let response = ServerControlResponse {
            request_id: ServerControlRequestId("request:dto:error".to_owned()),
            status: ServerControlResponseStatus::Rejected,
            body: ServerControlResponseBody::Error(ServerControlError::Deferred {
                reason: "not wired".to_owned(),
            }),
        };

        let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");

        assert_eq!(dto.status, ControlResponseStatusDto::Rejected);
        assert_eq!(
            dto.body,
            ControlResponseBodyDto::Error {
                kind: "deferred".to_owned(),
                reason: "not wired".to_owned(),
            }
        );
    }

    #[test]
    fn request_envelope_rejects_unsupported_version() {
        let dto = ControlRequestEnvelopeDto {
            protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
            protocol_version: 2,
            request_id: "request:dto:bad-version".to_owned(),
            client_id: "client:desktop".to_owned(),
            body: ControlRequestBodyDto::Query {
                query: ControlQueryDto::RuntimeMetadata {
                    query_id: "query:dto".to_owned(),
                    action: "list_artifact_metadata".to_owned(),
                },
            },
        };

        let error = ServerControlRequest::try_from(dto).expect_err("bad version");

        assert_eq!(
            error.failure,
            ControlApiCodecFailure::UnsupportedProtocolVersion
        );
    }
}
