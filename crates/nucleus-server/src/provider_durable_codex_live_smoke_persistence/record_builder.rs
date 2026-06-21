use crate::codex_supervision::{
    CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorMethod,
    CodexAppServerLiveExecutorOutcomeInput, CodexAppServerLiveExecutorOutcomePersistenceRecord,
    CodexAppServerLiveExecutorOutcomeStatus,
};
use crate::provider_retention_policy::{
    ProviderRetentionPolicyInput, ProviderRetentionPolicyStatus,
};
use crate::{DurableCodexLiveSmokeBoundaryStatus, DurableCodexLiveSmokeDispatchRunRecord};

use super::helpers::unique_sorted;
use super::types::{
    DurableCodexLiveSmokeEvidencePersistenceInput, DurableCodexLiveSmokeEvidenceRecord,
    DurableCodexLiveSmokeEvidenceStatus, DurableCodexLiveSmokeOutcomeSummary,
};
use super::DURABLE_CODEX_LIVE_SMOKE_EVIDENCE_PREFIX;

pub(super) fn evidence_record(
    input: DurableCodexLiveSmokeEvidencePersistenceInput,
    live_persistence: Option<CodexAppServerLiveExecutorOutcomePersistenceRecord>,
    outcome_summary: Option<DurableCodexLiveSmokeOutcomeSummary>,
    duplicate_write: bool,
    retention_status: ProviderRetentionPolicyStatus,
) -> DurableCodexLiveSmokeEvidenceRecord {
    let status = if duplicate_write {
        DurableCodexLiveSmokeEvidenceStatus::DuplicateWriteAttemptNoop
    } else if retention_status != ProviderRetentionPolicyStatus::AcceptedReferenceOnly {
        DurableCodexLiveSmokeEvidenceStatus::Blocked("retention policy blocked".to_owned())
    } else {
        DurableCodexLiveSmokeEvidenceStatus::Persisted
    };
    let mut evidence_refs = input.run.boundary.evidence_refs.clone();
    evidence_refs.extend(input.persistence_evidence_refs);

    DurableCodexLiveSmokeEvidenceRecord {
        evidence_id: format!(
            "{}{}",
            DURABLE_CODEX_LIVE_SMOKE_EVIDENCE_PREFIX, input.run.boundary.write_attempt_id
        ),
        run_id: input.run.run_id,
        boundary_id: input.run.boundary.boundary_id.0,
        command_id: input.run.command.command_id.0,
        dispatch_attempt_id: input.run.dispatch_admission.dispatch_attempt_id,
        handoff_id: input.run.handoff.handoff_id.0,
        provider_instance_id: input.run.boundary.provider_instance_id,
        runtime_session_ref: input.run.boundary.runtime_session_ref,
        write_attempt_id: input.run.boundary.write_attempt_id,
        idempotency_key: input.run.boundary.idempotency_key,
        status,
        retention_status,
        live_executor_outcome_id: live_persistence
            .as_ref()
            .map(|persistence| persistence.outcome_id.clone()),
        runtime_receipt_id: live_persistence
            .as_ref()
            .map(|persistence| persistence.receipt_id.0.clone()),
        thread_id: outcome_summary
            .as_ref()
            .and_then(|summary| summary.thread_id.clone()),
        turn_id: outcome_summary
            .as_ref()
            .and_then(|summary| summary.turn_id.clone()),
        final_turn_status: outcome_summary
            .as_ref()
            .and_then(|summary| summary.final_turn_status.clone()),
        method_sequence_count: outcome_summary
            .as_ref()
            .map(|summary| summary.method_sequence_count)
            .unwrap_or_default(),
        notification_count: outcome_summary
            .as_ref()
            .map(|summary| summary.notification_count)
            .unwrap_or_default(),
        server_request_count: outcome_summary
            .as_ref()
            .map(|summary| summary.server_request_count)
            .unwrap_or_default(),
        cleanup_status: outcome_summary
            .as_ref()
            .map(|summary| summary.cleanup_status.clone())
            .unwrap_or(CodexAppServerLiveExecutorCleanupStatus::Unknown),
        evidence_refs: unique_sorted(evidence_refs),
        artifact_refs: unique_sorted(input.artifact_refs),
        duplicate_write_attempt_detected: duplicate_write,
        provider_write_executed: live_persistence
            .as_ref()
            .map(|persistence| persistence.provider_write_executed)
            .unwrap_or(false),
        executor_invoked: false,
        raw_provider_material_retained: false,
        raw_stream_retained: false,
        task_mutation_permitted: false,
    }
}

pub(super) fn retention_input(
    input: &DurableCodexLiveSmokeEvidencePersistenceInput,
) -> ProviderRetentionPolicyInput {
    ProviderRetentionPolicyInput {
        record_ref: input.run.boundary.boundary_id.0.clone(),
        evidence_refs: input.persistence_evidence_refs.clone(),
        artifact_refs: input.artifact_refs.clone(),
        raw_payload_present: input.raw_provider_material_present,
        raw_stream_present: input.raw_stream_present,
        secret_material_present: input.secret_material_present,
        credential_material_present: input.credential_material_present,
        unbounded_local_path_present: input.unbounded_local_path_present,
        artifact_policy_approved: true,
        diagnostics_requested: true,
    }
}

pub(super) fn live_outcome_input(
    run: &DurableCodexLiveSmokeDispatchRunRecord,
) -> CodexAppServerLiveExecutorOutcomeInput {
    CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: run.boundary.provider_instance_id.clone(),
        write_attempt_id: run.boundary.write_attempt_id.clone(),
        receipt_refs: vec![format!("receipt:durable-live-smoke:{}", run.run_id)],
        thread_id: None,
        turn_id: None,
        final_turn_status: None,
        status: match run.boundary.status {
            DurableCodexLiveSmokeBoundaryStatus::DryRunEligible
            | DurableCodexLiveSmokeBoundaryStatus::EligibleForExplicitLiveProviderWrite => {
                CodexAppServerLiveExecutorOutcomeStatus::Accepted
            }
            DurableCodexLiveSmokeBoundaryStatus::Blocked => {
                CodexAppServerLiveExecutorOutcomeStatus::Blocked(
                    "durable live smoke boundary blocked".to_owned(),
                )
            }
        },
        method_sequence: vec![CodexAppServerLiveExecutorMethod::TurnStart],
        notification_count: 0,
        server_request_count: 0,
        cleanup_status: CodexAppServerLiveExecutorCleanupStatus::NotRequired,
        evidence_refs: run.boundary.evidence_refs.clone(),
        provider_write_executed: false,
    }
}
