//! Task work to Codex live executor admission records.
//!
//! These records preserve the identity needed to hand a task work item toward
//! the live executor. They do not invoke the executor, write to the provider,
//! retain raw provider material, or mutate task/review state.

use super::{
    CodexAppServerTaskBackedLiveExecutionPolicyRecord,
    CodexAppServerTaskBackedLiveExecutionPolicyStatus,
};
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptId, ProviderTransportWriteIdempotencyKey,
};

use nucleus_engine::EngineTaskWorkItemId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

/// Stable id for one task work live executor admission record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerTaskWorkLiveExecutorAdmissionId(pub String);

/// Input for task-work-to-live-executor admission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTaskWorkLiveExecutorAdmissionInput {
    pub policy: CodexAppServerTaskBackedLiveExecutionPolicyRecord,
    pub work_item_id: EngineTaskWorkItemId,
    pub task_id: TaskId,
    pub project_id: ProjectId,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub live_executor_write_attempt_id: ProviderTransportWriteAttemptId,
    pub idempotency_key: ProviderTransportWriteIdempotencyKey,
    pub evidence_refs: Vec<String>,
    pub invoke_executor_requested: bool,
    pub raw_provider_material_requested: bool,
    pub task_mutation_requested: bool,
}

/// Admission record for a task work item entering live executor handoff.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTaskWorkLiveExecutorAdmissionRecord {
    pub admission_id: CodexAppServerTaskWorkLiveExecutorAdmissionId,
    pub policy_id: String,
    pub work_item_id: EngineTaskWorkItemId,
    pub task_id: TaskId,
    pub project_id: ProjectId,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub live_executor_write_attempt_id: ProviderTransportWriteAttemptId,
    pub idempotency_key: ProviderTransportWriteIdempotencyKey,
    pub status: CodexAppServerTaskWorkLiveExecutorAdmissionStatus,
    pub blockers: Vec<CodexAppServerTaskWorkLiveExecutorAdmissionBlocker>,
    pub evidence_refs: Vec<String>,
    pub executor_invoked: bool,
    pub provider_write_executed: bool,
    pub raw_provider_material_retained: bool,
    pub task_mutation_permitted: bool,
    pub review_acceptance_permitted: bool,
}

/// Admission status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTaskWorkLiveExecutorAdmissionStatus {
    AcceptedForExecutorHandoff,
    Blocked,
}

/// Why task work live executor admission is blocked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTaskWorkLiveExecutorAdmissionBlocker {
    PolicyNotAccepted,
    MissingWorkItemId,
    MissingTaskId,
    MissingProjectId,
    MissingProviderInstanceId,
    MissingRuntimeSessionRef,
    MissingLiveExecutorWriteAttemptId,
    MissingIdempotencyKey,
    WorkItemPolicyMismatch,
    TaskPolicyMismatch,
    ProjectPolicyMismatch,
    ProviderInstancePolicyMismatch,
    RuntimeSessionPolicyMismatch,
    PolicyAlreadyExecutedProviderWrite,
    PolicyPermitsForbiddenAuthority,
    ExecutorInvocationRequested,
    RawProviderMaterialRequested,
    TaskMutationRequested,
}

/// Admit or block a task work item before live executor handoff.
pub fn admit_codex_task_work_live_executor(
    input: CodexAppServerTaskWorkLiveExecutorAdmissionInput,
) -> CodexAppServerTaskWorkLiveExecutorAdmissionRecord {
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
        CodexAppServerTaskWorkLiveExecutorAdmissionStatus::AcceptedForExecutorHandoff
    } else {
        CodexAppServerTaskWorkLiveExecutorAdmissionStatus::Blocked
    };

    CodexAppServerTaskWorkLiveExecutorAdmissionRecord {
        admission_id: CodexAppServerTaskWorkLiveExecutorAdmissionId(format!(
            "codex-task-work-live-executor-admission:{}:{}",
            input.work_item_id.0, input.live_executor_write_attempt_id.0
        )),
        policy_id: input.policy.policy_id.0,
        work_item_id: input.work_item_id,
        task_id: input.task_id,
        project_id: input.project_id,
        provider_instance_id: input.provider_instance_id,
        runtime_session_ref: input.runtime_session_ref,
        live_executor_write_attempt_id: input.live_executor_write_attempt_id,
        idempotency_key: input.idempotency_key,
        status,
        blockers,
        evidence_refs,
        executor_invoked: false,
        provider_write_executed: false,
        raw_provider_material_retained: false,
        task_mutation_permitted: false,
        review_acceptance_permitted: false,
    }
}

fn validate_policy(
    input: &CodexAppServerTaskWorkLiveExecutorAdmissionInput,
    blockers: &mut Vec<CodexAppServerTaskWorkLiveExecutorAdmissionBlocker>,
) {
    if input.policy.status
        != CodexAppServerTaskBackedLiveExecutionPolicyStatus::AcceptedForLiveExecutorAdmission
    {
        blockers.push(CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::PolicyNotAccepted);
    }
    if input.policy.provider_write_executed {
        blockers.push(
            CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::PolicyAlreadyExecutedProviderWrite,
        );
    }
    if input.policy.callback_response_permitted
        || input.policy.cancellation_permitted
        || input.policy.resume_permitted
        || input.policy.task_completion_permitted
        || input.policy.review_acceptance_permitted
        || input.policy.scm_mutation_permitted
        || input.policy.raw_provider_material_retained
    {
        blockers.push(
            CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::PolicyPermitsForbiddenAuthority,
        );
    }
}

fn validate_identity(
    input: &CodexAppServerTaskWorkLiveExecutorAdmissionInput,
    blockers: &mut Vec<CodexAppServerTaskWorkLiveExecutorAdmissionBlocker>,
) {
    if input.work_item_id.0.is_empty() {
        blockers.push(CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::MissingWorkItemId);
    }
    if input.task_id.0.is_empty() {
        blockers.push(CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::MissingTaskId);
    }
    if input.project_id.0.is_empty() {
        blockers.push(CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::MissingProjectId);
    }
    if input.provider_instance_id.is_empty() {
        blockers
            .push(CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::MissingProviderInstanceId);
    }
    if input.runtime_session_ref.is_empty() {
        blockers.push(CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::MissingRuntimeSessionRef);
    }
    if input.live_executor_write_attempt_id.0.is_empty() {
        blockers.push(
            CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::MissingLiveExecutorWriteAttemptId,
        );
    }
    if input.idempotency_key.0.is_empty() {
        blockers.push(CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::MissingIdempotencyKey);
    }
}

fn validate_identity_match(
    input: &CodexAppServerTaskWorkLiveExecutorAdmissionInput,
    blockers: &mut Vec<CodexAppServerTaskWorkLiveExecutorAdmissionBlocker>,
) {
    if input.work_item_id != input.policy.work_item_id {
        blockers.push(CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::WorkItemPolicyMismatch);
    }
    if input.task_id != input.policy.task_id {
        blockers.push(CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::TaskPolicyMismatch);
    }
    if input.project_id != input.policy.project_id {
        blockers.push(CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::ProjectPolicyMismatch);
    }
    if input.provider_instance_id != input.policy.provider_instance_id {
        blockers.push(
            CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::ProviderInstancePolicyMismatch,
        );
    }
    if Some(input.runtime_session_ref.as_str()) != input.policy.runtime_session_ref.as_deref() {
        blockers
            .push(CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::RuntimeSessionPolicyMismatch);
    }
}

fn validate_inspect_only_requests(
    input: &CodexAppServerTaskWorkLiveExecutorAdmissionInput,
    blockers: &mut Vec<CodexAppServerTaskWorkLiveExecutorAdmissionBlocker>,
) {
    if input.invoke_executor_requested {
        blockers
            .push(CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::ExecutorInvocationRequested);
    }
    if input.raw_provider_material_requested {
        blockers
            .push(CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::RawProviderMaterialRequested);
    }
    if input.task_mutation_requested {
        blockers.push(CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::TaskMutationRequested);
    }
}

#[cfg(test)]
mod tests;
