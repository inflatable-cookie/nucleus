//! Codex callback response execution policy records.
//!
//! These records decide whether a callback response may enter a provider
//! execution path. They do not execute provider writes, auto-answer callbacks,
//! retain raw callback material, mutate tasks, accept reviews, cancel work,
//! resume sessions, or mutate SCM state.

use crate::host_authority::EngineHostId;

use super::{
    CodexAppServerCallbackRequest, CodexAppServerCallbackRequestKind,
    CodexAppServerCallbackResponse, CodexAppServerCallbackResponseAdmission,
    CodexAppServerCallbackResponseAdmissionStatus, CodexAppServerCallbackResponseEnvelopeRecord,
};

const MAX_NON_PORTAL_FLAT_TOOL_COUNT: usize = 3;

/// Stable id for one callback response execution policy record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerCallbackResponseExecutionPolicyId(pub String);

/// Input for assessing callback response execution policy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerCallbackResponseExecutionPolicyInput {
    pub request: CodexAppServerCallbackRequest,
    pub admission: CodexAppServerCallbackResponseAdmission,
    pub envelope: CodexAppServerCallbackResponseEnvelopeRecord,
    pub provider_instance_id: String,
    pub runtime_session_ref: Option<String>,
    pub adapter_id: String,
    pub execution_host_id: EngineHostId,
    pub operator_evidence_ref: Option<String>,
    pub callback_kind_evidence_ref: Option<String>,
    pub response_shape_evidence_ref: Option<String>,
    pub tool_policy: CodexAppServerCallbackResponseExecutionToolPolicy,
    pub automatic_callback_answer_requested: bool,
    pub task_completion_requested: bool,
    pub review_acceptance_requested: bool,
    pub cancellation_requested: bool,
    pub resume_requested: bool,
    pub scm_mutation_requested: bool,
    pub raw_callback_material_requested: bool,
}

/// Tool projection policy for callback response execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerCallbackResponseExecutionToolPolicy {
    pub projection_mode: CodexAppServerCallbackResponseExecutionToolProjectionMode,
    pub adapter_capability_evidence_ref: Option<String>,
    pub portal_tool_family: Option<String>,
    pub published_actions: Vec<String>,
    pub flat_tool_count: usize,
}

/// Supported ways Nucleus may expose callback execution tools.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerCallbackResponseExecutionToolProjectionMode {
    PortalTool,
    NativeToolRegistration,
    McpToolServer,
    AcpToolSurface,
    SdkSidecar,
    PromptSkill,
    SidecarExecution,
    Unavailable,
}

/// Callback response execution policy decision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerCallbackResponseExecutionPolicyRecord {
    pub policy_id: CodexAppServerCallbackResponseExecutionPolicyId,
    pub request_id: String,
    pub admission_id: String,
    pub envelope_id: String,
    pub provider_callback_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub provider_instance_id: String,
    pub runtime_instance_id: String,
    pub runtime_session_ref: Option<String>,
    pub adapter_id: String,
    pub execution_host_id: EngineHostId,
    pub callback_kind: CodexAppServerCallbackRequestKind,
    pub response: CodexAppServerCallbackResponse,
    pub status: CodexAppServerCallbackResponseExecutionPolicyStatus,
    pub blockers: Vec<CodexAppServerCallbackResponseExecutionPolicyBlocker>,
    pub tool_policy: CodexAppServerCallbackResponseExecutionToolPolicy,
    pub evidence_refs: Vec<String>,
    pub provider_write_executed: bool,
    pub automatic_callback_answer_permitted: bool,
    pub task_completion_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub cancellation_permitted: bool,
    pub resume_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub raw_callback_material_retained: bool,
}

/// Policy status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerCallbackResponseExecutionPolicyStatus {
    AcceptedForExecutionAdmission,
    Blocked,
}

/// Why callback response execution is blocked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerCallbackResponseExecutionPolicyBlocker {
    AdmissionNotAccepted,
    RequestAdmissionMismatch,
    RequestEnvelopeMismatch,
    AdmissionEnvelopeMismatch,
    ProviderCallbackMismatch,
    TaskMismatch,
    WorkItemMismatch,
    RuntimeInstanceMismatch,
    ResponseShapeMismatch,
    MissingProviderInstanceId,
    MissingRuntimeSessionRef,
    MissingAdapterId,
    MissingExecutionHostId,
    MissingOperatorEvidence,
    MissingCallbackKindEvidence,
    MissingResponseShapeEvidence,
    MissingAdapterCapabilityEvidence,
    ToolProjectionUnavailable,
    MissingPortalToolFamily,
    MissingPublishedToolAction,
    FlatToolMenuRequested { flat_tool_count: usize },
    AutomaticCallbackAnswerRequested,
    TaskCompletionRequested,
    ReviewAcceptanceRequested,
    CancellationRequested,
    ResumeRequested,
    ScmMutationRequested,
    RawCallbackMaterialRequested,
    RequestRetainedRawProviderPayload,
    AdmissionRetainedRawProviderPayload,
    EnvelopeRetainedRawPayload,
    RequestPermitsTaskMutation,
    AdmissionPermitsTaskMutation,
    EnvelopePermitsTaskMutation,
}

/// Assess callback response execution policy without executing provider I/O.
pub fn codex_callback_response_execution_policy(
    input: CodexAppServerCallbackResponseExecutionPolicyInput,
) -> CodexAppServerCallbackResponseExecutionPolicyRecord {
    let mut blockers = Vec::new();
    let mut evidence_refs = input.request.evidence_refs().to_vec();

    validate_callback_identity(&input, &mut blockers);
    validate_required_evidence(&input, &mut blockers, &mut evidence_refs);
    validate_tool_policy(&input.tool_policy, &mut blockers, &mut evidence_refs);
    validate_forbidden_authority_requests(&input, &mut blockers);
    validate_raw_material_and_mutation_flags(&input, &mut blockers);

    evidence_refs.extend(input.admission.evidence_refs.iter().cloned());
    evidence_refs.extend(input.envelope.evidence_refs.iter().cloned());
    evidence_refs.sort();
    evidence_refs.dedup();

    let status = if blockers.is_empty() {
        CodexAppServerCallbackResponseExecutionPolicyStatus::AcceptedForExecutionAdmission
    } else {
        CodexAppServerCallbackResponseExecutionPolicyStatus::Blocked
    };

    CodexAppServerCallbackResponseExecutionPolicyRecord {
        policy_id: CodexAppServerCallbackResponseExecutionPolicyId(format!(
            "codex-callback-response-execution-policy:{}",
            input.request.request_id().0
        )),
        request_id: input.request.request_id().0.clone(),
        admission_id: input.admission.admission_id.0,
        envelope_id: input.envelope.envelope_id.0,
        provider_callback_id: input.request.provider_callback_id().0.clone(),
        task_id: input.request.task_id().0.clone(),
        work_item_id: input.request.work_item_id().0.clone(),
        provider_instance_id: input.provider_instance_id,
        runtime_instance_id: input.request.runtime_instance_id().to_owned(),
        runtime_session_ref: input.runtime_session_ref,
        adapter_id: input.adapter_id,
        execution_host_id: input.execution_host_id,
        callback_kind: input.request.kind().clone(),
        response: input.admission.response,
        status,
        blockers,
        tool_policy: input.tool_policy,
        evidence_refs,
        provider_write_executed: false,
        automatic_callback_answer_permitted: false,
        task_completion_permitted: false,
        review_acceptance_permitted: false,
        cancellation_permitted: false,
        resume_permitted: false,
        scm_mutation_permitted: false,
        raw_callback_material_retained: false,
    }
}

fn validate_callback_identity(
    input: &CodexAppServerCallbackResponseExecutionPolicyInput,
    blockers: &mut Vec<CodexAppServerCallbackResponseExecutionPolicyBlocker>,
) {
    if input.admission.status != CodexAppServerCallbackResponseAdmissionStatus::Accepted {
        blockers.push(CodexAppServerCallbackResponseExecutionPolicyBlocker::AdmissionNotAccepted);
    }
    if input.request.request_id().0 != input.admission.request_id {
        blockers
            .push(CodexAppServerCallbackResponseExecutionPolicyBlocker::RequestAdmissionMismatch);
    }
    if input.request.request_id().0 != input.envelope.request_id {
        blockers
            .push(CodexAppServerCallbackResponseExecutionPolicyBlocker::RequestEnvelopeMismatch);
    }
    if input.admission.admission_id.0 != input.envelope.admission_id {
        blockers
            .push(CodexAppServerCallbackResponseExecutionPolicyBlocker::AdmissionEnvelopeMismatch);
    }
    if input.request.provider_callback_id().0 != input.envelope.provider_callback_id
        || input.admission.provider_callback_id.0 != input.envelope.provider_callback_id
    {
        blockers
            .push(CodexAppServerCallbackResponseExecutionPolicyBlocker::ProviderCallbackMismatch);
    }
    if input.request.task_id().0 != input.envelope.task_id {
        blockers.push(CodexAppServerCallbackResponseExecutionPolicyBlocker::TaskMismatch);
    }
    if input.request.work_item_id().0 != input.envelope.work_item_id {
        blockers.push(CodexAppServerCallbackResponseExecutionPolicyBlocker::WorkItemMismatch);
    }
    if input.request.runtime_instance_id() != input.envelope.runtime_instance_id {
        blockers
            .push(CodexAppServerCallbackResponseExecutionPolicyBlocker::RuntimeInstanceMismatch);
    }
    if input.admission.response != input.envelope.response {
        blockers.push(CodexAppServerCallbackResponseExecutionPolicyBlocker::ResponseShapeMismatch);
    }
}

fn validate_required_evidence(
    input: &CodexAppServerCallbackResponseExecutionPolicyInput,
    blockers: &mut Vec<CodexAppServerCallbackResponseExecutionPolicyBlocker>,
    evidence_refs: &mut Vec<String>,
) {
    if input.provider_instance_id.is_empty() {
        blockers
            .push(CodexAppServerCallbackResponseExecutionPolicyBlocker::MissingProviderInstanceId);
    }
    match &input.runtime_session_ref {
        Some(runtime_session_ref) if !runtime_session_ref.is_empty() => {
            evidence_refs.push(runtime_session_ref.clone());
        }
        _ => blockers
            .push(CodexAppServerCallbackResponseExecutionPolicyBlocker::MissingRuntimeSessionRef),
    }
    if input.adapter_id.is_empty() {
        blockers.push(CodexAppServerCallbackResponseExecutionPolicyBlocker::MissingAdapterId);
    }
    if input.execution_host_id.0.is_empty() {
        blockers.push(CodexAppServerCallbackResponseExecutionPolicyBlocker::MissingExecutionHostId);
    }
    collect_optional_evidence(
        &input.operator_evidence_ref,
        CodexAppServerCallbackResponseExecutionPolicyBlocker::MissingOperatorEvidence,
        blockers,
        evidence_refs,
    );
    collect_optional_evidence(
        &input.callback_kind_evidence_ref,
        CodexAppServerCallbackResponseExecutionPolicyBlocker::MissingCallbackKindEvidence,
        blockers,
        evidence_refs,
    );
    collect_optional_evidence(
        &input.response_shape_evidence_ref,
        CodexAppServerCallbackResponseExecutionPolicyBlocker::MissingResponseShapeEvidence,
        blockers,
        evidence_refs,
    );
}

fn collect_optional_evidence(
    value: &Option<String>,
    missing: CodexAppServerCallbackResponseExecutionPolicyBlocker,
    blockers: &mut Vec<CodexAppServerCallbackResponseExecutionPolicyBlocker>,
    evidence_refs: &mut Vec<String>,
) {
    match value {
        Some(value) if !value.is_empty() => evidence_refs.push(value.clone()),
        _ => blockers.push(missing),
    }
}

fn validate_tool_policy(
    tool_policy: &CodexAppServerCallbackResponseExecutionToolPolicy,
    blockers: &mut Vec<CodexAppServerCallbackResponseExecutionPolicyBlocker>,
    evidence_refs: &mut Vec<String>,
) {
    collect_optional_evidence(
        &tool_policy.adapter_capability_evidence_ref,
        CodexAppServerCallbackResponseExecutionPolicyBlocker::MissingAdapterCapabilityEvidence,
        blockers,
        evidence_refs,
    );
    if tool_policy.projection_mode
        == CodexAppServerCallbackResponseExecutionToolProjectionMode::Unavailable
    {
        blockers
            .push(CodexAppServerCallbackResponseExecutionPolicyBlocker::ToolProjectionUnavailable);
    }
    if tool_policy.published_actions.is_empty()
        || tool_policy
            .published_actions
            .iter()
            .any(|action| action.is_empty())
    {
        blockers
            .push(CodexAppServerCallbackResponseExecutionPolicyBlocker::MissingPublishedToolAction);
    }
    match tool_policy.projection_mode {
        CodexAppServerCallbackResponseExecutionToolProjectionMode::PortalTool => {
            match &tool_policy.portal_tool_family {
                Some(family) if !family.is_empty() => evidence_refs.push(format!("tool:{family}")),
                _ => blockers.push(
                    CodexAppServerCallbackResponseExecutionPolicyBlocker::MissingPortalToolFamily,
                ),
            }
        }
        _ if tool_policy.flat_tool_count > MAX_NON_PORTAL_FLAT_TOOL_COUNT => blockers.push(
            CodexAppServerCallbackResponseExecutionPolicyBlocker::FlatToolMenuRequested {
                flat_tool_count: tool_policy.flat_tool_count,
            },
        ),
        _ => {}
    }
}

fn validate_forbidden_authority_requests(
    input: &CodexAppServerCallbackResponseExecutionPolicyInput,
    blockers: &mut Vec<CodexAppServerCallbackResponseExecutionPolicyBlocker>,
) {
    if input.automatic_callback_answer_requested {
        blockers.push(
            CodexAppServerCallbackResponseExecutionPolicyBlocker::AutomaticCallbackAnswerRequested,
        );
    }
    if input.task_completion_requested {
        blockers
            .push(CodexAppServerCallbackResponseExecutionPolicyBlocker::TaskCompletionRequested);
    }
    if input.review_acceptance_requested {
        blockers
            .push(CodexAppServerCallbackResponseExecutionPolicyBlocker::ReviewAcceptanceRequested);
    }
    if input.cancellation_requested {
        blockers.push(CodexAppServerCallbackResponseExecutionPolicyBlocker::CancellationRequested);
    }
    if input.resume_requested {
        blockers.push(CodexAppServerCallbackResponseExecutionPolicyBlocker::ResumeRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(CodexAppServerCallbackResponseExecutionPolicyBlocker::ScmMutationRequested);
    }
    if input.raw_callback_material_requested {
        blockers.push(
            CodexAppServerCallbackResponseExecutionPolicyBlocker::RawCallbackMaterialRequested,
        );
    }
}

fn validate_raw_material_and_mutation_flags(
    input: &CodexAppServerCallbackResponseExecutionPolicyInput,
    blockers: &mut Vec<CodexAppServerCallbackResponseExecutionPolicyBlocker>,
) {
    if input.request.raw_provider_payload_retained() {
        blockers.push(
            CodexAppServerCallbackResponseExecutionPolicyBlocker::RequestRetainedRawProviderPayload,
        );
    }
    if input.admission.raw_provider_payload_retained {
        blockers.push(
            CodexAppServerCallbackResponseExecutionPolicyBlocker::AdmissionRetainedRawProviderPayload,
        );
    }
    if input.envelope.raw_payload_retained {
        blockers
            .push(CodexAppServerCallbackResponseExecutionPolicyBlocker::EnvelopeRetainedRawPayload);
    }
    if input.request.task_mutation_permitted() {
        blockers
            .push(CodexAppServerCallbackResponseExecutionPolicyBlocker::RequestPermitsTaskMutation);
    }
    if input.admission.task_mutation_permitted {
        blockers.push(
            CodexAppServerCallbackResponseExecutionPolicyBlocker::AdmissionPermitsTaskMutation,
        );
    }
    if input.envelope.task_mutation_permitted {
        blockers.push(
            CodexAppServerCallbackResponseExecutionPolicyBlocker::EnvelopePermitsTaskMutation,
        );
    }
}

#[cfg(test)]
mod tests;
