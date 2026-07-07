use crate::control_api::{
    AcceptedMemoryActiveApplyDiagnosticsQuery, AcceptedMemoryImportApplyReviewDiagnosticsQuery,
    AcceptedMemoryProjectionDiagnosticsQuery, AcceptedMemoryProjectionImportApplyDiagnosticsQuery,
    AcceptedMemoryProjectionImportDiagnosticsQuery, AcceptedMemoryProjectionWriteDiagnosticsQuery,
    AcceptedMemoryQuery, AcceptedMemoryReviewReadinessQuery,
    AcceptedMemoryReviewReceiptStorageDiagnosticsQuery, MemoryProposalReviewDiagnosticsQuery,
    MemoryProposalsQuery, PlanningCapturePublicationDiagnosticsQuery,
    PlanningProjectionFileWriteDiagnosticsQuery,
    PlanningProjectionImportActiveApplyDiagnosticsQuery,
    PlanningProjectionImportApplyDiagnosticsQuery, PlanningProjectionImportDiagnosticsQuery,
    PlanningSessionsQuery, PlanningTaskSeedsQuery, ProductWorkflowSummaryQuery,
    ProjectAuthorityMapQuery, ProviderLiveReadExecutorQuery, ProviderLiveReadSmokeEvidenceQuery,
    ProviderReadIntentQuery, ProviderReadinessOverviewQuery, ResearchRunBriefsQuery,
    SelectedTaskActionReadinessQuery, SelectedTaskCommandAdmissionQuery,
    SelectedTaskOperatorActionGateQuery, SelectedTaskReviewDecisionAdmissionQuery,
    SelectedTaskReviewDecisionApplyQuery, SelectedTaskReviewNextQuery,
    SelectedTaskReviewOutcomeRouteQuery, SelectedTaskScmHandoffQuery, ServerQuery, ServerQueryKind,
    StateRecordQuery, TaskReadinessQuery, TaskSeedPromotionDiagnosticsQuery, TaskTimelineQuery,
    TaskWorkflowDrilldownQuery,
};
use crate::ids::ServerQueryId;

use super::authority_domains::authority_domain_dto;
use super::task_workflow::{
    selected_task_action_family_label, selected_task_review_decision_action_label,
};
use super::{ControlQueryDto, ControlQueryScopeDto, ControlStateDomainDto};
use crate::control_envelope_dto::protocol::{diagnostics_domain_dto, runtime_metadata_action};
use crate::control_envelope_dto::ControlApiCodecError;

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
            ServerQueryKind::AcceptedMemoryProjectionDiagnostics(
                AcceptedMemoryProjectionDiagnosticsQuery { project_id },
            ) => Ok(Self::AcceptedMemoryProjectionDiagnostics {
                query_id: query.id.0.clone(),
                action: "diagnostics".to_owned(),
                project_id: project_id.0.clone(),
            }),
            ServerQueryKind::AcceptedMemoryProjectionWriteDiagnostics(
                AcceptedMemoryProjectionWriteDiagnosticsQuery { project_id },
            ) => Ok(Self::AcceptedMemoryProjectionWriteDiagnostics {
                query_id: query.id.0.clone(),
                action: "diagnostics".to_owned(),
                project_id: project_id.0.clone(),
            }),
            ServerQueryKind::AcceptedMemoryProjectionImportDiagnostics(
                AcceptedMemoryProjectionImportDiagnosticsQuery { project_id },
            ) => Ok(Self::AcceptedMemoryProjectionImportDiagnostics {
                query_id: query.id.0.clone(),
                action: "diagnostics".to_owned(),
                project_id: project_id.0.clone(),
            }),
            ServerQueryKind::AcceptedMemoryProjectionImportApplyDiagnostics(
                AcceptedMemoryProjectionImportApplyDiagnosticsQuery { project_id },
            ) => Ok(Self::AcceptedMemoryProjectionImportApplyDiagnostics {
                query_id: query.id.0.clone(),
                action: "diagnostics".to_owned(),
                project_id: project_id.0.clone(),
            }),
            ServerQueryKind::AcceptedMemoryImportApplyReviewDiagnostics(
                AcceptedMemoryImportApplyReviewDiagnosticsQuery { project_id },
            ) => Ok(Self::AcceptedMemoryImportApplyReviewDiagnostics {
                query_id: query.id.0.clone(),
                action: "diagnostics".to_owned(),
                project_id: project_id.0.clone(),
            }),
            ServerQueryKind::AcceptedMemoryReviewReceiptStorageDiagnostics(
                AcceptedMemoryReviewReceiptStorageDiagnosticsQuery { project_id },
            ) => Ok(Self::AcceptedMemoryReviewReceiptStorageDiagnostics {
                query_id: query.id.0.clone(),
                action: "diagnostics".to_owned(),
                project_id: project_id.0.clone(),
            }),
            ServerQueryKind::AcceptedMemoryActiveApplyDiagnostics(
                AcceptedMemoryActiveApplyDiagnosticsQuery { project_id },
            ) => Ok(Self::AcceptedMemoryActiveApplyDiagnostics {
                query_id: query.id.0.clone(),
                action: "diagnostics".to_owned(),
                project_id: project_id.0.clone(),
            }),
            ServerQueryKind::AcceptedMemoryReviewReadiness(
                AcceptedMemoryReviewReadinessQuery { project_id },
            ) => Ok(Self::AcceptedMemoryReviewReadiness {
                query_id: query.id.0.clone(),
                action: "diagnostics".to_owned(),
                project_id: project_id.0.clone(),
            }),
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
            ServerQueryKind::ProductWorkflowSummary(ProductWorkflowSummaryQuery { project_id }) => {
                Ok(Self::ProductWorkflowSummary {
                    query_id: query.id.0.clone(),
                    action: "summary".to_owned(),
                    project_id: project_id.0.clone(),
                })
            }
            ServerQueryKind::TaskWorkflowDrilldown(TaskWorkflowDrilldownQuery {
                project_id,
                task_id,
            }) => Ok(Self::TaskWorkflowDrilldown {
                query_id: query.id.0.clone(),
                action: "drilldown".to_owned(),
                project_id: project_id.0.clone(),
                task_id: task_id.0.clone(),
            }),
            ServerQueryKind::SelectedTaskActionReadiness(SelectedTaskActionReadinessQuery {
                project_id,
                task_id,
            }) => Ok(Self::SelectedTaskActionReadiness {
                query_id: query.id.0.clone(),
                action: "readiness".to_owned(),
                project_id: project_id.0.clone(),
                task_id: task_id.0.clone(),
            }),
            ServerQueryKind::SelectedTaskOperatorActionGate(
                SelectedTaskOperatorActionGateQuery {
                    project_id,
                    task_id,
                },
            ) => Ok(Self::SelectedTaskOperatorActionGate {
                query_id: query.id.0.clone(),
                action: "gate".to_owned(),
                project_id: project_id.0.clone(),
                task_id: task_id.0.clone(),
            }),
            ServerQueryKind::SelectedTaskReviewNext(SelectedTaskReviewNextQuery {
                project_id,
                task_id,
            }) => Ok(Self::SelectedTaskReviewNext {
                query_id: query.id.0.clone(),
                action: "review_next".to_owned(),
                project_id: project_id.0.clone(),
                task_id: task_id.0.clone(),
            }),
            ServerQueryKind::SelectedTaskReviewOutcomeRoute(
                SelectedTaskReviewOutcomeRouteQuery {
                    project_id,
                    task_id,
                },
            ) => Ok(Self::SelectedTaskReviewOutcomeRoute {
                query_id: query.id.0.clone(),
                action: "route".to_owned(),
                project_id: project_id.0.clone(),
                task_id: task_id.0.clone(),
            }),
            ServerQueryKind::SelectedTaskScmHandoff(SelectedTaskScmHandoffQuery {
                project_id,
                task_id,
            }) => Ok(Self::SelectedTaskScmHandoff {
                query_id: query.id.0.clone(),
                action: "handoff".to_owned(),
                project_id: project_id.0.clone(),
                task_id: task_id.0.clone(),
            }),
            ServerQueryKind::SelectedTaskCommandAdmission(SelectedTaskCommandAdmissionQuery {
                project_id,
                task_id,
                family,
                expected_revision,
                reason,
                operator_ref,
            }) => Ok(Self::SelectedTaskCommandAdmission {
                query_id: query.id.0.clone(),
                action: "dry_run".to_owned(),
                project_id: project_id.0.clone(),
                task_id: task_id.0.clone(),
                family: selected_task_action_family_label(*family).to_owned(),
                expected_revision: expected_revision
                    .as_ref()
                    .map(|revision| revision.0.clone()),
                reason: reason.clone(),
                operator_ref: operator_ref.clone(),
            }),
            ServerQueryKind::SelectedTaskReviewDecisionAdmission(
                SelectedTaskReviewDecisionAdmissionQuery {
                    project_id,
                    task_id,
                    action,
                    expected_revision,
                    current_revision,
                    reason,
                    operator_ref,
                    reviewed_evidence_refs,
                    idempotency_key,
                },
            ) => Ok(Self::SelectedTaskReviewDecisionAdmission {
                query_id: query.id.0.clone(),
                action: "dry_run".to_owned(),
                project_id: project_id.0.clone(),
                task_id: task_id.0.clone(),
                decision_action: selected_task_review_decision_action_label(*action).to_owned(),
                expected_revision: expected_revision
                    .as_ref()
                    .map(|revision| revision.0.clone()),
                current_revision: current_revision.as_ref().map(|revision| revision.0.clone()),
                reason: reason.clone(),
                operator_ref: operator_ref.clone(),
                reviewed_evidence_refs: reviewed_evidence_refs.clone(),
                idempotency_key: idempotency_key.clone(),
            }),
            ServerQueryKind::SelectedTaskReviewDecisionApply(
                SelectedTaskReviewDecisionApplyQuery {
                    project_id,
                    task_id,
                    action,
                    expected_revision,
                    current_revision,
                    reason,
                    operator_ref,
                    reviewed_evidence_refs,
                    idempotency_key,
                },
            ) => Ok(Self::SelectedTaskReviewDecisionApply {
                query_id: query.id.0.clone(),
                action: "apply".to_owned(),
                project_id: project_id.0.clone(),
                task_id: task_id.0.clone(),
                decision_action: selected_task_review_decision_action_label(*action).to_owned(),
                expected_revision: expected_revision
                    .as_ref()
                    .map(|revision| revision.0.clone()),
                current_revision: current_revision.as_ref().map(|revision| revision.0.clone()),
                reason: reason.clone(),
                operator_ref: operator_ref.clone(),
                reviewed_evidence_refs: reviewed_evidence_refs.clone(),
                idempotency_key: idempotency_key.clone(),
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
