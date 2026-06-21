//! Serializable control query DTOs.

use serde::{Deserialize, Serialize};

use crate::control_api::{ServerQuery, ServerQueryKind, StateRecordQuery, StateRecordQueryScope};
use crate::ids::ServerQueryId;
use crate::state::ServerStateDomain;
use nucleus_core::PersistenceRecordId;

use super::protocol::{
    diagnostics_domain_dto, diagnostics_query_from_domain, runtime_metadata_action,
    runtime_metadata_query_from_action,
};
use super::ControlApiCodecError;

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
    Diagnostics {
        query_id: String,
        domain: String,
    },
}

impl TryFrom<&ServerQuery> for ControlQueryDto {
    type Error = ControlApiCodecError;

    fn try_from(query: &ServerQuery) -> Result<Self, Self::Error> {
        match &query.kind {
            ServerQueryKind::Project(state_query)
            | ServerQueryKind::Task(state_query)
            | ServerQueryKind::Workspace(state_query) => state_query_dto(&query.id, state_query),
            ServerQueryKind::RuntimeMetadata(runtime_query) => Ok(Self::RuntimeMetadata {
                query_id: query.id.0.clone(),
                action: runtime_metadata_action(runtime_query)?.to_owned(),
            }),
            ServerQueryKind::Diagnostics(diagnostics_query) => Ok(Self::Diagnostics {
                query_id: query.id.0.clone(),
                domain: diagnostics_domain_dto(diagnostics_query),
            }),
            _ => Err(ControlApiCodecError::unsupported(
                "query shape is not supported by the first control envelope",
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
            ControlQueryDto::RuntimeMetadata { action, .. } => Ok(
                ServerQueryKind::RuntimeMetadata(runtime_metadata_query_from_action(&action)?),
            ),
            ControlQueryDto::Diagnostics { domain, .. } => Ok(ServerQueryKind::Diagnostics(
                diagnostics_query_from_domain(&domain)?,
            )),
        }
    }
}

impl ControlQueryDto {
    pub(super) fn query_id(&self) -> String {
        match self {
            Self::State { query_id, .. }
            | Self::RuntimeMetadata { query_id, .. }
            | Self::Diagnostics { query_id, .. } => query_id.clone(),
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
