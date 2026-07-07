use nucleus_server::{ControlResponseBodyDto, ControlResponseEnvelopeDto};

mod accepted_memory;
mod accepted_memory_active_apply;
mod accepted_memory_import_apply_review;
mod accepted_memory_projection;
mod accepted_memory_projection_import;
mod accepted_memory_projection_import_apply;
mod accepted_memory_projection_writes;
mod accepted_memory_review;
mod accepted_memory_review_receipt_storage;
mod command_evidence;
mod memory_proposal_review;
mod memory_proposals;
mod planning_capture_publication;
mod planning_projection_file_write;
mod planning_projection_import;
mod planning_projection_import_active_apply;
mod planning_projection_import_apply;
mod planning_sessions;
mod planning_task_seeds;
mod product_workflow;
mod provider;
mod research_run_briefs;
mod selected_task;
mod selected_task_action_readiness;
mod selected_task_command_admission;
mod selected_task_operator_action_gate;
mod selected_task_review_decision;
mod selected_task_review_next;
mod selected_task_review_outcome_route;
mod selected_task_route_admission;
mod selected_task_scm_handoff;
mod task_authority;
mod task_readiness;
mod task_seed_promotion;
mod task_workflow_drilldown;

pub(super) use accepted_memory::accepted_memory_response_lines;
pub(super) use accepted_memory_active_apply::accepted_memory_active_apply_response_lines;
pub(super) use accepted_memory_import_apply_review::accepted_memory_import_apply_review_response_lines;
pub(super) use accepted_memory_projection::accepted_memory_projection_response_lines;
pub(super) use accepted_memory_projection_import::accepted_memory_projection_import_response_lines;
pub(super) use accepted_memory_projection_import_apply::accepted_memory_projection_import_apply_response_lines;
pub(super) use accepted_memory_projection_writes::accepted_memory_projection_writes_response_lines;
pub(super) use accepted_memory_review::accepted_memory_review_response_lines;
pub(super) use accepted_memory_review_receipt_storage::accepted_memory_review_receipt_storage_response_lines;
pub(super) use command_evidence::command_evidence_response_lines;
pub(super) use memory_proposal_review::memory_proposal_review_response_lines;
pub(super) use memory_proposals::memory_proposals_response_lines;
pub(super) use planning_capture_publication::planning_capture_publication_response_lines;
pub(super) use planning_projection_file_write::planning_projection_file_write_response_lines;
pub(super) use planning_projection_import::planning_projection_import_response_lines;
pub(super) use planning_projection_import_active_apply::planning_projection_import_active_apply_response_lines;
pub(super) use planning_projection_import_apply::planning_projection_import_apply_response_lines;
pub(super) use planning_sessions::planning_sessions_response_lines;
pub(super) use planning_task_seeds::planning_task_seeds_response_lines;
pub(super) use product_workflow::product_workflow_response_lines;
pub(super) use provider::{
    provider_live_read_executor_response_lines, provider_live_read_smoke_evidence_response_lines,
    provider_read_intent_response_lines, provider_readiness_overview_response_lines,
};
pub(super) use research_run_briefs::research_run_briefs_response_lines;
use selected_task::selected_task_response_lines;
#[cfg(test)]
pub(super) use selected_task_action_readiness::selected_task_action_readiness_response_lines;
#[cfg(test)]
pub(super) use selected_task_command_admission::selected_task_command_admission_response_lines;
#[cfg(test)]
pub(super) use selected_task_operator_action_gate::selected_task_operator_action_gate_response_lines;
#[cfg(test)]
pub(super) use selected_task_review_decision::{
    selected_task_review_decision_admission_response_lines,
    selected_task_review_decision_apply_response_lines,
};
#[cfg(test)]
pub(super) use selected_task_review_next::selected_task_review_next_response_lines;
#[cfg(test)]
pub(super) use selected_task_review_outcome_route::selected_task_review_outcome_route_response_lines;
#[cfg(test)]
pub(super) use selected_task_route_admission::selected_task_route_admission_response_lines;
#[cfg(test)]
pub(super) use selected_task_scm_handoff::selected_task_scm_handoff_response_lines;
pub(super) use task_authority::{
    project_authority_map_response_lines, task_timeline_response_lines,
};
pub(super) use task_readiness::task_readiness_response_lines;
pub(super) use task_seed_promotion::task_seed_promotion_response_lines;
pub(super) use task_workflow_drilldown::task_workflow_drilldown_response_lines;

pub(super) fn print_typed_dto_response(
    label: &str,
    dto: ControlResponseEnvelopeDto,
) -> Result<(), String> {
    if dto.status != nucleus_server::ControlResponseStatusDto::Complete {
        return Err(format!("{label} query returned status {:?}", dto.status));
    }

    if let Some(lines) = selected_task_response_lines(label, &dto.body) {
        return print_ok(lines);
    }

    match dto.body {
        ControlResponseBodyDto::CommandEvidenceRecords { records } => {
            print_lines(command_evidence_response_lines(label, records));
            Ok(())
        }
        ControlResponseBodyDto::ProviderReadIntent { result } => {
            print_lines(provider_read_intent_response_lines(label, result));
            Ok(())
        }
        ControlResponseBodyDto::ProviderReadinessOverview { overview } => {
            print_lines(provider_readiness_overview_response_lines(label, overview));
            Ok(())
        }
        ControlResponseBodyDto::ProviderLiveReadExecutorDiagnostics { diagnostics } => {
            print_lines(provider_live_read_executor_response_lines(
                label,
                diagnostics,
            ));
            Ok(())
        }
        ControlResponseBodyDto::ProviderLiveReadSmokeEvidenceDiagnostics { diagnostics } => {
            print_lines(provider_live_read_smoke_evidence_response_lines(
                label,
                diagnostics,
            ));
            Ok(())
        }
        ControlResponseBodyDto::TaskTimeline {
            task_id,
            entries,
            last_source_event_id,
        } => {
            print_lines(task_timeline_response_lines(
                label,
                task_id,
                entries,
                last_source_event_id,
            ));
            Ok(())
        }
        ControlResponseBodyDto::TaskReadiness {
            project_id,
            candidates,
            status_counts,
            source_counts,
            client_can_mutate,
            provider_execution_available,
        } => {
            print_lines(task_readiness_response_lines(
                label,
                project_id,
                candidates,
                status_counts,
                source_counts,
                client_can_mutate,
                provider_execution_available,
            ));
            Ok(())
        }
        ControlResponseBodyDto::PlanningTaskSeeds {
            project_id,
            candidates,
            status_counts,
            source_counts,
            client_can_promote,
            task_creation_performed,
        } => {
            print_lines(planning_task_seeds_response_lines(
                label,
                project_id,
                candidates,
                status_counts,
                source_counts,
                client_can_promote,
                task_creation_performed,
            ));
            Ok(())
        }
        ControlResponseBodyDto::PlanningSessions {
            project_id,
            sessions,
            status_counts,
            source_counts,
            client_can_mutate,
            provider_execution_available,
        } => {
            print_lines(planning_sessions_response_lines(
                label,
                project_id,
                sessions,
                status_counts,
                source_counts,
                client_can_mutate,
                provider_execution_available,
            ));
            Ok(())
        }
        ControlResponseBodyDto::MemoryProposals {
            project_id,
            proposals,
            status_counts,
            scope_counts,
            sensitivity_counts,
            retention_counts,
            source_counts,
            client_can_mutate,
            provider_execution_available,
        } => {
            print_lines(memory_proposals_response_lines(
                label,
                project_id,
                proposals,
                status_counts,
                scope_counts,
                sensitivity_counts,
                retention_counts,
                source_counts,
                client_can_mutate,
                provider_execution_available,
            ));
            Ok(())
        }
        ControlResponseBodyDto::AcceptedMemory {
            project_id,
            memories,
            status_counts,
            scope_counts,
            kind_counts,
            sensitivity_counts,
            retention_counts,
            confidence_counts,
            source_counts,
            client_can_mutate,
            projection_written,
            embedding_available,
            provider_sync_available,
        } => {
            print_lines(accepted_memory_response_lines(
                label,
                project_id,
                memories,
                status_counts,
                scope_counts,
                kind_counts,
                sensitivity_counts,
                retention_counts,
                confidence_counts,
                source_counts,
                client_can_mutate,
                projection_written,
                embedding_available,
                provider_sync_available,
            ));
            Ok(())
        }
        ControlResponseBodyDto::AcceptedMemoryProjectionDiagnostics { diagnostics } => {
            print_lines(accepted_memory_projection_response_lines(
                label,
                diagnostics,
            ));
            Ok(())
        }
        ControlResponseBodyDto::AcceptedMemoryProjectionWriteDiagnostics { diagnostics } => {
            print_lines(accepted_memory_projection_writes_response_lines(
                label,
                diagnostics,
            ));
            Ok(())
        }
        ControlResponseBodyDto::AcceptedMemoryProjectionImportDiagnostics { diagnostics } => {
            print_lines(accepted_memory_projection_import_response_lines(
                label,
                diagnostics,
            ));
            Ok(())
        }
        ControlResponseBodyDto::AcceptedMemoryProjectionImportApplyDiagnostics { diagnostics } => {
            print_lines(accepted_memory_projection_import_apply_response_lines(
                label,
                diagnostics,
            ));
            Ok(())
        }
        ControlResponseBodyDto::AcceptedMemoryImportApplyReviewDiagnostics { diagnostics } => {
            print_lines(accepted_memory_import_apply_review_response_lines(
                label,
                diagnostics,
            ));
            Ok(())
        }
        ControlResponseBodyDto::AcceptedMemoryReviewReceiptStorageDiagnostics { diagnostics } => {
            print_lines(accepted_memory_review_receipt_storage_response_lines(
                label,
                diagnostics,
            ));
            Ok(())
        }
        ControlResponseBodyDto::AcceptedMemoryActiveApplyDiagnostics { diagnostics } => {
            print_lines(accepted_memory_active_apply_response_lines(
                label,
                diagnostics,
            ));
            Ok(())
        }
        ControlResponseBodyDto::AcceptedMemoryReviewReadiness { readiness } => {
            print_lines(accepted_memory_review_response_lines(label, readiness));
            Ok(())
        }
        ControlResponseBodyDto::MemoryProposalReviewDiagnostics { diagnostics } => {
            print_lines(memory_proposal_review_response_lines(label, diagnostics));
            Ok(())
        }
        ControlResponseBodyDto::ResearchRunBriefs {
            project_id,
            runs,
            status_counts,
            source_kind_counts,
            observation_kind_counts,
            synthesis_kind_counts,
            source_counts,
            client_can_mutate,
            provider_execution_available,
        } => {
            print_lines(research_run_briefs_response_lines(
                label,
                project_id,
                runs,
                status_counts,
                source_kind_counts,
                observation_kind_counts,
                synthesis_kind_counts,
                source_counts,
                client_can_mutate,
                provider_execution_available,
            ));
            Ok(())
        }
        ControlResponseBodyDto::TaskSeedPromotionDiagnostics { diagnostics } => {
            print_lines(task_seed_promotion_response_lines(label, diagnostics));
            Ok(())
        }
        ControlResponseBodyDto::PlanningProjectionFileWriteDiagnostics { diagnostics } => {
            print_lines(planning_projection_file_write_response_lines(
                label,
                diagnostics,
            ));
            Ok(())
        }
        ControlResponseBodyDto::PlanningProjectionImportDiagnostics { diagnostics } => {
            print_lines(planning_projection_import_response_lines(
                label,
                diagnostics,
            ));
            Ok(())
        }
        ControlResponseBodyDto::PlanningProjectionImportApplyDiagnostics { diagnostics } => {
            print_lines(planning_projection_import_apply_response_lines(
                label,
                diagnostics,
            ));
            Ok(())
        }
        ControlResponseBodyDto::PlanningProjectionImportActiveApplyDiagnostics { diagnostics } => {
            print_ok(planning_projection_import_active_apply_response_lines(
                label,
                diagnostics,
            ))
        }
        ControlResponseBodyDto::PlanningCapturePublicationDiagnostics { diagnostics } => print_ok(
            planning_capture_publication_response_lines(label, diagnostics),
        ),
        ControlResponseBodyDto::ProductWorkflowSummary { summary } => {
            print_ok(product_workflow_response_lines(label, summary))
        }
        ControlResponseBodyDto::TaskWorkflowDrilldown { drilldown } => {
            print_ok(task_workflow_drilldown_response_lines(label, drilldown))
        }
        ControlResponseBodyDto::ProjectAuthorityMap { record } => {
            print_ok(project_authority_map_response_lines(label, record))
        }
        ControlResponseBodyDto::Error { kind, reason } => {
            Err(format!("{label} query failed: {kind}: {reason}"))
        }
        body => Err(format!(
            "{label} query returned unexpected DTO response: {body:?}"
        )),
    }
}

fn print_lines(lines: Vec<String>) {
    for line in lines {
        println!("{line}");
    }
}

fn print_ok(lines: Vec<String>) -> Result<(), String> {
    print_lines(lines);
    Ok(())
}
