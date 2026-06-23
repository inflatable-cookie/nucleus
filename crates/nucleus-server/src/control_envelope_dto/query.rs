//! Serializable control query DTOs.

use serde::{Deserialize, Serialize};

mod authority_domains;
mod task_workflow;

use crate::control_api::{
    PlanningTaskSeedsQuery, ProjectAuthorityMapQuery, ProviderLiveReadExecutorQuery,
    ProviderLiveReadSmokeEvidenceQuery, ProviderReadIntentQuery, ProviderReadinessOverviewQuery,
    ServerQuery, ServerQueryKind, StateRecordQuery, StateRecordQueryScope, TaskReadinessQuery,
    TaskTimelineQuery,
};
use crate::ids::ServerQueryId;
use crate::state::ServerStateDomain;
use authority_domains::{authority_domain_dto, authority_domain_from_dto};
use nucleus_core::PersistenceRecordId;
use nucleus_projects::ProjectId;
use task_workflow::{
    planning_task_seeds_query_from_action, task_readiness_query_from_action,
    task_timeline_query_from_action,
};

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
    ProviderReadIntent {
        query_id: String,
        action: String,
    },
    ProviderReadinessOverview {
        query_id: String,
        action: String,
    },
    ProviderLiveReadExecutor {
        query_id: String,
        action: String,
    },
    ProviderLiveReadSmokeEvidence {
        query_id: String,
        action: String,
    },
    TaskTimeline {
        query_id: String,
        action: String,
        task_id: String,
    },
    TaskReadiness {
        query_id: String,
        action: String,
        project_id: String,
    },
    PlanningTaskSeeds {
        query_id: String,
        action: String,
        project_id: String,
    },
    ProjectAuthorityMap {
        query_id: String,
        action: String,
        project_id: String,
        expected_domains: Vec<String>,
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
            ServerQueryKind::ProviderReadIntent(ProviderReadIntentQuery::Projection) => {
                Ok(Self::ProviderReadIntent {
                    query_id: query.id.0.clone(),
                    action: "projection".to_owned(),
                })
            }
            ServerQueryKind::ProviderReadinessOverview(
                ProviderReadinessOverviewQuery::Overview,
            ) => Ok(Self::ProviderReadinessOverview {
                query_id: query.id.0.clone(),
                action: "overview".to_owned(),
            }),
            ServerQueryKind::ProviderLiveReadExecutor(
                ProviderLiveReadExecutorQuery::Diagnostics,
            ) => Ok(Self::ProviderLiveReadExecutor {
                query_id: query.id.0.clone(),
                action: "diagnostics".to_owned(),
            }),
            ServerQueryKind::ProviderLiveReadSmokeEvidence(
                ProviderLiveReadSmokeEvidenceQuery::Diagnostics,
            ) => Ok(Self::ProviderLiveReadSmokeEvidence {
                query_id: query.id.0.clone(),
                action: "diagnostics".to_owned(),
            }),
            ServerQueryKind::TaskTimeline(TaskTimelineQuery { task_id }) => {
                Ok(Self::TaskTimeline {
                    query_id: query.id.0.clone(),
                    action: "timeline".to_owned(),
                    task_id: task_id.0.clone(),
                })
            }
            ServerQueryKind::TaskReadiness(TaskReadinessQuery { project_id }) => {
                Ok(Self::TaskReadiness {
                    query_id: query.id.0.clone(),
                    action: "candidates".to_owned(),
                    project_id: project_id.0.clone(),
                })
            }
            ServerQueryKind::PlanningTaskSeeds(PlanningTaskSeedsQuery { project_id }) => {
                Ok(Self::PlanningTaskSeeds {
                    query_id: query.id.0.clone(),
                    action: "candidates".to_owned(),
                    project_id: project_id.0.clone(),
                })
            }
            ServerQueryKind::ProjectAuthorityMap(ProjectAuthorityMapQuery {
                project_id,
                expected_domains,
            }) => Ok(Self::ProjectAuthorityMap {
                query_id: query.id.0.clone(),
                action: "publication".to_owned(),
                project_id: project_id.0.clone(),
                expected_domains: expected_domains.iter().map(authority_domain_dto).collect(),
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
            ControlQueryDto::ProviderReadIntent { action, .. } => {
                provider_read_intent_query_from_action(&action)
            }
            ControlQueryDto::ProviderReadinessOverview { action, .. } => {
                provider_readiness_overview_query_from_action(&action)
            }
            ControlQueryDto::ProviderLiveReadExecutor { action, .. } => {
                provider_live_read_executor_query_from_action(&action)
            }
            ControlQueryDto::ProviderLiveReadSmokeEvidence { action, .. } => {
                provider_live_read_smoke_evidence_query_from_action(&action)
            }
            ControlQueryDto::TaskTimeline {
                action, task_id, ..
            } => task_timeline_query_from_action(&action, task_id),
            ControlQueryDto::TaskReadiness {
                action, project_id, ..
            } => task_readiness_query_from_action(&action, project_id),
            ControlQueryDto::PlanningTaskSeeds {
                action, project_id, ..
            } => planning_task_seeds_query_from_action(&action, project_id),
            ControlQueryDto::ProjectAuthorityMap {
                action,
                project_id,
                expected_domains,
                ..
            } => project_authority_map_query_from_action(&action, project_id, expected_domains),
        }
    }
}

impl ControlQueryDto {
    pub(super) fn query_id(&self) -> String {
        match self {
            Self::State { query_id, .. }
            | Self::RuntimeMetadata { query_id, .. }
            | Self::Diagnostics { query_id, .. }
            | Self::ProviderReadIntent { query_id, .. }
            | Self::ProviderReadinessOverview { query_id, .. }
            | Self::ProviderLiveReadExecutor { query_id, .. }
            | Self::ProviderLiveReadSmokeEvidence { query_id, .. }
            | Self::TaskTimeline { query_id, .. }
            | Self::TaskReadiness { query_id, .. }
            | Self::PlanningTaskSeeds { query_id, .. }
            | Self::ProjectAuthorityMap { query_id, .. } => query_id.clone(),
        }
    }
}

fn provider_read_intent_query_from_action(
    action: &str,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "projection" => Ok(ServerQueryKind::ProviderReadIntent(
            ProviderReadIntentQuery::Projection,
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported provider read-intent query action: {action}"
        ))),
    }
}

fn provider_readiness_overview_query_from_action(
    action: &str,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "overview" => Ok(ServerQueryKind::ProviderReadinessOverview(
            ProviderReadinessOverviewQuery::Overview,
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported provider readiness overview query action: {action}"
        ))),
    }
}

fn provider_live_read_executor_query_from_action(
    action: &str,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" => Ok(ServerQueryKind::ProviderLiveReadExecutor(
            ProviderLiveReadExecutorQuery::Diagnostics,
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported provider live-read executor query action: {action}"
        ))),
    }
}

fn provider_live_read_smoke_evidence_query_from_action(
    action: &str,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" => Ok(ServerQueryKind::ProviderLiveReadSmokeEvidence(
            ProviderLiveReadSmokeEvidenceQuery::Diagnostics,
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported provider live-read smoke evidence query action: {action}"
        ))),
    }
}

fn project_authority_map_query_from_action(
    action: &str,
    project_id: String,
    expected_domains: Vec<String>,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "publication" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "project authority-map query requires a project id",
        )),
        "publication" => Ok(ServerQueryKind::ProjectAuthorityMap(
            ProjectAuthorityMapQuery {
                project_id: ProjectId(project_id),
                expected_domains: expected_domains
                    .into_iter()
                    .map(authority_domain_from_dto)
                    .collect::<Result<Vec<_>, _>>()?,
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported project authority-map query action: {action}"
        ))),
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
