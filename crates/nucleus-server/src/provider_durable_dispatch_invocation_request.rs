//! Durable dispatch invocation request records.
//!
//! These records capture a preflight-approved request to invoke the durable
//! provider executor. They still do not invoke the executor or write to the
//! provider transport.

use serde::{Deserialize, Serialize};

use crate::{
    DurableDispatchInvocationPreflightRecord, DurableDispatchInvocationPreflightStatus,
    DurableProviderExecutorLane, DurableProviderExecutorMethod,
};

/// Stable id for one durable dispatch invocation request.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct DurableDispatchInvocationRequestId(pub String);

/// Input for building a durable dispatch invocation request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableDispatchInvocationRequestInput {
    pub preflight: DurableDispatchInvocationPreflightRecord,
    pub invocation_request_evidence_refs: Vec<String>,
    pub executor_invocation_requested: bool,
    pub background_execution_requested: bool,
    pub provider_write_requested: bool,
    pub raw_provider_material_requested: bool,
    pub raw_callback_material_requested: bool,
    pub task_mutation_requested: bool,
    pub review_acceptance_requested: bool,
    pub callback_answer_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
    pub replacement_thread_promotion_requested: bool,
    pub scm_mutation_requested: bool,
}

/// Durable dispatch invocation request record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableDispatchInvocationRequestRecord {
    pub request_id: DurableDispatchInvocationRequestId,
    pub preflight_id: String,
    pub admission_id: String,
    pub selection_id: String,
    pub command_id: String,
    pub dispatch_attempt_id: String,
    pub lane: DurableProviderExecutorLane,
    pub lane_admission_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub task_id: Option<String>,
    pub work_item_id: Option<String>,
    pub method: DurableProviderExecutorMethod,
    pub status: DurableDispatchInvocationRequestStatus,
    pub blockers: Vec<DurableDispatchInvocationRequestBlocker>,
    pub evidence_refs: Vec<String>,
    pub operator_confirmation_ref: Option<String>,
    pub executor_invoked: bool,
    pub provider_write_executed: bool,
    pub client_authority_granted: bool,
    pub raw_provider_material_retained: bool,
    pub raw_callback_material_retained: bool,
    pub task_mutation_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub callback_answer_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub replacement_thread_promotion_permitted: bool,
    pub scm_mutation_permitted: bool,
}

/// Invocation request status.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableDispatchInvocationRequestStatus {
    AcceptedForExecutorHandoff,
    Blocked,
}

/// Why invocation request construction is blocked.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableDispatchInvocationRequestBlocker {
    PreflightNotAccepted,
    PreflightAlreadyInvokedExecutor,
    PreflightPermitsForbiddenAuthority,
    MissingInvocationRequestEvidence,
    ExecutorInvocationRequested,
    BackgroundExecutionRequested,
    ProviderWriteRequested,
    RawProviderMaterialRequested,
    RawCallbackMaterialRequested,
    TaskMutationRequested,
    ReviewAcceptanceRequested,
    CallbackAnswerRequested,
    InterruptionRequested,
    RecoveryRequested,
    ReplacementThreadPromotionRequested,
    ScmMutationRequested,
}

/// Build a durable invocation request without invoking the executor.
pub fn durable_dispatch_invocation_request(
    input: DurableDispatchInvocationRequestInput,
) -> DurableDispatchInvocationRequestRecord {
    let blockers = request_blockers(&input);
    let status = if blockers.is_empty() {
        DurableDispatchInvocationRequestStatus::AcceptedForExecutorHandoff
    } else {
        DurableDispatchInvocationRequestStatus::Blocked
    };
    let mut evidence_refs = input.preflight.evidence_refs.clone();
    evidence_refs.extend(input.invocation_request_evidence_refs);

    DurableDispatchInvocationRequestRecord {
        request_id: DurableDispatchInvocationRequestId(format!(
            "durable-dispatch-invocation-request:{}:{}",
            input.preflight.dispatch_attempt_id, input.preflight.write_attempt_id
        )),
        preflight_id: input.preflight.preflight_id.0,
        admission_id: input.preflight.admission_id,
        selection_id: input.preflight.selection_id,
        command_id: input.preflight.command_id,
        dispatch_attempt_id: input.preflight.dispatch_attempt_id,
        lane: input.preflight.lane,
        lane_admission_id: input.preflight.lane_admission_id,
        provider_instance_id: input.preflight.provider_instance_id,
        runtime_session_ref: input.preflight.runtime_session_ref,
        write_attempt_id: input.preflight.write_attempt_id,
        idempotency_key: input.preflight.idempotency_key,
        task_id: input.preflight.task_id,
        work_item_id: input.preflight.work_item_id,
        method: input.preflight.method,
        status,
        blockers,
        evidence_refs: unique_sorted(evidence_refs),
        operator_confirmation_ref: input.preflight.operator_confirmation_ref,
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

fn request_blockers(
    input: &DurableDispatchInvocationRequestInput,
) -> Vec<DurableDispatchInvocationRequestBlocker> {
    let mut blockers = Vec::new();

    if input.preflight.status
        != DurableDispatchInvocationPreflightStatus::AcceptedForInvocationRequest
    {
        blockers.push(DurableDispatchInvocationRequestBlocker::PreflightNotAccepted);
    }
    if input.preflight.executor_invoked || input.preflight.provider_write_executed {
        blockers.push(DurableDispatchInvocationRequestBlocker::PreflightAlreadyInvokedExecutor);
    }
    if preflight_permits_forbidden_authority(&input.preflight) {
        blockers.push(DurableDispatchInvocationRequestBlocker::PreflightPermitsForbiddenAuthority);
    }
    if input.invocation_request_evidence_refs.is_empty()
        || input
            .invocation_request_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers.push(DurableDispatchInvocationRequestBlocker::MissingInvocationRequestEvidence);
    }
    authority_blockers(input, &mut blockers);

    blockers
}

fn preflight_permits_forbidden_authority(
    preflight: &DurableDispatchInvocationPreflightRecord,
) -> bool {
    preflight.client_authority_granted
        || preflight.raw_provider_material_retained
        || preflight.raw_callback_material_retained
        || preflight.task_mutation_permitted
        || preflight.review_acceptance_permitted
        || preflight.callback_answer_permitted
        || preflight.interruption_permitted
        || preflight.recovery_permitted
        || preflight.replacement_thread_promotion_permitted
        || preflight.scm_mutation_permitted
}

fn authority_blockers(
    input: &DurableDispatchInvocationRequestInput,
    blockers: &mut Vec<DurableDispatchInvocationRequestBlocker>,
) {
    if input.executor_invocation_requested {
        blockers.push(DurableDispatchInvocationRequestBlocker::ExecutorInvocationRequested);
    }
    if input.background_execution_requested {
        blockers.push(DurableDispatchInvocationRequestBlocker::BackgroundExecutionRequested);
    }
    if input.provider_write_requested {
        blockers.push(DurableDispatchInvocationRequestBlocker::ProviderWriteRequested);
    }
    if input.raw_provider_material_requested {
        blockers.push(DurableDispatchInvocationRequestBlocker::RawProviderMaterialRequested);
    }
    if input.raw_callback_material_requested {
        blockers.push(DurableDispatchInvocationRequestBlocker::RawCallbackMaterialRequested);
    }
    if input.task_mutation_requested {
        blockers.push(DurableDispatchInvocationRequestBlocker::TaskMutationRequested);
    }
    if input.review_acceptance_requested {
        blockers.push(DurableDispatchInvocationRequestBlocker::ReviewAcceptanceRequested);
    }
    if input.callback_answer_requested {
        blockers.push(DurableDispatchInvocationRequestBlocker::CallbackAnswerRequested);
    }
    if input.interruption_requested {
        blockers.push(DurableDispatchInvocationRequestBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(DurableDispatchInvocationRequestBlocker::RecoveryRequested);
    }
    if input.replacement_thread_promotion_requested {
        blockers.push(DurableDispatchInvocationRequestBlocker::ReplacementThreadPromotionRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(DurableDispatchInvocationRequestBlocker::ScmMutationRequested);
    }
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests;
