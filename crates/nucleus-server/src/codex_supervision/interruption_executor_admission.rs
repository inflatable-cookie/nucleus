//! Codex interruption executor admission records.
//!
//! These records preserve the identity needed to hand an approved interruption
//! toward execution. They do not invoke the executor, write to the provider,
//! retain raw provider material, recover sessions, mutate tasks, accept review,
//! answer callbacks, or mutate SCM state.

use super::{
    CodexAppServerInterruptionExecutionPolicyRecord,
    CodexAppServerInterruptionExecutionPolicyStatus,
};
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptId, ProviderTransportWriteIdempotencyKey,
};

/// Stable id for one interruption executor admission record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerInterruptionExecutorAdmissionId(pub String);

/// Input for interruption-to-executor admission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerInterruptionExecutorAdmissionInput {
    pub policy: CodexAppServerInterruptionExecutionPolicyRecord,
    pub request_id: String,
    pub envelope_id: String,
    pub provider_turn_id: String,
    pub provider_request_id: Option<String>,
    pub task_id: String,
    pub work_item_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub interruption_write_attempt_id: ProviderTransportWriteAttemptId,
    pub idempotency_key: ProviderTransportWriteIdempotencyKey,
    pub evidence_refs: Vec<String>,
    pub invoke_executor_requested: bool,
    pub raw_provider_material_requested: bool,
    pub raw_callback_material_requested: bool,
    pub task_mutation_requested: bool,
    pub review_acceptance_requested: bool,
    pub resume_requested: bool,
    pub callback_answer_requested: bool,
    pub scm_mutation_requested: bool,
}

/// Admission record for an interruption entering executor handoff.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerInterruptionExecutorAdmissionRecord {
    pub admission_id: CodexAppServerInterruptionExecutorAdmissionId,
    pub policy_id: String,
    pub request_id: String,
    pub envelope_id: String,
    pub provider_turn_id: String,
    pub provider_request_id: Option<String>,
    pub task_id: String,
    pub work_item_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub interruption_write_attempt_id: ProviderTransportWriteAttemptId,
    pub idempotency_key: ProviderTransportWriteIdempotencyKey,
    pub status: CodexAppServerInterruptionExecutorAdmissionStatus,
    pub blockers: Vec<CodexAppServerInterruptionExecutorAdmissionBlocker>,
    pub evidence_refs: Vec<String>,
    pub executor_invoked: bool,
    pub provider_write_executed: bool,
    pub raw_provider_material_retained: bool,
    pub raw_callback_material_retained: bool,
    pub task_mutation_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub resume_permitted: bool,
    pub callback_answer_permitted: bool,
    pub scm_mutation_permitted: bool,
}

/// Admission status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerInterruptionExecutorAdmissionStatus {
    AcceptedForExecutorHandoff,
    Blocked,
}

/// Why interruption executor admission is blocked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerInterruptionExecutorAdmissionBlocker {
    PolicyNotAccepted,
    MissingRequestId,
    MissingEnvelopeId,
    MissingProviderTurnId,
    EmptyProviderRequestId,
    MissingTaskId,
    MissingWorkItemId,
    MissingProviderInstanceId,
    MissingRuntimeSessionRef,
    MissingInterruptionWriteAttemptId,
    MissingIdempotencyKey,
    RequestPolicyMismatch,
    EnvelopePolicyMismatch,
    ProviderTurnPolicyMismatch,
    ProviderRequestPolicyMismatch,
    TaskPolicyMismatch,
    WorkItemPolicyMismatch,
    ProviderInstancePolicyMismatch,
    RuntimeSessionPolicyMismatch,
    PolicyAlreadyExecutedProviderWrite,
    PolicyPermitsForbiddenAuthority,
    ExecutorInvocationRequested,
    RawProviderMaterialRequested,
    RawCallbackMaterialRequested,
    TaskMutationRequested,
    ReviewAcceptanceRequested,
    ResumeRequested,
    CallbackAnswerRequested,
    ScmMutationRequested,
}

/// Admit or block an interruption before executor handoff.
pub fn admit_codex_interruption_executor(
    input: CodexAppServerInterruptionExecutorAdmissionInput,
) -> CodexAppServerInterruptionExecutorAdmissionRecord {
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
        CodexAppServerInterruptionExecutorAdmissionStatus::AcceptedForExecutorHandoff
    } else {
        CodexAppServerInterruptionExecutorAdmissionStatus::Blocked
    };

    CodexAppServerInterruptionExecutorAdmissionRecord {
        admission_id: CodexAppServerInterruptionExecutorAdmissionId(format!(
            "codex-interruption-executor-admission:{}:{}",
            input.request_id, input.interruption_write_attempt_id.0
        )),
        policy_id: input.policy.policy_id.0,
        request_id: input.request_id,
        envelope_id: input.envelope_id,
        provider_turn_id: input.provider_turn_id,
        provider_request_id: input.provider_request_id,
        task_id: input.task_id,
        work_item_id: input.work_item_id,
        provider_instance_id: input.provider_instance_id,
        runtime_session_ref: input.runtime_session_ref,
        interruption_write_attempt_id: input.interruption_write_attempt_id,
        idempotency_key: input.idempotency_key,
        status,
        blockers,
        evidence_refs,
        executor_invoked: false,
        provider_write_executed: false,
        raw_provider_material_retained: false,
        raw_callback_material_retained: false,
        task_mutation_permitted: false,
        review_acceptance_permitted: false,
        resume_permitted: false,
        callback_answer_permitted: false,
        scm_mutation_permitted: false,
    }
}

fn validate_policy(
    input: &CodexAppServerInterruptionExecutorAdmissionInput,
    blockers: &mut Vec<CodexAppServerInterruptionExecutorAdmissionBlocker>,
) {
    if input.policy.status
        != CodexAppServerInterruptionExecutionPolicyStatus::AcceptedForExecutionAdmission
    {
        blockers.push(CodexAppServerInterruptionExecutorAdmissionBlocker::PolicyNotAccepted);
    }
    if input.policy.provider_write_executed {
        blockers.push(
            CodexAppServerInterruptionExecutorAdmissionBlocker::PolicyAlreadyExecutedProviderWrite,
        );
    }
    if input.policy.automatic_interruption_permitted
        || input.policy.task_completion_permitted
        || input.policy.review_acceptance_permitted
        || input.policy.resume_permitted
        || input.policy.callback_answer_permitted
        || input.policy.scm_mutation_permitted
        || input.policy.raw_provider_material_retained
        || input.policy.raw_callback_material_retained
    {
        blockers.push(
            CodexAppServerInterruptionExecutorAdmissionBlocker::PolicyPermitsForbiddenAuthority,
        );
    }
}

fn validate_identity(
    input: &CodexAppServerInterruptionExecutorAdmissionInput,
    blockers: &mut Vec<CodexAppServerInterruptionExecutorAdmissionBlocker>,
) {
    if input.request_id.is_empty() {
        blockers.push(CodexAppServerInterruptionExecutorAdmissionBlocker::MissingRequestId);
    }
    if input.envelope_id.is_empty() {
        blockers.push(CodexAppServerInterruptionExecutorAdmissionBlocker::MissingEnvelopeId);
    }
    if input.provider_turn_id.is_empty() {
        blockers.push(CodexAppServerInterruptionExecutorAdmissionBlocker::MissingProviderTurnId);
    }
    if input.provider_request_id.as_deref() == Some("") {
        blockers.push(CodexAppServerInterruptionExecutorAdmissionBlocker::EmptyProviderRequestId);
    }
    if input.task_id.is_empty() {
        blockers.push(CodexAppServerInterruptionExecutorAdmissionBlocker::MissingTaskId);
    }
    if input.work_item_id.is_empty() {
        blockers.push(CodexAppServerInterruptionExecutorAdmissionBlocker::MissingWorkItemId);
    }
    if input.provider_instance_id.is_empty() {
        blockers
            .push(CodexAppServerInterruptionExecutorAdmissionBlocker::MissingProviderInstanceId);
    }
    if input.runtime_session_ref.is_empty() {
        blockers.push(CodexAppServerInterruptionExecutorAdmissionBlocker::MissingRuntimeSessionRef);
    }
    if input.interruption_write_attempt_id.0.is_empty() {
        blockers.push(
            CodexAppServerInterruptionExecutorAdmissionBlocker::MissingInterruptionWriteAttemptId,
        );
    }
    if input.idempotency_key.0.is_empty() {
        blockers.push(CodexAppServerInterruptionExecutorAdmissionBlocker::MissingIdempotencyKey);
    }
}

fn validate_identity_match(
    input: &CodexAppServerInterruptionExecutorAdmissionInput,
    blockers: &mut Vec<CodexAppServerInterruptionExecutorAdmissionBlocker>,
) {
    if input.request_id != input.policy.request_id {
        blockers.push(CodexAppServerInterruptionExecutorAdmissionBlocker::RequestPolicyMismatch);
    }
    if input.envelope_id != input.policy.envelope_id {
        blockers.push(CodexAppServerInterruptionExecutorAdmissionBlocker::EnvelopePolicyMismatch);
    }
    if input.provider_turn_id != input.policy.provider_turn_id {
        blockers
            .push(CodexAppServerInterruptionExecutorAdmissionBlocker::ProviderTurnPolicyMismatch);
    }
    if input.provider_request_id != input.policy.provider_request_id {
        blockers.push(
            CodexAppServerInterruptionExecutorAdmissionBlocker::ProviderRequestPolicyMismatch,
        );
    }
    if input.task_id != input.policy.task_id {
        blockers.push(CodexAppServerInterruptionExecutorAdmissionBlocker::TaskPolicyMismatch);
    }
    if input.work_item_id != input.policy.work_item_id {
        blockers.push(CodexAppServerInterruptionExecutorAdmissionBlocker::WorkItemPolicyMismatch);
    }
    if input.provider_instance_id != input.policy.provider_instance_id {
        blockers.push(
            CodexAppServerInterruptionExecutorAdmissionBlocker::ProviderInstancePolicyMismatch,
        );
    }
    if Some(input.runtime_session_ref.as_str()) != input.policy.runtime_session_ref.as_deref() {
        blockers
            .push(CodexAppServerInterruptionExecutorAdmissionBlocker::RuntimeSessionPolicyMismatch);
    }
}

fn validate_inspect_only_requests(
    input: &CodexAppServerInterruptionExecutorAdmissionInput,
    blockers: &mut Vec<CodexAppServerInterruptionExecutorAdmissionBlocker>,
) {
    if input.invoke_executor_requested {
        blockers
            .push(CodexAppServerInterruptionExecutorAdmissionBlocker::ExecutorInvocationRequested);
    }
    if input.raw_provider_material_requested {
        blockers
            .push(CodexAppServerInterruptionExecutorAdmissionBlocker::RawProviderMaterialRequested);
    }
    if input.raw_callback_material_requested {
        blockers
            .push(CodexAppServerInterruptionExecutorAdmissionBlocker::RawCallbackMaterialRequested);
    }
    if input.task_mutation_requested {
        blockers.push(CodexAppServerInterruptionExecutorAdmissionBlocker::TaskMutationRequested);
    }
    if input.review_acceptance_requested {
        blockers
            .push(CodexAppServerInterruptionExecutorAdmissionBlocker::ReviewAcceptanceRequested);
    }
    if input.resume_requested {
        blockers.push(CodexAppServerInterruptionExecutorAdmissionBlocker::ResumeRequested);
    }
    if input.callback_answer_requested {
        blockers.push(CodexAppServerInterruptionExecutorAdmissionBlocker::CallbackAnswerRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(CodexAppServerInterruptionExecutorAdmissionBlocker::ScmMutationRequested);
    }
}

#[cfg(test)]
mod tests;
