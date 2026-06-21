//! Codex recovery execution policy records.
//!
//! These records decide whether an admitted recovery may enter a provider
//! execution path. They do not execute provider writes, promote replacement
//! threads, retain raw provider material, mutate tasks, accept reviews, answer
//! callbacks, interrupt turns, or mutate SCM state.

use crate::host_authority::EngineHostId;

use super::{
    CodexAppServerRecoveryAdmission, CodexAppServerRecoveryEnvelopeRecord,
    CodexAppServerRecoveryNeedRecord, CodexAppServerRecoveryTrigger,
};

mod validation;

use validation::{
    validate_forbidden_authority_requests, validate_raw_material_and_mutation_flags,
    validate_recovery_identity, validate_required_evidence, validate_tool_policy,
};

/// Stable id for one recovery execution policy record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerRecoveryExecutionPolicyId(pub String);

/// Input for assessing recovery execution policy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerRecoveryExecutionPolicyInput {
    pub need: CodexAppServerRecoveryNeedRecord,
    pub admission: CodexAppServerRecoveryAdmission,
    pub envelope: CodexAppServerRecoveryEnvelopeRecord,
    pub provider_instance_id: String,
    pub runtime_session_ref: Option<String>,
    pub adapter_id: String,
    pub execution_host_id: EngineHostId,
    pub operator_evidence_ref: Option<String>,
    pub recovery_target_evidence_ref: Option<String>,
    pub provider_identity_evidence_ref: Option<String>,
    pub resume_capability_evidence_ref: Option<String>,
    pub tool_policy: CodexAppServerRecoveryExecutionToolPolicy,
    pub automatic_resume_requested: bool,
    pub replacement_thread_promotion_requested: bool,
    pub task_completion_requested: bool,
    pub review_acceptance_requested: bool,
    pub interruption_requested: bool,
    pub callback_answer_requested: bool,
    pub scm_mutation_requested: bool,
    pub raw_provider_material_requested: bool,
    pub raw_callback_material_requested: bool,
}

/// Tool projection policy for recovery execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerRecoveryExecutionToolPolicy {
    pub projection_mode: CodexAppServerRecoveryExecutionToolProjectionMode,
    pub adapter_capability_evidence_ref: Option<String>,
    pub portal_tool_family: Option<String>,
    pub published_actions: Vec<String>,
    pub flat_tool_count: usize,
}

/// Supported ways Nucleus may expose recovery execution tools.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerRecoveryExecutionToolProjectionMode {
    PortalTool,
    NativeToolRegistration,
    McpToolServer,
    AcpToolSurface,
    SdkSidecar,
    PromptSkill,
    SidecarExecution,
    Unavailable,
}

/// Recovery execution policy decision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerRecoveryExecutionPolicyRecord {
    pub policy_id: CodexAppServerRecoveryExecutionPolicyId,
    pub need_id: String,
    pub admission_id: String,
    pub envelope_id: String,
    pub provider_thread_id: String,
    pub provider_turn_id: Option<String>,
    pub provider_request_id: Option<String>,
    pub task_id: String,
    pub work_item_id: String,
    pub provider_instance_id: String,
    pub runtime_instance_id: String,
    pub runtime_session_ref: Option<String>,
    pub adapter_id: String,
    pub execution_host_id: EngineHostId,
    pub trigger: CodexAppServerRecoveryTrigger,
    pub method: String,
    pub status: CodexAppServerRecoveryExecutionPolicyStatus,
    pub blockers: Vec<CodexAppServerRecoveryExecutionPolicyBlocker>,
    pub tool_policy: CodexAppServerRecoveryExecutionToolPolicy,
    pub evidence_refs: Vec<String>,
    pub provider_write_executed: bool,
    pub automatic_resume_permitted: bool,
    pub replacement_thread_promotion_permitted: bool,
    pub task_completion_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub interruption_permitted: bool,
    pub callback_answer_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub raw_provider_material_retained: bool,
    pub raw_callback_material_retained: bool,
}

/// Policy status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerRecoveryExecutionPolicyStatus {
    AcceptedForExecutionAdmission,
    Blocked,
}

/// Why recovery execution is blocked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerRecoveryExecutionPolicyBlocker {
    AdmissionNotAccepted,
    NeedAdmissionMismatch,
    NeedEnvelopeMismatch,
    AdmissionEnvelopeMismatch,
    RuntimeInstanceMismatch,
    SessionMismatch,
    ProviderThreadMismatch,
    ProviderTurnMismatch,
    ProviderRequestMismatch,
    TaskMismatch,
    WorkItemMismatch,
    MethodUnsupported,
    ProviderIdentityMismatchTrigger,
    MissingProviderInstanceId,
    MissingRuntimeSessionRef,
    MissingAdapterId,
    MissingExecutionHostId,
    MissingOperatorEvidence,
    MissingRecoveryTargetEvidence,
    MissingProviderIdentityEvidence,
    MissingResumeCapabilityEvidence,
    MissingAdapterCapabilityEvidence,
    ToolProjectionUnavailable,
    MissingPortalToolFamily,
    MissingPublishedToolAction,
    FlatToolMenuRequested { flat_tool_count: usize },
    AutomaticResumeRequested,
    ReplacementThreadPromotionRequested,
    TaskCompletionRequested,
    ReviewAcceptanceRequested,
    InterruptionRequested,
    CallbackAnswerRequested,
    ScmMutationRequested,
    RawProviderMaterialRequested,
    RawCallbackMaterialRequested,
    NeedRetainedRawProviderPayload,
    AdmissionRetainedRawProviderPayload,
    EnvelopeRetainedRawPayload,
    NeedPermitsTaskMutation,
    AdmissionPermitsTaskMutation,
    EnvelopePermitsTaskMutation,
    AdmissionStartedProviderSend,
    EnvelopeStartedProviderSend,
    EnvelopeAllowsReplacementThread,
}

/// Assess recovery execution policy without executing provider I/O.
pub fn codex_recovery_execution_policy(
    input: CodexAppServerRecoveryExecutionPolicyInput,
) -> CodexAppServerRecoveryExecutionPolicyRecord {
    let mut blockers = Vec::new();
    let mut evidence_refs = input.need.evidence_refs.clone();

    validate_recovery_identity(&input, &mut blockers);
    validate_required_evidence(&input, &mut blockers, &mut evidence_refs);
    validate_tool_policy(&input.tool_policy, &mut blockers, &mut evidence_refs);
    validate_forbidden_authority_requests(&input, &mut blockers);
    validate_raw_material_and_mutation_flags(&input, &mut blockers);

    evidence_refs.extend(input.admission.evidence_refs.iter().cloned());
    evidence_refs.extend(input.envelope.evidence_refs.iter().cloned());
    evidence_refs.sort();
    evidence_refs.dedup();

    let status = if blockers.is_empty() {
        CodexAppServerRecoveryExecutionPolicyStatus::AcceptedForExecutionAdmission
    } else {
        CodexAppServerRecoveryExecutionPolicyStatus::Blocked
    };

    CodexAppServerRecoveryExecutionPolicyRecord {
        policy_id: CodexAppServerRecoveryExecutionPolicyId(format!(
            "codex-recovery-execution-policy:{}",
            input.need.need_id.0
        )),
        need_id: input.need.need_id.0,
        admission_id: input.admission.admission_id.0,
        envelope_id: input.envelope.envelope_id.0,
        provider_thread_id: input.envelope.provider_thread_id,
        provider_turn_id: input.envelope.provider_turn_id,
        provider_request_id: input.envelope.provider_request_id,
        task_id: input.envelope.task_id,
        work_item_id: input.envelope.work_item_id,
        provider_instance_id: input.provider_instance_id,
        runtime_instance_id: input.envelope.runtime_instance_id,
        runtime_session_ref: input.runtime_session_ref,
        adapter_id: input.adapter_id,
        execution_host_id: input.execution_host_id,
        trigger: input.need.trigger,
        method: input.envelope.method,
        status,
        blockers,
        tool_policy: input.tool_policy,
        evidence_refs,
        provider_write_executed: false,
        automatic_resume_permitted: false,
        replacement_thread_promotion_permitted: false,
        task_completion_permitted: false,
        review_acceptance_permitted: false,
        interruption_permitted: false,
        callback_answer_permitted: false,
        scm_mutation_permitted: false,
        raw_provider_material_retained: false,
        raw_callback_material_retained: false,
    }
}

#[cfg(test)]
mod tests;
