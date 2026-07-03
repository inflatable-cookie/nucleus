use nucleus_server::{
    ControlCommandEvidenceRecordDto, ControlResponseBodyDto, ControlResponseEnvelopeDto,
};

mod memory_proposal_review;
mod memory_proposals;
mod planning_capture_publication;
mod planning_projection_file_write;
mod planning_projection_import;
mod planning_projection_import_apply;
mod planning_sessions;
mod planning_task_seeds;
mod provider;
mod research_run_briefs;
mod task_authority;
mod task_readiness;
mod task_seed_promotion;

pub(super) use memory_proposal_review::memory_proposal_review_response_lines;
pub(super) use memory_proposals::memory_proposals_response_lines;
pub(super) use planning_capture_publication::planning_capture_publication_response_lines;
pub(super) use planning_projection_file_write::planning_projection_file_write_response_lines;
pub(super) use planning_projection_import::planning_projection_import_response_lines;
pub(super) use planning_projection_import_apply::planning_projection_import_apply_response_lines;
pub(super) use planning_sessions::planning_sessions_response_lines;
pub(super) use planning_task_seeds::planning_task_seeds_response_lines;
pub(super) use provider::{
    provider_live_read_executor_response_lines, provider_live_read_smoke_evidence_response_lines,
    provider_read_intent_response_lines, provider_readiness_overview_response_lines,
};
pub(super) use research_run_briefs::research_run_briefs_response_lines;
pub(super) use task_authority::{
    project_authority_map_response_lines, task_timeline_response_lines,
};
pub(super) use task_readiness::task_readiness_response_lines;
pub(super) use task_seed_promotion::task_seed_promotion_response_lines;

pub(super) fn print_typed_dto_response(
    label: &str,
    dto: ControlResponseEnvelopeDto,
) -> Result<(), String> {
    if dto.status != nucleus_server::ControlResponseStatusDto::Complete {
        return Err(format!("{label} query returned status {:?}", dto.status));
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
        ControlResponseBodyDto::PlanningCapturePublicationDiagnostics { diagnostics } => {
            print_lines(planning_capture_publication_response_lines(
                label,
                diagnostics,
            ));
            Ok(())
        }
        ControlResponseBodyDto::ProjectAuthorityMap { record } => {
            print_lines(project_authority_map_response_lines(label, record));
            Ok(())
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

pub(super) fn command_evidence_response_lines(
    label: &str,
    records: Vec<ControlCommandEvidenceRecordDto>,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("records={}", records.len()),
    ];
    for record in records {
        lines.extend(command_evidence_record_lines(record));
    }
    lines
}

fn command_evidence_record_lines(record: ControlCommandEvidenceRecordDto) -> Vec<String> {
    let mut lines = vec![
        format!("record evidence_id={}", record.evidence_id),
        format!("  request_id={}", record.command_request_id),
        format!("  status={}", record.status),
        format!("  retention={}", record.retention),
    ];
    match record.exit_status {
        Some(status) => lines.push(format!("  exit_status={status}")),
        None => lines.push("  exit_status=none".to_owned()),
    }
    lines.push(format!(
        "  stdout_artifact_ref={}",
        record.stdout_artifact_ref.as_deref().unwrap_or("none")
    ));
    lines.push(format!(
        "  stderr_artifact_ref={}",
        record.stderr_artifact_ref.as_deref().unwrap_or("none")
    ));
    lines.push("  raw_output=not_retained".to_owned());
    if let Some(summary) = record.summary {
        lines.push(format!("  summary={summary}"));
    }
    lines
}
