//! Serializable control query DTOs.

use serde::{Deserialize, Serialize};

mod authority_domains;
mod from_dto;
mod id;
mod planning_projection;
mod project_authority;
mod provider;
mod state;
mod task_workflow;

use crate::control_api::{
    AcceptedMemoryQuery, MemoryProposalReviewDiagnosticsQuery, MemoryProposalsQuery,
    PlanningCapturePublicationDiagnosticsQuery, PlanningProjectionFileWriteDiagnosticsQuery,
    PlanningProjectionImportActiveApplyDiagnosticsQuery,
    PlanningProjectionImportApplyDiagnosticsQuery, PlanningProjectionImportDiagnosticsQuery,
    PlanningSessionsQuery, ResearchRunBriefsQuery,
};
use crate::control_api::{
    PlanningTaskSeedsQuery, ProjectAuthorityMapQuery, ProviderLiveReadExecutorQuery,
    ProviderLiveReadSmokeEvidenceQuery, ProviderReadIntentQuery, ProviderReadinessOverviewQuery,
    ServerQuery, ServerQueryKind, StateRecordQuery, TaskReadinessQuery,
    TaskSeedPromotionDiagnosticsQuery, TaskTimelineQuery,
};
use crate::ids::ServerQueryId;
use authority_domains::authority_domain_dto;
pub use state::{ControlQueryScopeDto, ControlStateDomainDto};

use super::protocol::{diagnostics_domain_dto, runtime_metadata_action};
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
    PlanningSessions {
        query_id: String,
        action: String,
        project_id: String,
    },
    MemoryProposals {
        query_id: String,
        action: String,
        project_id: String,
    },
    AcceptedMemory {
        query_id: String,
        action: String,
        project_id: String,
    },
    MemoryProposalReviewDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    ResearchRunBriefs {
        query_id: String,
        action: String,
        project_id: String,
    },
    TaskSeedPromotionDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    PlanningProjectionFileWriteDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    PlanningProjectionImportDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    PlanningProjectionImportApplyDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    PlanningProjectionImportActiveApplyDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    PlanningCapturePublicationDiagnostics {
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
            ServerQueryKind::PlanningSessions(PlanningSessionsQuery { project_id }) => {
                Ok(Self::PlanningSessions {
                    query_id: query.id.0.clone(),
                    action: "sessions".to_owned(),
                    project_id: project_id.0.clone(),
                })
            }
            ServerQueryKind::MemoryProposals(MemoryProposalsQuery { project_id }) => {
                Ok(Self::MemoryProposals {
                    query_id: query.id.0.clone(),
                    action: "diagnostics".to_owned(),
                    project_id: project_id.0.clone(),
                })
            }
            ServerQueryKind::AcceptedMemory(AcceptedMemoryQuery { project_id }) => {
                Ok(Self::AcceptedMemory {
                    query_id: query.id.0.clone(),
                    action: "memory".to_owned(),
                    project_id: project_id.0.clone(),
                })
            }
            ServerQueryKind::MemoryProposalReviewDiagnostics(
                MemoryProposalReviewDiagnosticsQuery { project_id },
            ) => Ok(Self::MemoryProposalReviewDiagnostics {
                query_id: query.id.0.clone(),
                action: "diagnostics".to_owned(),
                project_id: project_id.0.clone(),
            }),
            ServerQueryKind::ResearchRunBriefs(ResearchRunBriefsQuery { project_id }) => {
                Ok(Self::ResearchRunBriefs {
                    query_id: query.id.0.clone(),
                    action: "diagnostics".to_owned(),
                    project_id: project_id.0.clone(),
                })
            }
            ServerQueryKind::TaskSeedPromotionDiagnostics(TaskSeedPromotionDiagnosticsQuery {
                project_id,
            }) => Ok(Self::TaskSeedPromotionDiagnostics {
                query_id: query.id.0.clone(),
                action: "diagnostics".to_owned(),
                project_id: project_id.0.clone(),
            }),
            ServerQueryKind::PlanningProjectionFileWriteDiagnostics(
                PlanningProjectionFileWriteDiagnosticsQuery { project_id },
            ) => Ok(Self::PlanningProjectionFileWriteDiagnostics {
                query_id: query.id.0.clone(),
                action: "diagnostics".to_owned(),
                project_id: project_id.0.clone(),
            }),
            ServerQueryKind::PlanningProjectionImportDiagnostics(
                PlanningProjectionImportDiagnosticsQuery { project_id },
            ) => Ok(Self::PlanningProjectionImportDiagnostics {
                query_id: query.id.0.clone(),
                action: "diagnostics".to_owned(),
                project_id: project_id.0.clone(),
            }),
            ServerQueryKind::PlanningProjectionImportApplyDiagnostics(
                PlanningProjectionImportApplyDiagnosticsQuery { project_id },
            ) => Ok(Self::PlanningProjectionImportApplyDiagnostics {
                query_id: query.id.0.clone(),
                action: "diagnostics".to_owned(),
                project_id: project_id.0.clone(),
            }),
            ServerQueryKind::PlanningProjectionImportActiveApplyDiagnostics(
                PlanningProjectionImportActiveApplyDiagnosticsQuery { project_id },
            ) => Ok(Self::PlanningProjectionImportActiveApplyDiagnostics {
                query_id: query.id.0.clone(),
                action: "diagnostics".to_owned(),
                project_id: project_id.0.clone(),
            }),
            ServerQueryKind::PlanningCapturePublicationDiagnostics(
                PlanningCapturePublicationDiagnosticsQuery { project_id },
            ) => Ok(Self::PlanningCapturePublicationDiagnostics {
                query_id: query.id.0.clone(),
                action: "diagnostics".to_owned(),
                project_id: project_id.0.clone(),
            }),
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
