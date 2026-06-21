//! Durable dispatch invocation preflight records.
//!
//! These records decide whether an accepted durable dispatch admission may
//! proceed toward executor invocation. Preflight does not invoke an executor,
//! execute provider writes, retain raw material, or mutate task state.

mod blockers;
mod helpers;
mod types;

pub use types::{
    DurableDispatchInvocationPreflightBlocker, DurableDispatchInvocationPreflightId,
    DurableDispatchInvocationPreflightInput, DurableDispatchInvocationPreflightRecord,
    DurableDispatchInvocationPreflightStatus,
};

use blockers::preflight_blockers;
use helpers::unique_sorted;

/// Build durable dispatch invocation preflight without executing provider I/O.
pub fn durable_dispatch_invocation_preflight(
    input: DurableDispatchInvocationPreflightInput,
) -> DurableDispatchInvocationPreflightRecord {
    let blockers = preflight_blockers(&input);
    let status = if blockers.is_empty() {
        DurableDispatchInvocationPreflightStatus::AcceptedForInvocationRequest
    } else {
        DurableDispatchInvocationPreflightStatus::Blocked
    };
    let mut evidence_refs = input.admission.evidence_refs.clone();
    evidence_refs.extend(input.provider_ready_evidence_refs);
    evidence_refs.extend(input.runtime_session_evidence_refs);
    evidence_refs.extend(input.invocation_evidence_refs);
    if let Some(operator_confirmation_ref) = input.operator_confirmation_ref.as_ref() {
        evidence_refs.push(operator_confirmation_ref.clone());
    }

    DurableDispatchInvocationPreflightRecord {
        preflight_id: DurableDispatchInvocationPreflightId(format!(
            "durable-dispatch-invocation-preflight:{}",
            input.admission.dispatch_attempt_id
        )),
        admission_id: input.admission.admission_id.0,
        selection_id: input.admission.selection_id,
        command_id: input.admission.command_id,
        dispatch_attempt_id: input.admission.dispatch_attempt_id,
        lane: input.admission.lane,
        lane_admission_id: input.admission.lane_admission_id,
        provider_instance_id: input.admission.provider_instance_id,
        runtime_session_ref: input.admission.runtime_session_ref,
        write_attempt_id: input.write_attempt_id,
        idempotency_key: input.idempotency_key,
        task_id: input.admission.task_id,
        work_item_id: input.admission.work_item_id,
        method: input.admission.method,
        status,
        blockers,
        evidence_refs: unique_sorted(evidence_refs),
        operator_confirmation_ref: input.operator_confirmation_ref,
        executor_invoked: false,
        provider_write_executed: false,
        client_authority_granted: false,
        raw_provider_material_retained: false,
        raw_callback_material_retained: false,
        task_mutation_permitted: false,
        review_acceptance_permitted: false,
        callback_answer_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        replacement_thread_promotion_permitted: false,
        scm_mutation_permitted: false,
    }
}

#[cfg(test)]
mod tests;
