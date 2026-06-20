//! Codex recovery execution policy records.
//!
//! These records decide whether an admitted recovery may enter a provider
//! execution path. They do not execute provider writes, promote replacement
//! threads, retain raw provider material, mutate tasks, accept reviews, answer
//! callbacks, interrupt turns, or mutate SCM state.

use crate::host_authority::EngineHostId;

use super::{
    CodexAppServerRecoveryAdmission, CodexAppServerRecoveryAdmissionStatus,
    CodexAppServerRecoveryEnvelopeRecord, CodexAppServerRecoveryNeedRecord,
    CodexAppServerRecoveryTrigger,
};

const MAX_NON_PORTAL_FLAT_TOOL_COUNT: usize = 3;

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

fn validate_recovery_identity(
    input: &CodexAppServerRecoveryExecutionPolicyInput,
    blockers: &mut Vec<CodexAppServerRecoveryExecutionPolicyBlocker>,
) {
    if input.admission.status != CodexAppServerRecoveryAdmissionStatus::Accepted {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::AdmissionNotAccepted);
    }
    if input.need.need_id.0 != input.admission.need_id {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::NeedAdmissionMismatch);
    }
    if input.need.need_id.0 != input.envelope.need_id {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::NeedEnvelopeMismatch);
    }
    if input.admission.admission_id.0 != input.envelope.admission_id {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::AdmissionEnvelopeMismatch);
    }
    if input.need.runtime_instance_id != input.envelope.runtime_instance_id {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::RuntimeInstanceMismatch);
    }
    if input.need.session_id.0 != input.envelope.session_id
        || input.admission.session_id != input.envelope.session_id
    {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::SessionMismatch);
    }
    if input.need.provider_thread_id.as_deref() != Some(&input.envelope.provider_thread_id)
        || input.admission.provider_thread_id.as_deref() != Some(&input.envelope.provider_thread_id)
    {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::ProviderThreadMismatch);
    }
    if input.need.provider_turn_id != input.envelope.provider_turn_id
        || input.admission.provider_turn_id != input.envelope.provider_turn_id
    {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::ProviderTurnMismatch);
    }
    if input.need.provider_request_id != input.envelope.provider_request_id {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::ProviderRequestMismatch);
    }
    if input.need.task_id.0 != input.envelope.task_id {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::TaskMismatch);
    }
    if input.need.work_item_id.0 != input.envelope.work_item_id {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::WorkItemMismatch);
    }
    if input.envelope.method != "thread/resume" {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::MethodUnsupported);
    }
    if matches!(
        input.need.trigger,
        CodexAppServerRecoveryTrigger::ProviderIdentityMismatch { .. }
    ) {
        blockers
            .push(CodexAppServerRecoveryExecutionPolicyBlocker::ProviderIdentityMismatchTrigger);
    }
}

fn validate_required_evidence(
    input: &CodexAppServerRecoveryExecutionPolicyInput,
    blockers: &mut Vec<CodexAppServerRecoveryExecutionPolicyBlocker>,
    evidence_refs: &mut Vec<String>,
) {
    if input.provider_instance_id.is_empty() {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::MissingProviderInstanceId);
    }
    match &input.runtime_session_ref {
        Some(runtime_session_ref) if !runtime_session_ref.is_empty() => {
            evidence_refs.push(runtime_session_ref.clone());
        }
        _ => blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::MissingRuntimeSessionRef),
    }
    if input.adapter_id.is_empty() {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::MissingAdapterId);
    }
    if input.execution_host_id.0.is_empty() {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::MissingExecutionHostId);
    }
    collect_optional_evidence(
        &input.operator_evidence_ref,
        CodexAppServerRecoveryExecutionPolicyBlocker::MissingOperatorEvidence,
        blockers,
        evidence_refs,
    );
    collect_optional_evidence(
        &input.recovery_target_evidence_ref,
        CodexAppServerRecoveryExecutionPolicyBlocker::MissingRecoveryTargetEvidence,
        blockers,
        evidence_refs,
    );
    collect_optional_evidence(
        &input.provider_identity_evidence_ref,
        CodexAppServerRecoveryExecutionPolicyBlocker::MissingProviderIdentityEvidence,
        blockers,
        evidence_refs,
    );
    collect_optional_evidence(
        &input.resume_capability_evidence_ref,
        CodexAppServerRecoveryExecutionPolicyBlocker::MissingResumeCapabilityEvidence,
        blockers,
        evidence_refs,
    );
}

fn collect_optional_evidence(
    value: &Option<String>,
    missing: CodexAppServerRecoveryExecutionPolicyBlocker,
    blockers: &mut Vec<CodexAppServerRecoveryExecutionPolicyBlocker>,
    evidence_refs: &mut Vec<String>,
) {
    match value {
        Some(value) if !value.is_empty() => evidence_refs.push(value.clone()),
        _ => blockers.push(missing),
    }
}

fn validate_tool_policy(
    tool_policy: &CodexAppServerRecoveryExecutionToolPolicy,
    blockers: &mut Vec<CodexAppServerRecoveryExecutionPolicyBlocker>,
    evidence_refs: &mut Vec<String>,
) {
    collect_optional_evidence(
        &tool_policy.adapter_capability_evidence_ref,
        CodexAppServerRecoveryExecutionPolicyBlocker::MissingAdapterCapabilityEvidence,
        blockers,
        evidence_refs,
    );
    if tool_policy.projection_mode == CodexAppServerRecoveryExecutionToolProjectionMode::Unavailable
    {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::ToolProjectionUnavailable);
    }
    if tool_policy.published_actions.is_empty()
        || tool_policy
            .published_actions
            .iter()
            .any(|action| action.is_empty())
    {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::MissingPublishedToolAction);
    }
    match tool_policy.projection_mode {
        CodexAppServerRecoveryExecutionToolProjectionMode::PortalTool => {
            match &tool_policy.portal_tool_family {
                Some(family) if !family.is_empty() => evidence_refs.push(format!("tool:{family}")),
                _ => blockers
                    .push(CodexAppServerRecoveryExecutionPolicyBlocker::MissingPortalToolFamily),
            }
        }
        _ if tool_policy.flat_tool_count > MAX_NON_PORTAL_FLAT_TOOL_COUNT => blockers.push(
            CodexAppServerRecoveryExecutionPolicyBlocker::FlatToolMenuRequested {
                flat_tool_count: tool_policy.flat_tool_count,
            },
        ),
        _ => {}
    }
}

fn validate_forbidden_authority_requests(
    input: &CodexAppServerRecoveryExecutionPolicyInput,
    blockers: &mut Vec<CodexAppServerRecoveryExecutionPolicyBlocker>,
) {
    if input.automatic_resume_requested {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::AutomaticResumeRequested);
    }
    if input.replacement_thread_promotion_requested {
        blockers.push(
            CodexAppServerRecoveryExecutionPolicyBlocker::ReplacementThreadPromotionRequested,
        );
    }
    if input.task_completion_requested {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::TaskCompletionRequested);
    }
    if input.review_acceptance_requested {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::ReviewAcceptanceRequested);
    }
    if input.interruption_requested {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::InterruptionRequested);
    }
    if input.callback_answer_requested {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::CallbackAnswerRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::ScmMutationRequested);
    }
    if input.raw_provider_material_requested {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::RawProviderMaterialRequested);
    }
    if input.raw_callback_material_requested {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::RawCallbackMaterialRequested);
    }
}

fn validate_raw_material_and_mutation_flags(
    input: &CodexAppServerRecoveryExecutionPolicyInput,
    blockers: &mut Vec<CodexAppServerRecoveryExecutionPolicyBlocker>,
) {
    if input.need.raw_provider_payload_retained {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::NeedRetainedRawProviderPayload);
    }
    if input.admission.raw_provider_payload_retained {
        blockers.push(
            CodexAppServerRecoveryExecutionPolicyBlocker::AdmissionRetainedRawProviderPayload,
        );
    }
    if input.envelope.raw_payload_retained {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::EnvelopeRetainedRawPayload);
    }
    if input.need.task_mutation_permitted {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::NeedPermitsTaskMutation);
    }
    if input.admission.task_mutation_permitted {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::AdmissionPermitsTaskMutation);
    }
    if input.envelope.task_mutation_permitted {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::EnvelopePermitsTaskMutation);
    }
    if input.admission.provider_send_started {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::AdmissionStartedProviderSend);
    }
    if input.envelope.provider_send_started {
        blockers.push(CodexAppServerRecoveryExecutionPolicyBlocker::EnvelopeStartedProviderSend);
    }
    if input.envelope.replacement_thread_allowed {
        blockers
            .push(CodexAppServerRecoveryExecutionPolicyBlocker::EnvelopeAllowsReplacementThread);
    }
}

#[cfg(test)]
mod tests;
