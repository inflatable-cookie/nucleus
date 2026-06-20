use super::*;
use crate::codex_supervision::{
    admit_codex_interruption, codex_interruption_envelope, codex_interruption_execution_policy,
    codex_interruption_request, CodexAppServerInterruptionAdmissionInput,
    CodexAppServerInterruptionExecutionPolicyInput,
    CodexAppServerInterruptionExecutionPolicyRecord, CodexAppServerInterruptionExecutionToolPolicy,
    CodexAppServerInterruptionExecutionToolProjectionMode, CodexAppServerInterruptionReasonRef,
    CodexAppServerInterruptionReasonRetentionPolicy, CodexAppServerInterruptionRequestRef,
    CodexAppServerInterruptionTarget, CodexAppServerInterruptionTargetState,
    CodexAppServerPayloadRetentionPolicy,
};
use crate::host_authority::EngineHostId;
use nucleus_agent_protocol::AgentSessionId;
use nucleus_engine::EngineTaskWorkItemId;
use nucleus_tasks::TaskId;

fn accepted_policy() -> CodexAppServerInterruptionExecutionPolicyRecord {
    let request = codex_interruption_request(
        &crate::codex_supervision::test_support::runtime(),
        CodexAppServerInterruptionRequestRef("interrupt:1".to_owned()),
        AgentSessionId("session:1".to_owned()),
        CodexAppServerInterruptionTarget::ActiveTurn {
            provider_turn_id: "turn:provider:1".to_owned(),
            provider_request_id: Some("request:provider:1".to_owned()),
        },
        TaskId("task:1".to_owned()),
        EngineTaskWorkItemId("work:1".to_owned()),
        CodexAppServerInterruptionReasonRef {
            reason_ref: "interruption-reason:1".to_owned(),
            summary: "operator stopped the active turn".to_owned(),
            retention: CodexAppServerInterruptionReasonRetentionPolicy::SummaryAndRefOnly,
        },
        CodexAppServerPayloadRetentionPolicy::MetadataOnly,
    )
    .expect("interruption request");
    let admission = admit_codex_interruption(CodexAppServerInterruptionAdmissionInput {
        request: request.clone(),
        interruption_authority_confirmed: true,
        runtime_ready_evidence_refs: vec!["runtime-ready-evidence:1".to_owned()],
        target_state: CodexAppServerInterruptionTargetState::Interruptible,
        duplicate_or_in_flight: false,
        raw_payload_policy_confirmed: true,
    });
    let envelope = codex_interruption_envelope(&request, &admission).expect("envelope");

    codex_interruption_execution_policy(CodexAppServerInterruptionExecutionPolicyInput {
        request,
        admission,
        envelope,
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: Some("runtime-session:1".to_owned()),
        adapter_id: "codex-app-server".to_owned(),
        execution_host_id: EngineHostId("host:local".to_owned()),
        operator_evidence_ref: Some("operator-evidence:interrupt:1".to_owned()),
        target_evidence_ref: Some("target-evidence:active-turn:1".to_owned()),
        interruption_capability_evidence_ref: Some(
            "interruption-capability-evidence:turn-interrupt".to_owned(),
        ),
        tool_policy: CodexAppServerInterruptionExecutionToolPolicy {
            projection_mode: CodexAppServerInterruptionExecutionToolProjectionMode::PortalTool,
            adapter_capability_evidence_ref: Some(
                "adapter-capability-evidence:interruption-tools".to_owned(),
            ),
            portal_tool_family: Some("Effigy".to_owned()),
            published_actions: vec!["run_selector_request".to_owned()],
            flat_tool_count: 1,
        },
        automatic_interruption_requested: false,
        task_completion_requested: false,
        review_acceptance_requested: false,
        resume_requested: false,
        callback_answer_requested: false,
        scm_mutation_requested: false,
        raw_provider_material_requested: false,
        raw_callback_material_requested: false,
    })
}

fn ready_input() -> CodexAppServerInterruptionExecutorAdmissionInput {
    let policy = accepted_policy();
    CodexAppServerInterruptionExecutorAdmissionInput {
        request_id: policy.request_id.clone(),
        envelope_id: policy.envelope_id.clone(),
        provider_turn_id: policy.provider_turn_id.clone(),
        provider_request_id: policy.provider_request_id.clone(),
        task_id: policy.task_id.clone(),
        work_item_id: policy.work_item_id.clone(),
        provider_instance_id: policy.provider_instance_id.clone(),
        runtime_session_ref: policy.runtime_session_ref.clone().expect("runtime session"),
        interruption_write_attempt_id: ProviderTransportWriteAttemptId(
            "provider-transport-write:interruption:1".to_owned(),
        ),
        idempotency_key: ProviderTransportWriteIdempotencyKey(
            "codex-interruption:turn:provider:1".to_owned(),
        ),
        evidence_refs: vec!["interruption-executor-admission-evidence:1".to_owned()],
        invoke_executor_requested: false,
        raw_provider_material_requested: false,
        raw_callback_material_requested: false,
        task_mutation_requested: false,
        review_acceptance_requested: false,
        resume_requested: false,
        callback_answer_requested: false,
        scm_mutation_requested: false,
        policy,
    }
}

#[test]
fn interruption_executor_admission_accepts_matching_policy_without_execution() {
    let admission = admit_codex_interruption_executor(ready_input());

    assert_eq!(
        admission.status,
        CodexAppServerInterruptionExecutorAdmissionStatus::AcceptedForExecutorHandoff
    );
    assert_eq!(admission.provider_turn_id, "turn:provider:1");
    assert_eq!(
        admission.provider_request_id.as_deref(),
        Some("request:provider:1")
    );
    assert_eq!(admission.task_id, "task:1");
    assert_eq!(admission.work_item_id, "work:1");
    assert_eq!(admission.provider_instance_id, "codex:local-default");
    assert_eq!(admission.runtime_session_ref, "runtime-session:1");
    assert_eq!(
        admission.interruption_write_attempt_id,
        ProviderTransportWriteAttemptId("provider-transport-write:interruption:1".to_owned())
    );
    assert_eq!(
        admission.idempotency_key,
        ProviderTransportWriteIdempotencyKey("codex-interruption:turn:provider:1".to_owned())
    );
    assert!(admission
        .evidence_refs
        .contains(&"interruption-executor-admission-evidence:1".to_owned()));
    assert!(!admission.executor_invoked);
    assert!(!admission.provider_write_executed);
    assert!(!admission.raw_provider_material_retained);
    assert!(!admission.raw_callback_material_retained);
    assert!(!admission.task_mutation_permitted);
    assert!(!admission.review_acceptance_permitted);
    assert!(!admission.resume_permitted);
    assert!(!admission.callback_answer_permitted);
    assert!(!admission.scm_mutation_permitted);
}

#[test]
fn interruption_executor_admission_blocks_non_accepted_policy() {
    let mut input = ready_input();
    input.policy.status = CodexAppServerInterruptionExecutionPolicyStatus::Blocked;

    let admission = admit_codex_interruption_executor(input);

    assert_eq!(
        admission.status,
        CodexAppServerInterruptionExecutorAdmissionStatus::Blocked
    );
    assert!(admission
        .blockers
        .contains(&CodexAppServerInterruptionExecutorAdmissionBlocker::PolicyNotAccepted));
}

#[test]
fn interruption_executor_admission_blocks_missing_identity() {
    let mut input = ready_input();
    input.request_id.clear();
    input.envelope_id.clear();
    input.provider_turn_id.clear();
    input.provider_request_id = Some(String::new());
    input.task_id.clear();
    input.work_item_id.clear();
    input.provider_instance_id.clear();
    input.runtime_session_ref.clear();
    input.interruption_write_attempt_id = ProviderTransportWriteAttemptId(String::new());
    input.idempotency_key = ProviderTransportWriteIdempotencyKey(String::new());

    let admission = admit_codex_interruption_executor(input);

    assert_eq!(
        admission.status,
        CodexAppServerInterruptionExecutorAdmissionStatus::Blocked
    );
    assert!(admission
        .blockers
        .contains(&CodexAppServerInterruptionExecutorAdmissionBlocker::MissingRequestId));
    assert!(admission
        .blockers
        .contains(&CodexAppServerInterruptionExecutorAdmissionBlocker::MissingEnvelopeId));
    assert!(admission
        .blockers
        .contains(&CodexAppServerInterruptionExecutorAdmissionBlocker::MissingProviderTurnId));
    assert!(admission
        .blockers
        .contains(&CodexAppServerInterruptionExecutorAdmissionBlocker::EmptyProviderRequestId));
    assert!(admission
        .blockers
        .contains(&CodexAppServerInterruptionExecutorAdmissionBlocker::MissingTaskId));
    assert!(admission
        .blockers
        .contains(&CodexAppServerInterruptionExecutorAdmissionBlocker::MissingWorkItemId));
    assert!(admission
        .blockers
        .contains(&CodexAppServerInterruptionExecutorAdmissionBlocker::MissingProviderInstanceId));
    assert!(admission
        .blockers
        .contains(&CodexAppServerInterruptionExecutorAdmissionBlocker::MissingRuntimeSessionRef));
    assert!(admission.blockers.contains(
        &CodexAppServerInterruptionExecutorAdmissionBlocker::MissingInterruptionWriteAttemptId
    ));
    assert!(admission
        .blockers
        .contains(&CodexAppServerInterruptionExecutorAdmissionBlocker::MissingIdempotencyKey));
}

#[test]
fn interruption_executor_admission_blocks_identity_mismatch() {
    let mut input = ready_input();
    input.request_id = "request:other".to_owned();
    input.envelope_id = "envelope:other".to_owned();
    input.provider_turn_id = "turn:provider:other".to_owned();
    input.provider_request_id = Some("request:provider:other".to_owned());
    input.task_id = "task:other".to_owned();
    input.work_item_id = "work:other".to_owned();
    input.provider_instance_id = "codex:other".to_owned();
    input.runtime_session_ref = "runtime-session:other".to_owned();

    let admission = admit_codex_interruption_executor(input);

    assert_eq!(
        admission.status,
        CodexAppServerInterruptionExecutorAdmissionStatus::Blocked
    );
    assert!(admission
        .blockers
        .contains(&CodexAppServerInterruptionExecutorAdmissionBlocker::RequestPolicyMismatch));
    assert!(admission
        .blockers
        .contains(&CodexAppServerInterruptionExecutorAdmissionBlocker::EnvelopePolicyMismatch));
    assert!(admission
        .blockers
        .contains(&CodexAppServerInterruptionExecutorAdmissionBlocker::ProviderTurnPolicyMismatch));
    assert!(admission.blockers.contains(
        &CodexAppServerInterruptionExecutorAdmissionBlocker::ProviderRequestPolicyMismatch
    ));
    assert!(admission
        .blockers
        .contains(&CodexAppServerInterruptionExecutorAdmissionBlocker::TaskPolicyMismatch));
    assert!(admission
        .blockers
        .contains(&CodexAppServerInterruptionExecutorAdmissionBlocker::WorkItemPolicyMismatch));
    assert!(admission.blockers.contains(
        &CodexAppServerInterruptionExecutorAdmissionBlocker::ProviderInstancePolicyMismatch
    ));
    assert!(admission.blockers.contains(
        &CodexAppServerInterruptionExecutorAdmissionBlocker::RuntimeSessionPolicyMismatch
    ));
}

#[test]
fn interruption_executor_admission_blocks_inspect_only_violations() {
    let mut input = ready_input();
    input.invoke_executor_requested = true;
    input.raw_provider_material_requested = true;
    input.raw_callback_material_requested = true;
    input.task_mutation_requested = true;
    input.review_acceptance_requested = true;
    input.resume_requested = true;
    input.callback_answer_requested = true;
    input.scm_mutation_requested = true;

    let admission = admit_codex_interruption_executor(input);

    assert_eq!(
        admission.blockers,
        vec![
            CodexAppServerInterruptionExecutorAdmissionBlocker::ExecutorInvocationRequested,
            CodexAppServerInterruptionExecutorAdmissionBlocker::RawProviderMaterialRequested,
            CodexAppServerInterruptionExecutorAdmissionBlocker::RawCallbackMaterialRequested,
            CodexAppServerInterruptionExecutorAdmissionBlocker::TaskMutationRequested,
            CodexAppServerInterruptionExecutorAdmissionBlocker::ReviewAcceptanceRequested,
            CodexAppServerInterruptionExecutorAdmissionBlocker::ResumeRequested,
            CodexAppServerInterruptionExecutorAdmissionBlocker::CallbackAnswerRequested,
            CodexAppServerInterruptionExecutorAdmissionBlocker::ScmMutationRequested,
        ]
    );
    assert!(!admission.executor_invoked);
    assert!(!admission.provider_write_executed);
    assert!(!admission.task_mutation_permitted);
    assert!(!admission.review_acceptance_permitted);
    assert!(!admission.resume_permitted);
    assert!(!admission.callback_answer_permitted);
    assert!(!admission.scm_mutation_permitted);
}
