use crate::control_api::{
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerDiagnosticsQueryResult, ServerDiagnosticsSnapshot, ServerQueryResult,
};
use crate::control_envelope_dto::*;
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
use nucleus_native_harness::NativeEffigyProjectIntegration;

mod completion;
mod scm;

#[test]
fn response_envelope_dto_serializes_all_diagnostics_without_authority() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:diagnostics:all".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::All(empty_diagnostics_snapshot()),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlResponseEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");

    assert!(matches!(
        decoded.body,
        ControlResponseBodyDto::Diagnostics {
            result: ControlDiagnosticsResultDto::All(snapshot),
        } if !snapshot.steward.client_can_mutate
            && !snapshot.effigy.client_can_run_effigy
            && !snapshot.management_sync.client_can_mutate_provider
            && !snapshot.scm_session.client_can_mutate_working_copy
            && snapshot.steward.source_status == "empty"
            && snapshot.effigy.source_status == "disabled"
            && snapshot.management_sync.source_status == "empty"
            && snapshot.scm_session.source_status == "empty"
            && snapshot.task_agent.source_status == "empty"
            && snapshot.codex_provider.source_status == "empty"
            && !snapshot.codex_provider.client_can_control_provider
            && snapshot.live_evidence_completion.timeline_entry_count == 0
            && !snapshot.live_evidence_completion.client_mutation_authority
            && snapshot.completion_scm_readiness.candidate_count == 0
            && snapshot.completion_scm_readiness.repair_required
            && !snapshot.completion_scm_readiness.scm_authority_granted
            && snapshot.completion_scm_capture.admission_count == 0
            && !snapshot.completion_scm_capture.scm_capture_executed
            && snapshot.completion_scm_capture_preparation.plan_count == 0
            && !snapshot
                .completion_scm_capture_preparation
                .scm_capture_authority_granted
            && snapshot.scm_capture_dry_run.plan_count == 0
            && !snapshot.scm_capture_dry_run.scm_dry_run_authority_granted
            && !snapshot.scm_capture_dry_run.scm_capture_authority_granted
            && snapshot.scm_capture_dry_run_execution.receipt_count == 0
            && !snapshot.scm_capture_dry_run_execution.scm_capture_executed
            && !snapshot.scm_capture_dry_run_execution.raw_material_exposed
            && snapshot.git_dry_run_execution.execution_count == 0
            && !snapshot.git_dry_run_execution.commit_executed
            && !snapshot.git_dry_run_execution.raw_output_retained
            && snapshot.scm_capture_workflow.workflow_count == 0
            && snapshot.scm_capture_workflow.replay_only
            && !snapshot.scm_capture_workflow.scm_mutation_authority_granted
            && !snapshot.scm_capture_workflow.raw_output_retained
            && snapshot.scm_capture_review.readiness_count == 0
            && !snapshot.scm_capture_review.operator_decision_created
            && !snapshot.scm_capture_review.scm_mutation_authority_granted
            && !snapshot.scm_capture_review.raw_output_retained
            && snapshot.scm_capture_review_decision.decision_count == 0
            && !snapshot
                .scm_capture_review_decision
                .change_request_authority_granted
            && !snapshot
                .scm_capture_review_decision
                .scm_mutation_authority_granted
            && !snapshot.scm_capture_review_decision.raw_output_retained
            && snapshot.scm_change_request_preparation.admission_count == 0
            && snapshot.scm_change_request_preparation.adapter_neutral
            && !snapshot
                .scm_change_request_preparation
                .branch_or_snapshot_authority_granted
            && !snapshot.scm_change_request_preparation.forge_authority_granted
            && !snapshot.scm_change_request_preparation.raw_output_retained
    ));
    assert!(json.contains("\"type\":\"diagnostics\""));
    assert!(json.contains("\"domain\":\"all\""));
    assert_diagnostics_json_is_sanitized(&json);
}

#[test]
fn response_envelope_dto_serializes_codex_provider_diagnostics_domain() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:diagnostics:codex".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CodexProvider(empty_codex_provider_diagnostics()),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::Diagnostics {
            result: ControlDiagnosticsResultDto::CodexProvider(record),
        } if record.source_status == "empty"
            && !record.client_can_control_provider
            && !record.client_can_mutate_tasks
            && !record.live_executor.client_can_execute_provider_write
            && !record.recovery.client_can_resume_provider
    ));
    assert!(json.contains("\"domain\":\"codex_provider\""));
    assert_diagnostics_json_is_sanitized(&json);
}

#[test]
fn response_envelope_dto_serializes_single_diagnostics_domain() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:diagnostics:steward".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::Steward(steward_diagnostics(&[], &[], &[])),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::Diagnostics {
            result: ControlDiagnosticsResultDto::Steward(record),
        } if !record.client_can_mutate
            && record.source_status == "empty"
            && record.proposals.is_empty()
            && record.command_admissions.is_empty()
            && record.command_outcomes.is_empty()
    ));
    assert!(json.contains("\"domain\":\"steward\""));
    assert_diagnostics_json_is_sanitized(&json);
}

fn empty_diagnostics_snapshot() -> ServerDiagnosticsSnapshot {
    ServerDiagnosticsSnapshot {
        steward: steward_diagnostics(&[], &[], &[]),
        effigy: effigy_diagnostics(
            &NativeEffigyProjectIntegration::disabled("effigy unavailable"),
            None,
            None,
        ),
        management_sync: sync_diagnostics(&[], &[], &[], &[]),
        scm_session: scm_session_diagnostics(&[], &[], &[]),
        task_agent: task_agent_diagnostics(&[]),
        codex_provider: empty_codex_provider_diagnostics(),
        live_evidence_completion: empty_completion_diagnostics(),
        completion_scm_readiness: empty_completion_scm_diagnostics(),
        completion_scm_capture: empty_completion_scm_capture(),
        completion_scm_capture_preparation: empty_completion_scm_capture_preparation(),
        scm_capture_dry_run: empty_scm_capture_dry_run(),
        scm_capture_dry_run_execution: empty_scm_capture_dry_run_execution(),
        git_dry_run_execution: empty_git_dry_run_execution(),
        scm_capture_workflow: empty_scm_capture_workflow(),
        scm_capture_review: empty_scm_capture_review(),
        scm_capture_review_decision: empty_scm_capture_review_decision(),
        scm_change_request_preparation: empty_scm_change_request_prep(),
    }
}

fn empty_codex_provider_diagnostics() -> crate::CodexProviderDiagnosticsDto {
    codex_provider_diagnostics(
        codex_ingestion_diagnostics(&[]),
        codex_live_spawn_smoke_diagnostics(&[]),
        codex_live_executor_diagnostics(&[]),
        codex_task_backed_live_execution_diagnostics(&[], &[]),
        codex_turn_start_diagnostics(&[]),
        codex_subscription_diagnostics(&[], &[]),
        codex_transport_executor_diagnostics(&[], &[], &[], &[], &[], &[], &[]),
        codex_callback_diagnostics(&[]),
        codex_callback_response_execution_diagnostics(&[], &[]),
        codex_interruption_diagnostics(&[]),
        codex_interruption_execution_diagnostics(&[], &[]),
        codex_recovery_diagnostics(&[]),
        codex_recovery_execution_diagnostics(&[], &[]),
        durable_provider_executor_diagnostics(&[], &[], &[], &[], &[], &[], &[], &[], &[]),
    )
}

fn empty_completion_diagnostics() -> crate::LiveEvidenceCompletionControlDto {
    crate::live_evidence_completion_control_dto(crate::live_evidence_completion_read_model(
        crate::LiveEvidenceCompletionReadModelInput {
            completions: Vec::new(),
        },
    ))
}

fn empty_completion_scm_diagnostics() -> crate::CompletionScmControlDto {
    crate::completion_scm_control_dto(crate::completion_scm_read_model(
        crate::CompletionScmReadModelInput {
            history: None,
            adapter_label: "unconfigured".to_owned(),
            workflow_label: "unconfigured".to_owned(),
            adapter_supports_change_requests: false,
            adapter_available: false,
        },
    ))
}

fn empty_completion_scm_capture() -> crate::CompletionScmCaptureControlDto {
    crate::completion_scm_capture_control_dto(
        crate::completion_scm_capture_diagnostics_from_persisted_admissions(Vec::new()),
    )
}

fn empty_completion_scm_capture_preparation() -> crate::CompletionScmCapturePreparationControlDto {
    crate::completion_scm_capture_preparation_control_dto(
        crate::completion_scm_capture_preparation_diagnostics_from_persisted_records(Vec::new()),
    )
}

fn empty_scm_capture_dry_run() -> crate::ScmCaptureDryRunControlDto {
    crate::scm_capture_dry_run_control_dto(
        crate::scm_capture_dry_run_diagnostics_from_persisted_records(Vec::new()),
    )
}

fn empty_scm_capture_dry_run_execution() -> crate::ScmCaptureDryRunExecutionControlDto {
    crate::scm_capture_dry_run_execution_control_dto(
        crate::scm_capture_dry_run_execution_diagnostics_from_persisted_records(Vec::new()),
    )
}

fn empty_git_dry_run_execution() -> crate::GitDryRunExecutionControlDto {
    crate::git_dry_run_execution_control_dto(
        crate::git_dry_run_execution_diagnostics_from_persisted_records(Vec::new()),
    )
}

fn empty_scm_capture_workflow() -> crate::ScmCaptureWorkflowControlDto {
    crate::scm_capture_workflow_control_dto(crate::scm_capture_workflow_diagnostics(Vec::new()))
}

fn empty_scm_capture_review() -> crate::ScmCaptureReviewControlDto {
    crate::scm_capture_review_control_dto(crate::scm_capture_review_diagnostics(Vec::new()))
}

fn empty_scm_capture_review_decision() -> crate::ScmCaptureReviewDecisionControlDto {
    crate::scm_capture_review_decision_control_dto(crate::scm_capture_review_decision_diagnostics(
        Vec::new(),
    ))
}

fn empty_scm_change_request_prep() -> crate::ScmChangeRequestPrepControlDto {
    crate::scm_change_request_prep_control_dto(crate::scm_change_request_prep_diagnostics(
        Vec::new(),
    ))
}

fn assert_diagnostics_json_is_sanitized(json: &str) {
    for forbidden in [
        "raw_stdout",
        "raw_stderr",
        "payload",
        "bytes",
        "credential",
        "secret",
        "command_request",
        "provider_payload",
    ] {
        assert!(
            !json.contains(forbidden),
            "diagnostics DTO should not contain {forbidden}"
        );
    }
}
