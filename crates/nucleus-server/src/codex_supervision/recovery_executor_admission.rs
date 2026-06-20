//! Codex recovery executor admission records.
//!
//! These records preserve the identity needed to hand an approved recovery
//! toward execution. They do not invoke the executor, write to the provider,
//! promote replacement threads, retain raw provider material, mutate tasks,
//! accept reviews, answer callbacks, interrupt turns, or mutate SCM state.

use super::{
    CodexAppServerRecoveryExecutionPolicyRecord, CodexAppServerRecoveryExecutionPolicyStatus,
};
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptId, ProviderTransportWriteIdempotencyKey,
};

/// Stable id for one recovery executor admission record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerRecoveryExecutorAdmissionId(pub String);

/// Input for recovery-to-executor admission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerRecoveryExecutorAdmissionInput {
    pub policy: CodexAppServerRecoveryExecutionPolicyRecord,
    pub need_id: String,
    pub envelope_id: String,
    pub provider_thread_id: String,
    pub provider_turn_id: Option<String>,
    pub provider_request_id: Option<String>,
    pub task_id: String,
    pub work_item_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub recovery_write_attempt_id: ProviderTransportWriteAttemptId,
    pub idempotency_key: ProviderTransportWriteIdempotencyKey,
    pub evidence_refs: Vec<String>,
    pub invoke_executor_requested: bool,
    pub raw_provider_material_requested: bool,
    pub raw_callback_material_requested: bool,
    pub task_mutation_requested: bool,
    pub review_acceptance_requested: bool,
    pub replacement_thread_promotion_requested: bool,
    pub interruption_requested: bool,
    pub callback_answer_requested: bool,
    pub scm_mutation_requested: bool,
}

/// Admission record for a recovery entering executor handoff.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerRecoveryExecutorAdmissionRecord {
    pub admission_id: CodexAppServerRecoveryExecutorAdmissionId,
    pub policy_id: String,
    pub need_id: String,
    pub envelope_id: String,
    pub provider_thread_id: String,
    pub provider_turn_id: Option<String>,
    pub provider_request_id: Option<String>,
    pub task_id: String,
    pub work_item_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub recovery_write_attempt_id: ProviderTransportWriteAttemptId,
    pub idempotency_key: ProviderTransportWriteIdempotencyKey,
    pub status: CodexAppServerRecoveryExecutorAdmissionStatus,
    pub blockers: Vec<CodexAppServerRecoveryExecutorAdmissionBlocker>,
    pub evidence_refs: Vec<String>,
    pub executor_invoked: bool,
    pub provider_write_executed: bool,
    pub raw_provider_material_retained: bool,
    pub raw_callback_material_retained: bool,
    pub task_mutation_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub replacement_thread_promotion_permitted: bool,
    pub interruption_permitted: bool,
    pub callback_answer_permitted: bool,
    pub scm_mutation_permitted: bool,
}

/// Admission status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerRecoveryExecutorAdmissionStatus {
    AcceptedForExecutorHandoff,
    Blocked,
}

/// Why recovery executor admission is blocked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerRecoveryExecutorAdmissionBlocker {
    PolicyNotAccepted,
    MissingNeedId,
    MissingEnvelopeId,
    MissingProviderThreadId,
    EmptyProviderTurnId,
    EmptyProviderRequestId,
    MissingTaskId,
    MissingWorkItemId,
    MissingProviderInstanceId,
    MissingRuntimeSessionRef,
    MissingRecoveryWriteAttemptId,
    MissingIdempotencyKey,
    NeedPolicyMismatch,
    EnvelopePolicyMismatch,
    ProviderThreadPolicyMismatch,
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
    ReplacementThreadPromotionRequested,
    InterruptionRequested,
    CallbackAnswerRequested,
    ScmMutationRequested,
}

/// Admit or block a recovery before executor handoff.
pub fn admit_codex_recovery_executor(
    input: CodexAppServerRecoveryExecutorAdmissionInput,
) -> CodexAppServerRecoveryExecutorAdmissionRecord {
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
        CodexAppServerRecoveryExecutorAdmissionStatus::AcceptedForExecutorHandoff
    } else {
        CodexAppServerRecoveryExecutorAdmissionStatus::Blocked
    };

    CodexAppServerRecoveryExecutorAdmissionRecord {
        admission_id: CodexAppServerRecoveryExecutorAdmissionId(format!(
            "codex-recovery-executor-admission:{}:{}",
            input.need_id, input.recovery_write_attempt_id.0
        )),
        policy_id: input.policy.policy_id.0,
        need_id: input.need_id,
        envelope_id: input.envelope_id,
        provider_thread_id: input.provider_thread_id,
        provider_turn_id: input.provider_turn_id,
        provider_request_id: input.provider_request_id,
        task_id: input.task_id,
        work_item_id: input.work_item_id,
        provider_instance_id: input.provider_instance_id,
        runtime_session_ref: input.runtime_session_ref,
        recovery_write_attempt_id: input.recovery_write_attempt_id,
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
        replacement_thread_promotion_permitted: false,
        interruption_permitted: false,
        callback_answer_permitted: false,
        scm_mutation_permitted: false,
    }
}

fn validate_policy(
    input: &CodexAppServerRecoveryExecutorAdmissionInput,
    blockers: &mut Vec<CodexAppServerRecoveryExecutorAdmissionBlocker>,
) {
    if input.policy.status
        != CodexAppServerRecoveryExecutionPolicyStatus::AcceptedForExecutionAdmission
    {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::PolicyNotAccepted);
    }
    if input.policy.provider_write_executed {
        blockers.push(
            CodexAppServerRecoveryExecutorAdmissionBlocker::PolicyAlreadyExecutedProviderWrite,
        );
    }
    if input.policy.automatic_resume_permitted
        || input.policy.replacement_thread_promotion_permitted
        || input.policy.task_completion_permitted
        || input.policy.review_acceptance_permitted
        || input.policy.interruption_permitted
        || input.policy.callback_answer_permitted
        || input.policy.scm_mutation_permitted
        || input.policy.raw_provider_material_retained
        || input.policy.raw_callback_material_retained
    {
        blockers
            .push(CodexAppServerRecoveryExecutorAdmissionBlocker::PolicyPermitsForbiddenAuthority);
    }
}

fn validate_identity(
    input: &CodexAppServerRecoveryExecutorAdmissionInput,
    blockers: &mut Vec<CodexAppServerRecoveryExecutorAdmissionBlocker>,
) {
    if input.need_id.is_empty() {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::MissingNeedId);
    }
    if input.envelope_id.is_empty() {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::MissingEnvelopeId);
    }
    if input.provider_thread_id.is_empty() {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::MissingProviderThreadId);
    }
    if input.provider_turn_id.as_deref() == Some("") {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::EmptyProviderTurnId);
    }
    if input.provider_request_id.as_deref() == Some("") {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::EmptyProviderRequestId);
    }
    if input.task_id.is_empty() {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::MissingTaskId);
    }
    if input.work_item_id.is_empty() {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::MissingWorkItemId);
    }
    if input.provider_instance_id.is_empty() {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::MissingProviderInstanceId);
    }
    if input.runtime_session_ref.is_empty() {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::MissingRuntimeSessionRef);
    }
    if input.recovery_write_attempt_id.0.is_empty() {
        blockers
            .push(CodexAppServerRecoveryExecutorAdmissionBlocker::MissingRecoveryWriteAttemptId);
    }
    if input.idempotency_key.0.is_empty() {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::MissingIdempotencyKey);
    }
}

fn validate_identity_match(
    input: &CodexAppServerRecoveryExecutorAdmissionInput,
    blockers: &mut Vec<CodexAppServerRecoveryExecutorAdmissionBlocker>,
) {
    if input.need_id != input.policy.need_id {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::NeedPolicyMismatch);
    }
    if input.envelope_id != input.policy.envelope_id {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::EnvelopePolicyMismatch);
    }
    if input.provider_thread_id != input.policy.provider_thread_id {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::ProviderThreadPolicyMismatch);
    }
    if input.provider_turn_id != input.policy.provider_turn_id {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::ProviderTurnPolicyMismatch);
    }
    if input.provider_request_id != input.policy.provider_request_id {
        blockers
            .push(CodexAppServerRecoveryExecutorAdmissionBlocker::ProviderRequestPolicyMismatch);
    }
    if input.task_id != input.policy.task_id {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::TaskPolicyMismatch);
    }
    if input.work_item_id != input.policy.work_item_id {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::WorkItemPolicyMismatch);
    }
    if input.provider_instance_id != input.policy.provider_instance_id {
        blockers
            .push(CodexAppServerRecoveryExecutorAdmissionBlocker::ProviderInstancePolicyMismatch);
    }
    if Some(input.runtime_session_ref.as_str()) != input.policy.runtime_session_ref.as_deref() {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::RuntimeSessionPolicyMismatch);
    }
}

fn validate_inspect_only_requests(
    input: &CodexAppServerRecoveryExecutorAdmissionInput,
    blockers: &mut Vec<CodexAppServerRecoveryExecutorAdmissionBlocker>,
) {
    if input.invoke_executor_requested {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::ExecutorInvocationRequested);
    }
    if input.raw_provider_material_requested {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::RawProviderMaterialRequested);
    }
    if input.raw_callback_material_requested {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::RawCallbackMaterialRequested);
    }
    if input.task_mutation_requested {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::TaskMutationRequested);
    }
    if input.review_acceptance_requested {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::ReviewAcceptanceRequested);
    }
    if input.replacement_thread_promotion_requested {
        blockers.push(
            CodexAppServerRecoveryExecutorAdmissionBlocker::ReplacementThreadPromotionRequested,
        );
    }
    if input.interruption_requested {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::InterruptionRequested);
    }
    if input.callback_answer_requested {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::CallbackAnswerRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(CodexAppServerRecoveryExecutorAdmissionBlocker::ScmMutationRequested);
    }
}

#[cfg(test)]
mod tests;
