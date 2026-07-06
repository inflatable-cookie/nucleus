use nucleus_local_store::{LocalStoreBackend, LocalStoreError};

use super::handler::LocalControlRequestHandler;
use crate::control_api::{
    DiagnosticsQuery, ServerControlError, ServerControlResponse, ServerControlResponseBody,
    ServerControlResponseStatus, ServerDiagnosticsQueryResult, ServerDiagnosticsSnapshot,
    ServerQuery, ServerQueryKind, ServerQueryResult,
};
use crate::diagnostics_read_models::{
    codex_callback_diagnostics, codex_callback_response_execution_diagnostics,
    codex_ingestion_diagnostics, codex_interruption_diagnostics,
    codex_interruption_execution_diagnostics, codex_live_executor_diagnostics,
    codex_live_spawn_smoke_diagnostics, codex_provider_diagnostics, codex_recovery_diagnostics,
    codex_recovery_execution_diagnostics, codex_subscription_diagnostics,
    codex_task_backed_live_execution_diagnostics, codex_transport_executor_diagnostics,
    codex_turn_start_diagnostics, durable_provider_executor_diagnostics, effigy_diagnostics,
    scm_session_diagnostics, steward_diagnostics, sync_diagnostics, task_agent_diagnostics,
};
use crate::ids::ServerControlRequestId;
use crate::state::{ServerStateDomain, ServerStateService};
use crate::{
    completion_scm_capture_control_dto,
    completion_scm_capture_diagnostics_from_persisted_admissions,
    completion_scm_capture_preparation_control_dto,
    completion_scm_capture_preparation_diagnostics_from_persisted_records,
    completion_scm_control_dto, completion_scm_read_model, git_dry_run_execution_control_dto,
    git_dry_run_execution_diagnostics_from_persisted_records, live_evidence_completion_control_dto,
    live_evidence_completion_read_model, live_evidence_task_state_history_from_persisted_controls,
    read_codex_live_executor_outcome_records, read_completion_scm_capture_admissions,
    read_completion_scm_capture_preparations, read_durable_provider_executor_command_records,
    read_git_dry_run_executions, read_live_evidence_task_completions,
    read_live_evidence_task_state_control_records, read_scm_capture_dry_run_execution_receipts,
    read_scm_capture_dry_run_plans, scm_capture_dry_run_control_dto,
    scm_capture_dry_run_diagnostics_from_persisted_records,
    scm_capture_dry_run_execution_control_dto,
    scm_capture_dry_run_execution_diagnostics_from_persisted_records,
    scm_capture_review_control_dto, scm_capture_review_decision_control_dto,
    scm_capture_review_decision_diagnostics, scm_capture_review_diagnostics,
    scm_capture_review_readiness, scm_capture_workflow_control_dto,
    scm_capture_workflow_diagnostics, scm_capture_workflow_projection,
    scm_change_request_prep_control_dto,
    scm_change_request_prep_diagnostics_from_persisted_records, CompletionScmReadModelInput,
    LiveEvidenceCompletionReadModelInput, ScmCaptureReviewReadinessInput,
    ScmCaptureWorkflowProjectionInput,
};

mod accepted_memory;
mod accepted_memory_active_apply_diagnostics;
mod accepted_memory_import_apply_review_diagnostics;
mod accepted_memory_projection_diagnostics;
mod accepted_memory_projection_import_apply_diagnostics;
mod accepted_memory_projection_import_diagnostics;
mod accepted_memory_projection_write_diagnostics;
mod accepted_memory_queries;
mod accepted_memory_review_readiness;
mod accepted_memory_review_receipt_storage_diagnostics;
mod authority_map;
mod diagnostics;
mod memory_proposal_review_diagnostics;
mod memory_proposals;
mod planning_capture_publication_diagnostics;
mod planning_projection_file_write_diagnostics;
mod planning_projection_import_active_apply_diagnostics;
mod planning_projection_import_apply_diagnostics;
mod planning_projection_import_diagnostics;
mod planning_sessions;
mod planning_task_seeds;
mod product_workflow_summary;
mod provider_live_read_executor;
mod provider_live_read_smoke_evidence;
mod provider_read_intent;
mod provider_readiness_overview;
mod research_run_briefs;
mod runtime_metadata;
mod selected_task_action_readiness;
mod selected_task_operator_action_gate;
mod state_records;
mod task_readiness;
mod task_seed_promotion_diagnostics;
mod task_timeline;
mod task_workflow_drilldown;

pub(super) use state_records::read_state_records;

pub(crate) fn handle_query<B>(
    handler: &LocalControlRequestHandler<B>,
    request_id: ServerControlRequestId,
    query: ServerQuery,
) -> ServerControlResponse
where
    B: LocalStoreBackend + Clone,
{
    match execute_query(handler, query) {
        Ok(result) => ServerControlResponse {
            request_id,
            status: ServerControlResponseStatus::Complete,
            body: ServerControlResponseBody::Query(result),
        },
        Err(error) => ServerControlResponse {
            request_id,
            status: ServerControlResponseStatus::Rejected,
            body: ServerControlResponseBody::Error(error),
        },
    }
}

fn execute_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: ServerQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    match query.kind {
        ServerQueryKind::Project(query) => {
            state_records::state_record_query(handler, query, ServerStateDomain::Projects)
                .map(ServerQueryResult::StateRecords)
        }
        ServerQueryKind::Task(query) => {
            state_records::state_record_query(handler, query, ServerStateDomain::Tasks)
                .map(ServerQueryResult::StateRecords)
        }
        ServerQueryKind::Workspace(query) => {
            state_records::state_record_query(handler, query, ServerStateDomain::Workspaces)
                .map(ServerQueryResult::StateRecords)
        }
        ServerQueryKind::AdapterSession(query) => {
            state_records::adapter_session_query(handler, query)
        }
        ServerQueryKind::ModelRoute(query) => state_records::model_route_query(handler, query),
        ServerQueryKind::RuntimeMetadata(query) => {
            runtime_metadata::runtime_metadata_query(handler, query)
        }
        ServerQueryKind::Diagnostics(query) => diagnostics::diagnostics_query(handler, query),
        ServerQueryKind::ProviderReadIntent(query) => {
            provider_read_intent::provider_read_intent_query(handler, query)
        }
        ServerQueryKind::ProviderReadinessOverview(query) => {
            provider_readiness_overview::provider_readiness_overview_query(handler, query)
        }
        ServerQueryKind::ProviderLiveReadExecutor(query) => {
            provider_live_read_executor::provider_live_read_executor_query(handler, query)
        }
        ServerQueryKind::ProviderLiveReadSmokeEvidence(query) => {
            provider_live_read_smoke_evidence::provider_live_read_smoke_evidence_query(
                handler, query,
            )
        }
        ServerQueryKind::TaskTimeline(query) => task_timeline::task_timeline_query(handler, query),
        ServerQueryKind::TaskReadiness(query) => {
            task_readiness::task_readiness_query(handler, query)
        }
        ServerQueryKind::PlanningTaskSeeds(query) => {
            planning_task_seeds::planning_task_seeds_query(handler, query)
        }
        ServerQueryKind::PlanningSessions(query) => {
            planning_sessions::planning_sessions_query(handler, query)
        }
        query @ (ServerQueryKind::AcceptedMemory(_)
        | ServerQueryKind::AcceptedMemoryProjectionDiagnostics(_)
        | ServerQueryKind::AcceptedMemoryProjectionWriteDiagnostics(_)
        | ServerQueryKind::AcceptedMemoryProjectionImportDiagnostics(_)
        | ServerQueryKind::AcceptedMemoryProjectionImportApplyDiagnostics(_)
        | ServerQueryKind::AcceptedMemoryImportApplyReviewDiagnostics(_)
        | ServerQueryKind::AcceptedMemoryReviewReceiptStorageDiagnostics(_)
        | ServerQueryKind::AcceptedMemoryActiveApplyDiagnostics(_)
        | ServerQueryKind::AcceptedMemoryReviewReadiness(_)) => {
            accepted_memory_queries::accepted_memory_query(handler, query)
        }
        ServerQueryKind::MemoryProposals(query) => {
            memory_proposals::memory_proposals_query(handler, query)
        }
        ServerQueryKind::MemoryProposalReviewDiagnostics(query) => {
            memory_proposal_review_diagnostics::memory_proposal_review_diagnostics_query(
                handler, query,
            )
        }
        ServerQueryKind::ResearchRunBriefs(query) => {
            research_run_briefs::research_run_briefs_query(handler, query)
        }
        ServerQueryKind::TaskSeedPromotionDiagnostics(query) => {
            task_seed_promotion_diagnostics::task_seed_promotion_diagnostics_query(handler, query)
        }
        ServerQueryKind::PlanningProjectionFileWriteDiagnostics(query) => {
            planning_projection_file_write_diagnostics::planning_projection_file_write_diagnostics_query(query)
        }
        ServerQueryKind::PlanningProjectionImportDiagnostics(query) => {
            planning_projection_import_diagnostics::planning_projection_import_diagnostics_query(query)
        }
        ServerQueryKind::PlanningProjectionImportApplyDiagnostics(query) => {
            planning_projection_import_apply_diagnostics::planning_projection_import_apply_diagnostics_query(handler, query)
        }
        ServerQueryKind::PlanningProjectionImportActiveApplyDiagnostics(query) => {
            planning_projection_import_active_apply_diagnostics::planning_projection_import_active_apply_diagnostics_query(handler, query)
        }
        ServerQueryKind::PlanningCapturePublicationDiagnostics(query) => {
            planning_capture_publication_diagnostics::planning_capture_publication_diagnostics_query(handler, query)
        }
        ServerQueryKind::ProductWorkflowSummary(query) => {
            product_workflow_summary::product_workflow_summary_query(handler, query)
        }
        ServerQueryKind::TaskWorkflowDrilldown(query) => {
            task_workflow_drilldown::task_workflow_drilldown_query(handler, query)
        }
        ServerQueryKind::SelectedTaskActionReadiness(query) => {
            selected_task_action_readiness::selected_task_action_readiness_query(handler, query)
        }
        ServerQueryKind::SelectedTaskOperatorActionGate(query) => {
            selected_task_operator_action_gate::selected_task_operator_action_gate_query(
                handler, query,
            )
        }
        ServerQueryKind::ProjectAuthorityMap(query) => {
            authority_map::project_authority_map_query(query)
        }
    }
}

pub(super) fn storage_error(error: LocalStoreError) -> ServerControlError {
    ServerControlError::StorageUnavailable {
        reason: format!("{error:?}"),
    }
}
