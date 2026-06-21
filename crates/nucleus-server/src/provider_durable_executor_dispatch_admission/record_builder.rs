use super::blockers::admission_blockers;
use super::helpers::unique_sorted;
use super::types::{
    DurableProviderExecutorDispatchAdmissionId, DurableProviderExecutorDispatchAdmissionInput,
    DurableProviderExecutorDispatchAdmissionRecord, DurableProviderExecutorDispatchAdmissionStatus,
};

/// Admit a selected durable executor command to dispatch without execution.
pub fn durable_provider_executor_dispatch_admission(
    input: DurableProviderExecutorDispatchAdmissionInput,
) -> DurableProviderExecutorDispatchAdmissionRecord {
    let blockers = admission_blockers(&input);
    let status = if blockers.is_empty() {
        DurableProviderExecutorDispatchAdmissionStatus::AcceptedForDispatch
    } else {
        DurableProviderExecutorDispatchAdmissionStatus::Blocked
    };
    let mut evidence_refs = input.selection.evidence_refs.clone();
    evidence_refs.extend(input.runtime_session_evidence_refs);
    evidence_refs.extend(input.provider_ready_evidence_refs);
    evidence_refs.extend(input.admission_evidence_refs);
    if let Some(operator_confirmation_ref) = input.operator_confirmation_ref.as_ref() {
        evidence_refs.push(operator_confirmation_ref.clone());
    }

    DurableProviderExecutorDispatchAdmissionRecord {
        admission_id: DurableProviderExecutorDispatchAdmissionId(format!(
            "durable-provider-executor-dispatch-admission:{}",
            input.dispatch_attempt_id
        )),
        selection_id: input.selection.selection_id.0,
        command_id: input.selection.command_id,
        dispatch_attempt_id: input.dispatch_attempt_id,
        lane: input.selection.lane,
        lane_admission_id: input.selection.lane_admission_id,
        provider_instance_id: input.selection.provider_instance_id,
        runtime_session_ref: input.selection.runtime_session_ref,
        write_attempt_id: input.write_attempt_id,
        idempotency_key: input.idempotency_key,
        task_id: input.selection.task_id,
        work_item_id: input.selection.work_item_id,
        method: input.selection.method,
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
