//! Codex callback response executor admission records.
//!
//! These records preserve the identity needed to hand an approved callback
//! response toward execution. They do not invoke the executor, write to the
//! provider, retain raw callback material, mutate tasks, or accept review.

use super::{
    CodexAppServerCallbackResponseExecutionPolicyRecord,
    CodexAppServerCallbackResponseExecutionPolicyStatus,
};
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptId, ProviderTransportWriteIdempotencyKey,
};

/// Stable id for one callback response executor admission record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerCallbackResponseExecutorAdmissionId(pub String);

/// Input for callback-response-to-executor admission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerCallbackResponseExecutorAdmissionInput {
    pub policy: CodexAppServerCallbackResponseExecutionPolicyRecord,
    pub request_id: String,
    pub callback_response_id: String,
    pub envelope_id: String,
    pub provider_callback_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub callback_response_write_attempt_id: ProviderTransportWriteAttemptId,
    pub idempotency_key: ProviderTransportWriteIdempotencyKey,
    pub evidence_refs: Vec<String>,
    pub invoke_executor_requested: bool,
    pub raw_callback_material_requested: bool,
    pub task_mutation_requested: bool,
    pub review_acceptance_requested: bool,
}

/// Admission record for a callback response entering executor handoff.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerCallbackResponseExecutorAdmissionRecord {
    pub admission_id: CodexAppServerCallbackResponseExecutorAdmissionId,
    pub policy_id: String,
    pub request_id: String,
    pub callback_response_id: String,
    pub envelope_id: String,
    pub provider_callback_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub callback_response_write_attempt_id: ProviderTransportWriteAttemptId,
    pub idempotency_key: ProviderTransportWriteIdempotencyKey,
    pub status: CodexAppServerCallbackResponseExecutorAdmissionStatus,
    pub blockers: Vec<CodexAppServerCallbackResponseExecutorAdmissionBlocker>,
    pub evidence_refs: Vec<String>,
    pub executor_invoked: bool,
    pub provider_write_executed: bool,
    pub raw_callback_material_retained: bool,
    pub task_mutation_permitted: bool,
    pub review_acceptance_permitted: bool,
}

/// Admission status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerCallbackResponseExecutorAdmissionStatus {
    AcceptedForExecutorHandoff,
    Blocked,
}

/// Why callback response executor admission is blocked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerCallbackResponseExecutorAdmissionBlocker {
    PolicyNotAccepted,
    MissingRequestId,
    MissingCallbackResponseId,
    MissingEnvelopeId,
    MissingProviderCallbackId,
    MissingTaskId,
    MissingWorkItemId,
    MissingProviderInstanceId,
    MissingRuntimeSessionRef,
    MissingCallbackResponseWriteAttemptId,
    MissingIdempotencyKey,
    RequestPolicyMismatch,
    CallbackResponsePolicyMismatch,
    EnvelopePolicyMismatch,
    ProviderCallbackPolicyMismatch,
    TaskPolicyMismatch,
    WorkItemPolicyMismatch,
    ProviderInstancePolicyMismatch,
    RuntimeSessionPolicyMismatch,
    PolicyAlreadyExecutedProviderWrite,
    PolicyPermitsForbiddenAuthority,
    ExecutorInvocationRequested,
    RawCallbackMaterialRequested,
    TaskMutationRequested,
    ReviewAcceptanceRequested,
}

/// Admit or block a callback response before executor handoff.
pub fn admit_codex_callback_response_executor(
    input: CodexAppServerCallbackResponseExecutorAdmissionInput,
) -> CodexAppServerCallbackResponseExecutorAdmissionRecord {
    let mut blockers = Vec::new();
    let mut evidence_refs = input.policy.evidence_refs.clone();
    evidence_refs.extend(input.evidence_refs.iter().cloned());

    validate_policy(&input, &mut blockers);
    validate_identity(&input, &mut blockers);
    validate_identity_match(&input, &mut blockers);
    validate_inspect_only_requests(&input, &mut blockers);

    evidence_refs.sort();
    evidence_refs.dedup();

    let status = if blockers.is_empty() {
        CodexAppServerCallbackResponseExecutorAdmissionStatus::AcceptedForExecutorHandoff
    } else {
        CodexAppServerCallbackResponseExecutorAdmissionStatus::Blocked
    };

    CodexAppServerCallbackResponseExecutorAdmissionRecord {
        admission_id: CodexAppServerCallbackResponseExecutorAdmissionId(format!(
            "codex-callback-response-executor-admission:{}:{}",
            input.request_id, input.callback_response_write_attempt_id.0
        )),
        policy_id: input.policy.policy_id.0,
        request_id: input.request_id,
        callback_response_id: input.callback_response_id,
        envelope_id: input.envelope_id,
        provider_callback_id: input.provider_callback_id,
        task_id: input.task_id,
        work_item_id: input.work_item_id,
        provider_instance_id: input.provider_instance_id,
        runtime_session_ref: input.runtime_session_ref,
        callback_response_write_attempt_id: input.callback_response_write_attempt_id,
        idempotency_key: input.idempotency_key,
        status,
        blockers,
        evidence_refs,
        executor_invoked: false,
        provider_write_executed: false,
        raw_callback_material_retained: false,
        task_mutation_permitted: false,
        review_acceptance_permitted: false,
    }
}

fn validate_policy(
    input: &CodexAppServerCallbackResponseExecutorAdmissionInput,
    blockers: &mut Vec<CodexAppServerCallbackResponseExecutorAdmissionBlocker>,
) {
    if input.policy.status
        != CodexAppServerCallbackResponseExecutionPolicyStatus::AcceptedForExecutionAdmission
    {
        blockers.push(CodexAppServerCallbackResponseExecutorAdmissionBlocker::PolicyNotAccepted);
    }
    if input.policy.provider_write_executed {
        blockers.push(
            CodexAppServerCallbackResponseExecutorAdmissionBlocker::PolicyAlreadyExecutedProviderWrite,
        );
    }
    if input.policy.automatic_callback_answer_permitted
        || input.policy.task_completion_permitted
        || input.policy.review_acceptance_permitted
        || input.policy.cancellation_permitted
        || input.policy.resume_permitted
        || input.policy.scm_mutation_permitted
        || input.policy.raw_callback_material_retained
    {
        blockers.push(
            CodexAppServerCallbackResponseExecutorAdmissionBlocker::PolicyPermitsForbiddenAuthority,
        );
    }
}

fn validate_identity(
    input: &CodexAppServerCallbackResponseExecutorAdmissionInput,
    blockers: &mut Vec<CodexAppServerCallbackResponseExecutorAdmissionBlocker>,
) {
    if input.request_id.is_empty() {
        blockers.push(CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingRequestId);
    }
    if input.callback_response_id.is_empty() {
        blockers.push(
            CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingCallbackResponseId,
        );
    }
    if input.envelope_id.is_empty() {
        blockers.push(CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingEnvelopeId);
    }
    if input.provider_callback_id.is_empty() {
        blockers.push(
            CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingProviderCallbackId,
        );
    }
    if input.task_id.is_empty() {
        blockers.push(CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingTaskId);
    }
    if input.work_item_id.is_empty() {
        blockers.push(CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingWorkItemId);
    }
    if input.provider_instance_id.is_empty() {
        blockers.push(
            CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingProviderInstanceId,
        );
    }
    if input.runtime_session_ref.is_empty() {
        blockers
            .push(CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingRuntimeSessionRef);
    }
    if input.callback_response_write_attempt_id.0.is_empty() {
        blockers.push(
            CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingCallbackResponseWriteAttemptId,
        );
    }
    if input.idempotency_key.0.is_empty() {
        blockers
            .push(CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingIdempotencyKey);
    }
}

fn validate_identity_match(
    input: &CodexAppServerCallbackResponseExecutorAdmissionInput,
    blockers: &mut Vec<CodexAppServerCallbackResponseExecutorAdmissionBlocker>,
) {
    if input.request_id != input.policy.request_id {
        blockers
            .push(CodexAppServerCallbackResponseExecutorAdmissionBlocker::RequestPolicyMismatch);
    }
    if input.callback_response_id != input.policy.admission_id {
        blockers.push(
            CodexAppServerCallbackResponseExecutorAdmissionBlocker::CallbackResponsePolicyMismatch,
        );
    }
    if input.envelope_id != input.policy.envelope_id {
        blockers
            .push(CodexAppServerCallbackResponseExecutorAdmissionBlocker::EnvelopePolicyMismatch);
    }
    if input.provider_callback_id != input.policy.provider_callback_id {
        blockers.push(
            CodexAppServerCallbackResponseExecutorAdmissionBlocker::ProviderCallbackPolicyMismatch,
        );
    }
    if input.task_id != input.policy.task_id {
        blockers.push(CodexAppServerCallbackResponseExecutorAdmissionBlocker::TaskPolicyMismatch);
    }
    if input.work_item_id != input.policy.work_item_id {
        blockers
            .push(CodexAppServerCallbackResponseExecutorAdmissionBlocker::WorkItemPolicyMismatch);
    }
    if input.provider_instance_id != input.policy.provider_instance_id {
        blockers.push(
            CodexAppServerCallbackResponseExecutorAdmissionBlocker::ProviderInstancePolicyMismatch,
        );
    }
    if Some(input.runtime_session_ref.as_str()) != input.policy.runtime_session_ref.as_deref() {
        blockers.push(
            CodexAppServerCallbackResponseExecutorAdmissionBlocker::RuntimeSessionPolicyMismatch,
        );
    }
}

fn validate_inspect_only_requests(
    input: &CodexAppServerCallbackResponseExecutorAdmissionInput,
    blockers: &mut Vec<CodexAppServerCallbackResponseExecutorAdmissionBlocker>,
) {
    if input.invoke_executor_requested {
        blockers.push(
            CodexAppServerCallbackResponseExecutorAdmissionBlocker::ExecutorInvocationRequested,
        );
    }
    if input.raw_callback_material_requested {
        blockers.push(
            CodexAppServerCallbackResponseExecutorAdmissionBlocker::RawCallbackMaterialRequested,
        );
    }
    if input.task_mutation_requested {
        blockers
            .push(CodexAppServerCallbackResponseExecutorAdmissionBlocker::TaskMutationRequested);
    }
    if input.review_acceptance_requested {
        blockers.push(
            CodexAppServerCallbackResponseExecutorAdmissionBlocker::ReviewAcceptanceRequested,
        );
    }
}

#[cfg(test)]
mod tests;
