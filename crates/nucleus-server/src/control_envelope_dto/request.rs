//! Serializable control request envelope DTOs.

use serde::{Deserialize, Serialize};

use crate::commands::ServerCommand;
use crate::control_api::{
    ServerControlRequest, ServerControlRequestKind, ServerQuery, ServerQueryKind,
};
use crate::ids::{ClientId, ServerControlRequestId, ServerQueryId};

use super::protocol::{protocol_family, protocol_version, validate_protocol};
use super::{ControlApiCodecError, ControlCommandDto, ControlQueryDto};

/// Serializable request envelope for the first control API wire format.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
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
            protocol_family: protocol_family(),
            protocol_version: protocol_version(),
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
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
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
