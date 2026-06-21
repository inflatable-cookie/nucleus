use super::types::{
    ProviderCommandDispatchAttemptRecord, ProviderCommandDispatchAttemptStatus,
    ProviderCommandReactorOutcomeId, ProviderCommandReactorOutcomeRecord,
    ProviderCommandReactorOutcomeStatus,
};
use crate::provider_runtime_orchestration::{
    ProviderRuntimeOutcomeId, ProviderRuntimeOutcomeRecord, ProviderRuntimeOutcomeStatus,
};

/// Build a provider command outcome from a dispatch attempt.
pub fn provider_command_reactor_outcome(
    attempt: &ProviderCommandDispatchAttemptRecord,
) -> ProviderCommandReactorOutcomeRecord {
    let status = match &attempt.status {
        ProviderCommandDispatchAttemptStatus::DryRunCompleted => {
            ProviderCommandReactorOutcomeStatus::DryRunCompleted
        }
        ProviderCommandDispatchAttemptStatus::SkippedLiveSend(reason) => {
            ProviderCommandReactorOutcomeStatus::Blocked(reason.clone())
        }
        ProviderCommandDispatchAttemptStatus::Blocked(reason) => {
            ProviderCommandReactorOutcomeStatus::Blocked(reason.clone())
        }
    };

    ProviderCommandReactorOutcomeRecord {
        outcome_id: ProviderCommandReactorOutcomeId(format!(
            "provider-command-outcome:{}",
            attempt.command_id.0
        )),
        attempt_id: attempt.attempt_id.clone(),
        command_id: attempt.command_id.clone(),
        service_id: attempt.service_id.clone(),
        command_lane_id: attempt.command_lane_id.clone(),
        stream_id: attempt.stream_id.clone(),
        family: attempt.family.clone(),
        summary: outcome_summary(&status),
        status,
        live_send_attempted: attempt.live_send_attempted,
        task_mutation_permitted: false,
        evidence_refs: attempt.evidence_refs.clone(),
    }
}

/// Convert a reactor outcome into the provider runtime outcome surface.
pub fn provider_runtime_outcome_from_reactor_outcome(
    outcome: &ProviderCommandReactorOutcomeRecord,
) -> ProviderRuntimeOutcomeRecord {
    ProviderRuntimeOutcomeRecord {
        outcome_id: ProviderRuntimeOutcomeId(format!(
            "provider-runtime-outcome:{}",
            outcome.outcome_id.0
        )),
        service_id: outcome.service_id.clone(),
        command_lane_id: outcome.command_lane_id.clone(),
        stream_id: outcome.stream_id.clone(),
        command_family: outcome.family.clone(),
        status: runtime_status(&outcome.status),
        evidence_refs: outcome.evidence_refs.clone(),
        summary: outcome.summary.clone(),
        task_mutation_permitted: false,
    }
}

fn runtime_status(status: &ProviderCommandReactorOutcomeStatus) -> ProviderRuntimeOutcomeStatus {
    match status {
        ProviderCommandReactorOutcomeStatus::DryRunCompleted => {
            ProviderRuntimeOutcomeStatus::Completed
        }
        ProviderCommandReactorOutcomeStatus::Blocked(reason) => {
            ProviderRuntimeOutcomeStatus::Blocked(reason.clone())
        }
        ProviderCommandReactorOutcomeStatus::Unsupported(reason) => {
            ProviderRuntimeOutcomeStatus::Unsupported(reason.clone())
        }
        ProviderCommandReactorOutcomeStatus::Failed(reason) => {
            ProviderRuntimeOutcomeStatus::Failed(reason.clone())
        }
    }
}

fn outcome_summary(status: &ProviderCommandReactorOutcomeStatus) -> String {
    match status {
        ProviderCommandReactorOutcomeStatus::DryRunCompleted => {
            "provider command dry-run completed without live send".to_owned()
        }
        ProviderCommandReactorOutcomeStatus::Blocked(reason) => {
            format!("provider command blocked: {reason}")
        }
        ProviderCommandReactorOutcomeStatus::Unsupported(reason) => {
            format!("provider command unsupported: {reason}")
        }
        ProviderCommandReactorOutcomeStatus::Failed(reason) => {
            format!("provider command failed: {reason}")
        }
    }
}
