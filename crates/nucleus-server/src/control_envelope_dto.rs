//! Serializable control API envelope DTOs.
//!
//! DTOs live at the transport boundary. They are not durable state authority and
//! do not replace server control API types.

use serde::{Deserialize, Serialize};

use crate::commands::ServerCommand;
use crate::control_api::{
    RuntimeMetadataQuery, ServerControlRequest, ServerControlRequestKind, ServerQuery,
    ServerQueryKind, StateRecordQuery, StateRecordQueryScope,
};
use crate::control_serialization_readiness::{
    CONTROL_API_PROTOCOL_FAMILY, CONTROL_API_PROTOCOL_VERSION_V1,
};
use crate::ids::{ClientId, ServerControlRequestId, ServerQueryId};
use crate::state::ServerStateDomain;
use nucleus_core::PersistenceRecordId;

mod commands;
mod error;
mod projects;
mod records;
mod response;
mod tasks;

pub use commands::ControlCommandDto;
pub use error::ControlApiCodecError;
pub use projects::ControlProjectRecordDto;
pub use records::ControlStateRecordDto;
pub use response::{
    ControlCommandEvidenceRecordDto, ControlResponseBodyDto, ControlResponseEnvelopeDto,
    ControlResponseStatusDto,
};
pub use tasks::ControlTaskRecordDto;

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
        let client_id = ClientId(dto.client_id.clone());
        let kind = server_request_kind_from_body(dto.body, client_id.clone())?;

        Ok(Self {
            id: ServerControlRequestId(dto.request_id),
            client_id,
            kind,
        })
    }
}

/// Serializable request body.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlRequestBodyDto {
    Query { query: ControlQueryDto },
    Command { command: ControlCommandDto },
}

impl TryFrom<&ServerControlRequestKind> for ControlRequestBodyDto {
    type Error = ControlApiCodecError;

    fn try_from(kind: &ServerControlRequestKind) -> Result<Self, Self::Error> {
        match kind {
            ServerControlRequestKind::Query(query) => Ok(Self::Query {
                query: ControlQueryDto::try_from(query)?,
            }),
            ServerControlRequestKind::Command(command) => Ok(Self::Command {
                command: ControlCommandDto::try_from(command)?,
            }),
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
            ControlRequestBodyDto::Command { .. } => Err(ControlApiCodecError::unsupported(
                "command body cannot be decoded as a query",
            )),
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
            ControlRequestBodyDto::Command { .. } => Err(ControlApiCodecError::unsupported(
                "command body cannot be decoded as a query",
            )),
        }
    }
}

fn server_request_kind_from_body(
    body: ControlRequestBodyDto,
    client_id: ClientId,
) -> Result<ServerControlRequestKind, ControlApiCodecError> {
    match body {
        ControlRequestBodyDto::Query { query } => {
            let query_id = ServerQueryId(query.query_id());
            Ok(ServerControlRequestKind::Query(ServerQuery {
                id: query_id,
                client_id,
                kind: ServerQueryKind::try_from(query)?,
            }))
        }
        ControlRequestBodyDto::Command { command } => {
            let (command_id, kind) = command.try_into_server_kind()?;
            Ok(ServerControlRequestKind::Command(ServerCommand {
                id: command_id,
                client_id,
                kind,
            }))
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

#[cfg(test)]
mod tests;
