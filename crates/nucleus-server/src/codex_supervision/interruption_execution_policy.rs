//! Codex interruption execution policy records.
//!
//! These records decide whether an admitted interruption may enter a provider
//! execution path. They do not execute provider writes, recover sessions,
//! answer callbacks, retain raw provider material, mutate tasks, accept review,
//! or mutate SCM state.

use crate::host_authority::EngineHostId;

use super::{
    CodexAppServerInterruptionAdmission, CodexAppServerInterruptionAdmissionStatus,
    CodexAppServerInterruptionEnvelopeRecord, CodexAppServerInterruptionRequest,
    CodexAppServerInterruptionTarget,
};

const MAX_NON_PORTAL_FLAT_TOOL_COUNT: usize = 3;

/// Stable id for one interruption execution policy record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerInterruptionExecutionPolicyId(pub String);

/// Input for assessing interruption execution policy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerInterruptionExecutionPolicyInput {
    pub request: CodexAppServerInterruptionRequest,
    pub admission: CodexAppServerInterruptionAdmission,
    pub envelope: CodexAppServerInterruptionEnvelopeRecord,
    pub provider_instance_id: String,
    pub runtime_session_ref: Option<String>,
    pub adapter_id: String,
    pub execution_host_id: EngineHostId,
    pub operator_evidence_ref: Option<String>,
    pub target_evidence_ref: Option<String>,
    pub interruption_capability_evidence_ref: Option<String>,
    pub tool_policy: CodexAppServerInterruptionExecutionToolPolicy,
    pub automatic_interruption_requested: bool,
    pub task_completion_requested: bool,
    pub review_acceptance_requested: bool,
    pub resume_requested: bool,
    pub callback_answer_requested: bool,
    pub scm_mutation_requested: bool,
    pub raw_provider_material_requested: bool,
    pub raw_callback_material_requested: bool,
}

/// Tool projection policy for interruption execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerInterruptionExecutionToolPolicy {
    pub projection_mode: CodexAppServerInterruptionExecutionToolProjectionMode,
    pub adapter_capability_evidence_ref: Option<String>,
    pub portal_tool_family: Option<String>,
    pub published_actions: Vec<String>,
    pub flat_tool_count: usize,
}

/// Supported ways Nucleus may expose interruption execution tools.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerInterruptionExecutionToolProjectionMode {
    PortalTool,
    NativeToolRegistration,
    McpToolServer,
    AcpToolSurface,
    SdkSidecar,
    PromptSkill,
    SidecarExecution,
    Unavailable,
}

/// Interruption execution policy decision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerInterruptionExecutionPolicyRecord {
    pub policy_id: CodexAppServerInterruptionExecutionPolicyId,
    pub request_id: String,
    pub admission_id: String,
    pub envelope_id: String,
    pub provider_turn_id: String,
    pub provider_request_id: Option<String>,
    pub task_id: String,
    pub work_item_id: String,
    pub provider_instance_id: String,
    pub runtime_instance_id: String,
    pub runtime_session_ref: Option<String>,
    pub adapter_id: String,
    pub execution_host_id: EngineHostId,
    pub target: CodexAppServerInterruptionTarget,
    pub method: String,
    pub status: CodexAppServerInterruptionExecutionPolicyStatus,
    pub blockers: Vec<CodexAppServerInterruptionExecutionPolicyBlocker>,
    pub tool_policy: CodexAppServerInterruptionExecutionToolPolicy,
    pub evidence_refs: Vec<String>,
    pub provider_write_executed: bool,
    pub automatic_interruption_permitted: bool,
    pub task_completion_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub resume_permitted: bool,
    pub callback_answer_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub raw_provider_material_retained: bool,
    pub raw_callback_material_retained: bool,
}

/// Policy status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerInterruptionExecutionPolicyStatus {
    AcceptedForExecutionAdmission,
    Blocked,
}

/// Why interruption execution is blocked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerInterruptionExecutionPolicyBlocker {
    AdmissionNotAccepted,
    RequestAdmissionMismatch,
    RequestEnvelopeMismatch,
    AdmissionEnvelopeMismatch,
    RuntimeInstanceMismatch,
    SessionMismatch,
    TargetMismatch,
    TaskMismatch,
    WorkItemMismatch,
    MethodUnsupported,
    MissingProviderInstanceId,
    MissingRuntimeSessionRef,
    MissingAdapterId,
    MissingExecutionHostId,
    MissingOperatorEvidence,
    MissingTargetEvidence,
    MissingInterruptionCapabilityEvidence,
    MissingAdapterCapabilityEvidence,
    ToolProjectionUnavailable,
    MissingPortalToolFamily,
    MissingPublishedToolAction,
    FlatToolMenuRequested { flat_tool_count: usize },
    AutomaticInterruptionRequested,
    TaskCompletionRequested,
    ReviewAcceptanceRequested,
    ResumeRequested,
    CallbackAnswerRequested,
    ScmMutationRequested,
    RawProviderMaterialRequested,
    RawCallbackMaterialRequested,
    RequestRetainedRawProviderPayload,
    AdmissionRetainedRawProviderPayload,
    EnvelopeRetainedRawPayload,
    RequestImpliesRecovery,
    AdmissionImpliesRecovery,
    EnvelopeImpliesRecovery,
    RequestPermitsTaskMutation,
    AdmissionPermitsTaskMutation,
    EnvelopePermitsTaskMutation,
}

/// Assess interruption execution policy without executing provider I/O.
pub fn codex_interruption_execution_policy(
    input: CodexAppServerInterruptionExecutionPolicyInput,
) -> CodexAppServerInterruptionExecutionPolicyRecord {
    let mut blockers = Vec::new();
    let mut evidence_refs = input.request.evidence_refs().to_vec();

    validate_interruption_identity(&input, &mut blockers);
    validate_required_evidence(&input, &mut blockers, &mut evidence_refs);
    validate_tool_policy(&input.tool_policy, &mut blockers, &mut evidence_refs);
    validate_forbidden_authority_requests(&input, &mut blockers);
    validate_raw_material_and_mutation_flags(&input, &mut blockers);

    evidence_refs.extend(input.admission.evidence_refs.iter().cloned());
    evidence_refs.extend(input.envelope.evidence_refs.iter().cloned());
    evidence_refs.sort();
    evidence_refs.dedup();

    let status = if blockers.is_empty() {
        CodexAppServerInterruptionExecutionPolicyStatus::AcceptedForExecutionAdmission
    } else {
        CodexAppServerInterruptionExecutionPolicyStatus::Blocked
    };

    let (provider_turn_id, provider_request_id) = target_ids(input.request.target());

    CodexAppServerInterruptionExecutionPolicyRecord {
        policy_id: CodexAppServerInterruptionExecutionPolicyId(format!(
            "codex-interruption-execution-policy:{}",
            input.request.request_id().0
        )),
        request_id: input.request.request_id().0.clone(),
        admission_id: input.admission.admission_id.0,
        envelope_id: input.envelope.envelope_id.0,
        provider_turn_id,
        provider_request_id,
        task_id: input.request.task_id().0.clone(),
        work_item_id: input.request.work_item_id().0.clone(),
        provider_instance_id: input.provider_instance_id,
        runtime_instance_id: input.request.runtime_instance_id().to_owned(),
        runtime_session_ref: input.runtime_session_ref,
        adapter_id: input.adapter_id,
        execution_host_id: input.execution_host_id,
        target: input.request.target().clone(),
        method: input.envelope.method,
        status,
        blockers,
        tool_policy: input.tool_policy,
        evidence_refs,
        provider_write_executed: false,
        automatic_interruption_permitted: false,
        task_completion_permitted: false,
        review_acceptance_permitted: false,
        resume_permitted: false,
        callback_answer_permitted: false,
        scm_mutation_permitted: false,
        raw_provider_material_retained: false,
        raw_callback_material_retained: false,
    }
}

fn validate_interruption_identity(
    input: &CodexAppServerInterruptionExecutionPolicyInput,
    blockers: &mut Vec<CodexAppServerInterruptionExecutionPolicyBlocker>,
) {
    if input.admission.status != CodexAppServerInterruptionAdmissionStatus::Accepted {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::AdmissionNotAccepted);
    }
    if input.request.request_id().0 != input.admission.request_id {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::RequestAdmissionMismatch);
    }
    if input.request.request_id().0 != input.envelope.request_id {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::RequestEnvelopeMismatch);
    }
    if input.admission.admission_id.0 != input.envelope.admission_id {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::AdmissionEnvelopeMismatch);
    }
    if input.request.runtime_instance_id() != input.envelope.runtime_instance_id {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::RuntimeInstanceMismatch);
    }
    if input.request.session_id().0 != input.envelope.session_id {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::SessionMismatch);
    }
    if !target_matches_envelope(input.request.target(), &input.envelope) {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::TargetMismatch);
    }
    if input.request.task_id().0 != input.envelope.task_id {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::TaskMismatch);
    }
    if input.request.work_item_id().0 != input.envelope.work_item_id {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::WorkItemMismatch);
    }
    if input.envelope.method != "turn/interrupt" {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::MethodUnsupported);
    }
}

fn validate_required_evidence(
    input: &CodexAppServerInterruptionExecutionPolicyInput,
    blockers: &mut Vec<CodexAppServerInterruptionExecutionPolicyBlocker>,
    evidence_refs: &mut Vec<String>,
) {
    if input.provider_instance_id.is_empty() {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::MissingProviderInstanceId);
    }
    match &input.runtime_session_ref {
        Some(runtime_session_ref) if !runtime_session_ref.is_empty() => {
            evidence_refs.push(runtime_session_ref.clone());
        }
        _ => blockers
            .push(CodexAppServerInterruptionExecutionPolicyBlocker::MissingRuntimeSessionRef),
    }
    if input.adapter_id.is_empty() {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::MissingAdapterId);
    }
    if input.execution_host_id.0.is_empty() {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::MissingExecutionHostId);
    }
    match &input.operator_evidence_ref {
        Some(evidence_ref) if !evidence_ref.is_empty() => evidence_refs.push(evidence_ref.clone()),
        _ => {
            blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::MissingOperatorEvidence)
        }
    }
    match &input.target_evidence_ref {
        Some(evidence_ref) if !evidence_ref.is_empty() => evidence_refs.push(evidence_ref.clone()),
        _ => blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::MissingTargetEvidence),
    }
    match &input.interruption_capability_evidence_ref {
        Some(evidence_ref) if !evidence_ref.is_empty() => evidence_refs.push(evidence_ref.clone()),
        _ => blockers.push(
            CodexAppServerInterruptionExecutionPolicyBlocker::MissingInterruptionCapabilityEvidence,
        ),
    }
}

fn validate_tool_policy(
    policy: &CodexAppServerInterruptionExecutionToolPolicy,
    blockers: &mut Vec<CodexAppServerInterruptionExecutionPolicyBlocker>,
    evidence_refs: &mut Vec<String>,
) {
    if policy.projection_mode == CodexAppServerInterruptionExecutionToolProjectionMode::Unavailable
    {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::ToolProjectionUnavailable);
    }
    match &policy.adapter_capability_evidence_ref {
        Some(evidence_ref) if !evidence_ref.is_empty() => evidence_refs.push(evidence_ref.clone()),
        _ => blockers.push(
            CodexAppServerInterruptionExecutionPolicyBlocker::MissingAdapterCapabilityEvidence,
        ),
    }
    if policy.projection_mode == CodexAppServerInterruptionExecutionToolProjectionMode::PortalTool {
        match &policy.portal_tool_family {
            Some(portal_tool_family) if !portal_tool_family.is_empty() => {
                evidence_refs.push(format!("tool:{portal_tool_family}"));
            }
            _ => blockers
                .push(CodexAppServerInterruptionExecutionPolicyBlocker::MissingPortalToolFamily),
        }
    }
    if policy.published_actions.is_empty()
        || policy
            .published_actions
            .iter()
            .any(|action| action.is_empty())
    {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::MissingPublishedToolAction);
    }
    if policy.projection_mode != CodexAppServerInterruptionExecutionToolProjectionMode::PortalTool
        && policy.flat_tool_count > MAX_NON_PORTAL_FLAT_TOOL_COUNT
    {
        blockers.push(
            CodexAppServerInterruptionExecutionPolicyBlocker::FlatToolMenuRequested {
                flat_tool_count: policy.flat_tool_count,
            },
        );
    }
}

fn validate_forbidden_authority_requests(
    input: &CodexAppServerInterruptionExecutionPolicyInput,
    blockers: &mut Vec<CodexAppServerInterruptionExecutionPolicyBlocker>,
) {
    if input.automatic_interruption_requested {
        blockers
            .push(CodexAppServerInterruptionExecutionPolicyBlocker::AutomaticInterruptionRequested);
    }
    if input.task_completion_requested {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::TaskCompletionRequested);
    }
    if input.review_acceptance_requested {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::ReviewAcceptanceRequested);
    }
    if input.resume_requested {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::ResumeRequested);
    }
    if input.callback_answer_requested {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::CallbackAnswerRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::ScmMutationRequested);
    }
    if input.raw_provider_material_requested {
        blockers
            .push(CodexAppServerInterruptionExecutionPolicyBlocker::RawProviderMaterialRequested);
    }
    if input.raw_callback_material_requested {
        blockers
            .push(CodexAppServerInterruptionExecutionPolicyBlocker::RawCallbackMaterialRequested);
    }
}

fn validate_raw_material_and_mutation_flags(
    input: &CodexAppServerInterruptionExecutionPolicyInput,
    blockers: &mut Vec<CodexAppServerInterruptionExecutionPolicyBlocker>,
) {
    if input.request.raw_provider_payload_retained() {
        blockers.push(
            CodexAppServerInterruptionExecutionPolicyBlocker::RequestRetainedRawProviderPayload,
        );
    }
    if input.admission.raw_provider_payload_retained {
        blockers.push(
            CodexAppServerInterruptionExecutionPolicyBlocker::AdmissionRetainedRawProviderPayload,
        );
    }
    if input.envelope.raw_payload_retained {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::EnvelopeRetainedRawPayload);
    }
    if input.request.recovery_implied() {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::RequestImpliesRecovery);
    }
    if input.admission.recovery_implied {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::AdmissionImpliesRecovery);
    }
    if input.envelope.recovery_implied {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::EnvelopeImpliesRecovery);
    }
    if input.request.task_mutation_permitted() {
        blockers.push(CodexAppServerInterruptionExecutionPolicyBlocker::RequestPermitsTaskMutation);
    }
    if input.admission.task_mutation_permitted {
        blockers
            .push(CodexAppServerInterruptionExecutionPolicyBlocker::AdmissionPermitsTaskMutation);
    }
    if input.envelope.task_mutation_permitted {
        blockers
            .push(CodexAppServerInterruptionExecutionPolicyBlocker::EnvelopePermitsTaskMutation);
    }
}

fn target_matches_envelope(
    target: &CodexAppServerInterruptionTarget,
    envelope: &CodexAppServerInterruptionEnvelopeRecord,
) -> bool {
    let (provider_turn_id, provider_request_id) = target_ids(target);
    provider_turn_id == envelope.provider_turn_id
        && provider_request_id == envelope.provider_request_id
}

fn target_ids(target: &CodexAppServerInterruptionTarget) -> (String, Option<String>) {
    match target {
        CodexAppServerInterruptionTarget::ActiveTurn {
            provider_turn_id,
            provider_request_id,
        } => (provider_turn_id.clone(), provider_request_id.clone()),
    }
}

#[cfg(test)]
mod tests;
