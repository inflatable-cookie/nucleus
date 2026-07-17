use nucleus_server::{
    ControlAcceptedMemoryProjectionBlockerDto, ControlAcceptedMemoryProjectionCountsDto,
    ControlAcceptedMemoryProjectionDiagnosticsDto, ControlAcceptedMemoryProjectionEntryDto,
    ControlAcceptedMemoryProjectionImportAdmissionDto,
    ControlAcceptedMemoryProjectionImportBlockerDto,
    ControlAcceptedMemoryProjectionImportCandidateDto,
    ControlAcceptedMemoryProjectionImportConflictDto,
    ControlAcceptedMemoryProjectionImportCountsDto,
    ControlAcceptedMemoryProjectionImportDiagnosticsDto,
    ControlAcceptedMemoryProjectionImportSummaryDto,
    ControlAcceptedMemoryProjectionWriteBlockerDto, ControlAcceptedMemoryProjectionWriteCountsDto,
    ControlAcceptedMemoryProjectionWriteDiagnosticsDto,
    ControlAcceptedMemoryProjectionWriteEntryDto, ControlProviderLiveReadExecutorDiagnosticsDto,
    ControlProviderLiveReadSmokeEvidenceDiagnosticsDto, ControlProviderReadIntentProjectionDto,
    ControlProviderReadIntentQueryResultDto, ControlProviderReadIntentSourceCountsDto,
    ControlProviderReadinessOverviewDto, ControlTaskSeedPromotionDiagnosticEntryDto,
    ControlTaskSeedPromotionDiagnosticsDto,
};

use super::*;

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
mod product_workflow;
mod research_run_briefs;
mod selected_task_action_readiness;
mod selected_task_command_admission;
mod selected_task_completion_route_apply;
mod selected_task_operator_action_gate;
mod selected_task_product_aggregate;
mod selected_task_review_decision;
mod selected_task_review_next;
mod selected_task_review_outcome_route;
mod selected_task_rework_preparation;
mod selected_task_route_admission;
mod selected_task_scm_handoff;
mod task_workflow_drilldown;

#[test]
fn provider_read_intent_response_lines_do_not_include_provider_effects() {
    let lines = typed_response::provider_read_intent_response_lines(
        "provider-read-intent",
        ControlProviderReadIntentQueryResultDto {
            query_id: "forge-read-intent-query".to_owned(),
            projection: ControlProviderReadIntentProjectionDto {
                projection_id: "forge-read-intent-projection".to_owned(),
                total_count: 0,
                credential_status_count: 0,
                repository_metadata_count: 0,
                pull_request_count: 0,
                status_check_count: 0,
                ready_count: 0,
                duplicate_noop_count: 0,
                blocked_count: 0,
                repair_required_count: 0,
                blocker_count: 0,
                evidence_ref_count: 0,
                entries: Vec::new(),
                no_effects: nucleus_server::ProviderRuntimeNoEffects::none(),
            },
            source_counts: ControlProviderReadIntentSourceCountsDto {
                credential_status_records: 0,
                repository_metadata_records: 0,
                pull_request_records: 0,
                status_check_records: 0,
            },
                no_effects: nucleus_server::ProviderRuntimeNoEffects::none(),
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=provider-read-intent"));
    assert!(rendered.contains("records=0"));
    assert!(rendered.contains("provider_network_call_performed=false"));
    assert!(rendered.contains("raw_provider_payload_retained=false"));
    assert!(!rendered.contains("access_token"));
    assert!(!rendered.contains("authorization"));
    assert!(!rendered.contains("raw_response_body"));
}

#[test]
fn task_timeline_response_lines_are_read_only() {
    let lines = typed_response::task_timeline_response_lines(
        "task-timeline",
        "task:nucleus-local:bootstrap".to_owned(),
        vec![nucleus_server::ControlTaskTimelineEntryDto {
            entry_id: "timeline:task:nucleus-local:bootstrap:event:1".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            kind: "task_command_admitted".to_owned(),
            source_command_id: "command:start".to_owned(),
            source_event_id: "event:start".to_owned(),
            source_projection_id: "projection:1".to_owned(),
            summary: "Task command admitted: command:start".to_owned(),
        }],
        Some("event:start".to_owned()),
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=task-timeline"));
    assert!(rendered.contains("records=1"));
    assert!(rendered.contains("client_can_mutate=false"));
    assert!(!rendered.contains("raw_payload="));
    assert!(!rendered.contains("provider_write"));
}

#[test]
fn task_readiness_response_lines_are_read_only() {
    let lines = typed_response::task_readiness_response_lines(
        "task-readiness",
        "project:nucleus-local".to_owned(),
        vec![nucleus_server::ControlTaskReadinessCandidateDto {
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            title: "Review Nucleus task workflow".to_owned(),
            action_type: "plan".to_owned(),
            activity: "ready".to_owned(),
            readiness: "human_planning_ready".to_owned(),
            reasons: vec!["task needs human planning or readiness review".to_owned()],
            blocker_refs: Vec::new(),
            evidence_refs: Vec::new(),
            agent_ready: false,
            validation_commands: Vec::new(),
        }],
        vec![nucleus_server::ControlTaskReadinessStatusCountDto {
            readiness: "human_planning_ready".to_owned(),
            count: 1,
        }],
        nucleus_server::ControlTaskReadinessSourceCountsDto {
            task_records: 1,
            work_item_evidence_refs: 0,
            timeline_evidence_refs: 0,
            validation_command_refs: 0,
        },
        false,
        false,
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=task-readiness"));
    assert!(rendered.contains("project_id=project:nucleus-local"));
    assert!(rendered.contains("candidates=1"));
    assert!(rendered.contains("client_can_mutate=false"));
    assert!(rendered.contains("provider_execution_available=false"));
    assert!(!rendered.contains("access_token"));
    assert!(!rendered.contains("raw_payload="));
    assert!(!rendered.contains("provider_write_executed=true"));
}

#[test]
fn task_seed_promotion_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::task_seed_promotion_response_lines(
        "task-seed-promotion-diagnostics",
        ControlTaskSeedPromotionDiagnosticsDto {
            project_id: "project:nucleus-local".to_owned(),
            task_seed_records: 1,
            ready_count: 0,
            blocked_count: 0,
            rejected_count: 0,
            promoted_count: 1,
            duplicate_promoted_task_ref_count: 0,
            missing_promoted_task_ref_count: 0,
            entries: vec![ControlTaskSeedPromotionDiagnosticEntryDto {
                seed_id: "seed:planning:ready".to_owned(),
                project_id: "project:nucleus-local".to_owned(),
                readiness: "promoted".to_owned(),
                review_state: "accepted".to_owned(),
                promotion_state: "promoted".to_owned(),
                promoted_task_ref: Some("task:command:promote-seed".to_owned()),
                promoted_task_exists: true,
                duplicate_promoted_task_ref: false,
                blocking_question_count: 0,
            }],
            client_can_mutate: false,
            task_creation_performed: false,
            provider_execution_performed: false,
            raw_planning_body_exposed: false,
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=task-seed-promotion-diagnostics"));
    assert!(rendered.contains("records=1"));
    assert!(rendered.contains("client_can_mutate=false"));
    assert!(rendered.contains("task_creation_performed=false"));
    assert!(rendered.contains("provider_execution_performed=false"));
    assert!(rendered.contains("raw_planning_body_exposed=false"));
    assert!(!rendered.contains("problem_statement"));
    assert!(!rendered.contains("private:context"));
    assert!(!rendered.contains("raw_payload="));
}

#[test]
fn project_authority_map_response_lines_do_not_grant_authority() {
    let lines = typed_response::project_authority_map_response_lines(
        "project-authority-map",
        nucleus_server::ControlProjectAuthorityMapDto {
            project_id: "project:nucleus-local".to_owned(),
            domains: Vec::new(),
            issues: vec![nucleus_server::ControlProjectAuthorityIssueDto {
                kind: "publication_deferred".to_owned(),
                domain: None,
                host_id: None,
                reason: Some("authority-map persistence is not implemented".to_owned()),
            }],
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=project-authority-map"));
    assert!(rendered.contains("client_can_grant_authority=false"));
    assert!(rendered.contains("client_can_mutate=false"));
    assert!(!rendered.contains("mutation_allowed=true"));
    assert!(!rendered.contains("credential_material"));
}

#[test]
fn provider_readiness_overview_response_lines_do_not_include_provider_effects() {
    let lines = typed_response::provider_readiness_overview_response_lines(
        "provider-readiness-overview",
        ControlProviderReadinessOverviewDto {
            overview_id: "forge-readiness-overview".to_owned(),
            projection_id: "forge-read-intent-projection".to_owned(),
            project_ref: None,
            repo_ref: None,
            authority_host_ref: Some("host:local".to_owned()),
            provider_instance_refs: Vec::new(),
            remote_repo_refs: Vec::new(),
            forge_providers: Vec::new(),
            status: "unknown".to_owned(),
            supported_read_families: vec![
                "credential_status".to_owned(),
                "repository_metadata".to_owned(),
                "pull_request".to_owned(),
            ],
            represented_read_families: Vec::new(),
            represented_mutating_families: Vec::new(),
            total_read_intent_count: 0,
            missing_evidence_family_count: 3,
            ready_count: 0,
            blocked_count: 0,
            repair_required_count: 0,
            duplicate_noop_count: 0,
            blocker_count: 3,
            evidence_ref_count: 0,
            approved_live_read_smoke_evidence_count: 0,
                no_effects: nucleus_server::ProviderRuntimeNoEffects::none(),
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=provider-readiness-overview"));
    assert!(rendered.contains("status=unknown"));
    assert!(rendered.contains("records=0"));
    assert!(rendered.contains("missing_evidence_families=3"));
    assert!(rendered.contains("approved_smoke_evidence=0"));
    assert!(rendered.contains("provider_network_call_performed=false"));
    assert!(rendered.contains("raw_provider_payload_retained=false"));
    assert!(!rendered.contains("access_token"));
    assert!(!rendered.contains("authorization"));
    assert!(!rendered.contains("raw_response_body"));
}

#[test]
fn provider_live_read_executor_response_lines_do_not_include_provider_effects() {
    let lines = typed_response::provider_live_read_executor_response_lines(
        "provider-live-read-executor",
        ControlProviderLiveReadExecutorDiagnosticsDto {
            diagnostics_id: "provider-live-read-server-executor-diagnostics".to_owned(),
            request_count: 0,
            ready_request_count: 0,
            blocked_request_count: 0,
            descriptor_ready_count: 0,
            sanitized_output_count: 0,
            parse_error_count: 0,
            receipt_count: 0,
            provider_network_read_performed_count: 0,
            blocker_count: 0,
            provider_write_executed: false,
            callback_effect_executed: false,
            interruption_effect_executed: false,
            recovery_effect_executed: false,
            task_mutation_executed: false,
            raw_provider_payload_retained: false,
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=provider-live-read-executor"));
    assert!(rendered.contains("records=0"));
    assert!(rendered.contains("provider_network_reads=0"));
    assert!(rendered.contains("provider_write_executed=false"));
    assert!(rendered.contains("raw_provider_payload_retained=false"));
    assert!(!rendered.contains("access_token"));
    assert!(!rendered.contains("authorization"));
    assert!(!rendered.contains("raw_response_body"));
}

#[test]
fn provider_live_read_smoke_evidence_response_lines_do_not_include_provider_effects() {
    let lines = typed_response::provider_live_read_smoke_evidence_response_lines(
        "provider-live-read-smoke-evidence",
        ControlProviderLiveReadSmokeEvidenceDiagnosticsDto {
            diagnostics_id: "provider-live-read-approved-smoke-evidence-diagnostics".to_owned(),
            evidence_count: 1,
            promoted_count: 1,
            repair_required_count: 0,
            blocked_count: 0,
            duplicate_count: 0,
            provider_network_read_performed_count: 1,
            blocker_count: 0,
            provider_write_executed: false,
            callback_effect_executed: false,
            interruption_effect_executed: false,
            recovery_effect_executed: false,
            task_mutation_executed: false,
            raw_provider_payload_retained: false,
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=provider-live-read-smoke-evidence"));
    assert!(rendered.contains("records=1"));
    assert!(rendered.contains("promoted=1"));
    assert!(rendered.contains("provider_network_reads=1"));
    assert!(rendered.contains("provider_write_executed=false"));
    assert!(rendered.contains("raw_provider_payload_retained=false"));
    assert!(!rendered.contains("access_token"));
    assert!(!rendered.contains("authorization"));
    assert!(!rendered.contains("raw_response_body"));
}
