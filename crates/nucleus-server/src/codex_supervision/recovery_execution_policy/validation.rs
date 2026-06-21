use super::super::{CodexAppServerRecoveryAdmissionStatus, CodexAppServerRecoveryTrigger};
use super::{
    CodexAppServerRecoveryExecutionPolicyBlocker, CodexAppServerRecoveryExecutionPolicyInput,
    CodexAppServerRecoveryExecutionToolPolicy, CodexAppServerRecoveryExecutionToolProjectionMode,
};

const MAX_NON_PORTAL_FLAT_TOOL_COUNT: usize = 3;

pub(super) fn validate_recovery_identity(
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

pub(super) fn validate_required_evidence(
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

pub(super) fn validate_tool_policy(
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

pub(super) fn validate_forbidden_authority_requests(
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

pub(super) fn validate_raw_material_and_mutation_flags(
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
