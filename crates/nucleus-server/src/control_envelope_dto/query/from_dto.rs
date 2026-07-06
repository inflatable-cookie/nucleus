use crate::control_api::{ServerQueryKind, StateRecordQuery, StateRecordQueryScope};
use crate::state::ServerStateDomain;

use super::planning_projection::{
    planning_capture_publication_diagnostics_query_from_action,
    planning_projection_file_write_diagnostics_query_from_action,
    planning_projection_import_active_apply_diagnostics_query_from_action,
    planning_projection_import_apply_diagnostics_query_from_action,
    planning_projection_import_diagnostics_query_from_action,
    product_workflow_summary_query_from_action,
};
use super::project_authority::project_authority_map_query_from_action;
use super::provider::{
    provider_live_read_executor_query_from_action,
    provider_live_read_smoke_evidence_query_from_action, provider_read_intent_query_from_action,
    provider_readiness_overview_query_from_action,
};
use super::task_workflow::{
    accepted_memory_active_apply_diagnostics_query_from_action,
    accepted_memory_import_apply_review_diagnostics_query_from_action,
    accepted_memory_projection_diagnostics_query_from_action,
    accepted_memory_projection_import_apply_diagnostics_query_from_action,
    accepted_memory_projection_import_diagnostics_query_from_action,
    accepted_memory_projection_write_diagnostics_query_from_action,
    accepted_memory_query_from_action, accepted_memory_review_readiness_query_from_action,
    accepted_memory_review_receipt_storage_diagnostics_query_from_action,
    memory_proposal_review_diagnostics_query_from_action, memory_proposals_query_from_action,
    planning_sessions_query_from_action, planning_task_seeds_query_from_action,
    research_run_briefs_query_from_action, task_readiness_query_from_action,
    task_seed_promotion_diagnostics_query_from_action, task_timeline_query_from_action,
};
use super::ControlQueryDto;
use crate::control_envelope_dto::protocol::{
    diagnostics_query_from_domain, runtime_metadata_query_from_action,
};
use crate::control_envelope_dto::ControlApiCodecError;

impl TryFrom<ControlQueryDto> for ServerQueryKind {
    type Error = ControlApiCodecError;

    fn try_from(query: ControlQueryDto) -> Result<Self, Self::Error> {
        match query {
            ControlQueryDto::State { domain, scope, .. } => state_query_from_dto(domain, scope),
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
            ControlQueryDto::PlanningSessions {
                action, project_id, ..
            } => planning_sessions_query_from_action(&action, project_id),
            ControlQueryDto::MemoryProposals {
                action, project_id, ..
            } => memory_proposals_query_from_action(&action, project_id),
            ControlQueryDto::AcceptedMemory {
                action, project_id, ..
            } => accepted_memory_query_from_action(&action, project_id),
            ControlQueryDto::AcceptedMemoryProjectionDiagnostics {
                action, project_id, ..
            } => accepted_memory_projection_diagnostics_query_from_action(&action, project_id),
            ControlQueryDto::AcceptedMemoryProjectionWriteDiagnostics {
                action,
                project_id,
                ..
            } => {
                accepted_memory_projection_write_diagnostics_query_from_action(&action, project_id)
            }
            ControlQueryDto::AcceptedMemoryProjectionImportDiagnostics {
                action,
                project_id,
                ..
            } => {
                accepted_memory_projection_import_diagnostics_query_from_action(&action, project_id)
            }
            ControlQueryDto::AcceptedMemoryProjectionImportApplyDiagnostics {
                action,
                project_id,
                ..
            } => accepted_memory_projection_import_apply_diagnostics_query_from_action(
                &action, project_id,
            ),
            ControlQueryDto::AcceptedMemoryImportApplyReviewDiagnostics {
                action,
                project_id,
                ..
            } => accepted_memory_import_apply_review_diagnostics_query_from_action(
                &action, project_id,
            ),
            ControlQueryDto::AcceptedMemoryReviewReceiptStorageDiagnostics {
                action,
                project_id,
                ..
            } => accepted_memory_review_receipt_storage_diagnostics_query_from_action(
                &action, project_id,
            ),
            ControlQueryDto::AcceptedMemoryActiveApplyDiagnostics {
                action, project_id, ..
            } => accepted_memory_active_apply_diagnostics_query_from_action(&action, project_id),
            ControlQueryDto::AcceptedMemoryReviewReadiness {
                action, project_id, ..
            } => accepted_memory_review_readiness_query_from_action(&action, project_id),
            ControlQueryDto::MemoryProposalReviewDiagnostics {
                action, project_id, ..
            } => memory_proposal_review_diagnostics_query_from_action(&action, project_id),
            ControlQueryDto::ResearchRunBriefs {
                action, project_id, ..
            } => research_run_briefs_query_from_action(&action, project_id),
            ControlQueryDto::TaskSeedPromotionDiagnostics {
                action, project_id, ..
            } => task_seed_promotion_diagnostics_query_from_action(&action, project_id),
            ControlQueryDto::PlanningProjectionFileWriteDiagnostics {
                action, project_id, ..
            } => planning_projection_file_write_diagnostics_query_from_action(&action, project_id),
            ControlQueryDto::PlanningProjectionImportDiagnostics {
                action, project_id, ..
            } => planning_projection_import_diagnostics_query_from_action(&action, project_id),
            ControlQueryDto::PlanningProjectionImportApplyDiagnostics {
                action,
                project_id,
                ..
            } => {
                planning_projection_import_apply_diagnostics_query_from_action(&action, project_id)
            }
            ControlQueryDto::PlanningProjectionImportActiveApplyDiagnostics {
                action,
                project_id,
                ..
            } => planning_projection_import_active_apply_diagnostics_query_from_action(
                &action, project_id,
            ),
            ControlQueryDto::PlanningCapturePublicationDiagnostics {
                action, project_id, ..
            } => planning_capture_publication_diagnostics_query_from_action(&action, project_id),
            ControlQueryDto::ProductWorkflowSummary {
                action, project_id, ..
            } => product_workflow_summary_query_from_action(&action, project_id),
            ControlQueryDto::ProjectAuthorityMap {
                action,
                project_id,
                expected_domains,
                ..
            } => project_authority_map_query_from_action(&action, project_id, expected_domains),
        }
    }
}

fn state_query_from_dto(
    domain: super::ControlStateDomainDto,
    scope: super::ControlQueryScopeDto,
) -> Result<ServerQueryKind, ControlApiCodecError> {
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
