//! Durable provider executor dispatch selection records.
//!
//! These records identify durable executor commands that may be considered for
//! dispatch. Selection is read-only: it does not invoke an executor, perform a
//! provider write, retain raw material, or mutate project/task/provider state.

mod blockers;
mod helpers;
mod types;

pub use types::{
    DurableProviderExecutorDispatchSelectionBlocker, DurableProviderExecutorDispatchSelectionId,
    DurableProviderExecutorDispatchSelectionInput, DurableProviderExecutorDispatchSelectionRecord,
    DurableProviderExecutorDispatchSelectionStatus,
};

use blockers::selection_blockers;
use helpers::unique_sorted;

/// Select a durable executor command for possible dispatch admission.
pub fn durable_provider_executor_dispatch_selection(
    input: DurableProviderExecutorDispatchSelectionInput,
) -> DurableProviderExecutorDispatchSelectionRecord {
    let blockers = selection_blockers(&input);
    let status = if blockers.is_empty() {
        DurableProviderExecutorDispatchSelectionStatus::SelectedForDispatchAdmission
    } else {
        DurableProviderExecutorDispatchSelectionStatus::Blocked
    };
    let latest_status_state = input
        .latest_status
        .as_ref()
        .map(|record| record.state.clone());
    let mut evidence_refs = input.command.evidence_refs.clone();
    if let Some(latest_status) = input.latest_status {
        evidence_refs.extend(latest_status.evidence_refs);
    }
    evidence_refs.extend(input.provider_ready_evidence_refs);
    evidence_refs.extend(input.runtime_ready_evidence_refs);
    evidence_refs.extend(input.selection_evidence_refs);

    DurableProviderExecutorDispatchSelectionRecord {
        selection_id: DurableProviderExecutorDispatchSelectionId(format!(
            "durable-provider-executor-dispatch-selection:{}",
            input.command.command_id.0
        )),
        command_id: input.command.command_id.0,
        lane: input.command.lane,
        lane_admission_id: input.command.lane_admission_id,
        provider_instance_id: input.command.provider_instance_id,
        runtime_session_ref: input.command.runtime_session_ref,
        write_attempt_id: input.command.write_attempt_id,
        idempotency_key: input.command.idempotency_key,
        task_id: input.command.task_id,
        work_item_id: input.command.work_item_id,
        method: input.command.method,
        latest_status_state,
        status,
        blockers,
        evidence_refs: unique_sorted(evidence_refs),
        operator_confirmation_ref: input.command.operator_confirmation_ref,
        executor_invoked: false,
        provider_write_selected: false,
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
