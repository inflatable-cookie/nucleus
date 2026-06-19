use super::*;
use crate::codex_supervision::{
    admit_codex_callback_response, codex_callback_request, codex_callback_response_envelope,
    codex_callback_response_execution_policy, CodexAppServerCallbackPromptRef,
    CodexAppServerCallbackPromptRetentionPolicy, CodexAppServerCallbackRequestKind,
    CodexAppServerCallbackResponse, CodexAppServerCallbackResponseAdmissionInput,
    CodexAppServerCallbackResponseExecutionPolicyInput,
    CodexAppServerCallbackResponseExecutionPolicyRecord,
    CodexAppServerCallbackResponseExecutionToolPolicy,
    CodexAppServerCallbackResponseExecutionToolProjectionMode,
    CodexAppServerPayloadRetentionPolicy, CodexAppServerProviderCallbackId,
};
use crate::host_authority::EngineHostId;
use nucleus_agent_protocol::{AgentSessionId, ApprovalScope};
use nucleus_engine::EngineTaskWorkItemId;
use nucleus_tasks::TaskId;

fn accepted_policy() -> CodexAppServerCallbackResponseExecutionPolicyRecord {
    let request = codex_callback_request(
        &crate::codex_supervision::test_support::runtime(),
        CodexAppServerProviderCallbackId("provider-callback:1".to_owned()),
        AgentSessionId("session:1".to_owned()),
        Some("turn:provider:1".to_owned()),
        Some("item:provider:1".to_owned()),
        TaskId("task:1".to_owned()),
        EngineTaskWorkItemId("work:1".to_owned()),
        CodexAppServerCallbackRequestKind::Permission {
            scope: ApprovalScope::Command,
            options: vec!["allow".to_owned(), "deny".to_owned()],
        },
        CodexAppServerCallbackPromptRef {
            prompt_ref: "callback-prompt:1".to_owned(),
            summary: "callback summary".to_owned(),
            retention: CodexAppServerCallbackPromptRetentionPolicy::SummaryAndRefOnly,
        },
        CodexAppServerPayloadRetentionPolicy::MetadataOnly,
    )
    .expect("callback request");
    let admission = admit_codex_callback_response(CodexAppServerCallbackResponseAdmissionInput {
        request: request.clone(),
        response: CodexAppServerCallbackResponse::Permission {
            selected_option: "allow".to_owned(),
        },
        response_authority_confirmed: true,
        runtime_ready_evidence_refs: vec!["runtime-ready-evidence:1".to_owned()],
        raw_payload_policy_confirmed: true,
    });
    let envelope =
        codex_callback_response_envelope(&request, &admission).expect("callback envelope");

    codex_callback_response_execution_policy(CodexAppServerCallbackResponseExecutionPolicyInput {
        request,
        admission,
        envelope,
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: Some("runtime-session:1".to_owned()),
        adapter_id: "codex-app-server".to_owned(),
        execution_host_id: EngineHostId("host:local".to_owned()),
        operator_evidence_ref: Some("operator-evidence:callback:1".to_owned()),
        callback_kind_evidence_ref: Some("callback-kind-evidence:permission".to_owned()),
        response_shape_evidence_ref: Some("response-shape-evidence:allow".to_owned()),
        tool_policy: CodexAppServerCallbackResponseExecutionToolPolicy {
            projection_mode: CodexAppServerCallbackResponseExecutionToolProjectionMode::PortalTool,
            adapter_capability_evidence_ref: Some(
                "adapter-capability-evidence:callback-tools".to_owned(),
            ),
            portal_tool_family: Some("Effigy".to_owned()),
            published_actions: vec!["run_selector_request".to_owned()],
            flat_tool_count: 1,
        },
        automatic_callback_answer_requested: false,
        task_completion_requested: false,
        review_acceptance_requested: false,
        cancellation_requested: false,
        resume_requested: false,
        scm_mutation_requested: false,
        raw_callback_material_requested: false,
    })
}

fn ready_input() -> CodexAppServerCallbackResponseExecutorAdmissionInput {
    let policy = accepted_policy();
    CodexAppServerCallbackResponseExecutorAdmissionInput {
        request_id: policy.request_id.clone(),
        callback_response_id: policy.admission_id.clone(),
        envelope_id: policy.envelope_id.clone(),
        provider_callback_id: policy.provider_callback_id.clone(),
        task_id: policy.task_id.clone(),
        work_item_id: policy.work_item_id.clone(),
        provider_instance_id: policy.provider_instance_id.clone(),
        runtime_session_ref: policy.runtime_session_ref.clone().expect("runtime session"),
        callback_response_write_attempt_id: ProviderTransportWriteAttemptId(
            "provider-transport-write:callback-response:1".to_owned(),
        ),
        idempotency_key: ProviderTransportWriteIdempotencyKey(
            "codex-callback-response:provider-callback:1".to_owned(),
        ),
        evidence_refs: vec!["executor-admission-evidence:1".to_owned()],
        invoke_executor_requested: false,
        raw_callback_material_requested: false,
        task_mutation_requested: false,
        review_acceptance_requested: false,
        policy,
    }
}

#[test]
fn callback_response_executor_admission_accepts_matching_policy_without_execution() {
    let admission = admit_codex_callback_response_executor(ready_input());

    assert_eq!(
        admission.status,
        CodexAppServerCallbackResponseExecutorAdmissionStatus::AcceptedForExecutorHandoff
    );
    assert_eq!(admission.provider_callback_id, "provider-callback:1");
    assert_eq!(admission.task_id, "task:1");
    assert_eq!(admission.work_item_id, "work:1");
    assert_eq!(admission.provider_instance_id, "codex:local-default");
    assert_eq!(admission.runtime_session_ref, "runtime-session:1");
    assert_eq!(
        admission.callback_response_write_attempt_id,
        ProviderTransportWriteAttemptId("provider-transport-write:callback-response:1".to_owned())
    );
    assert_eq!(
        admission.idempotency_key,
        ProviderTransportWriteIdempotencyKey(
            "codex-callback-response:provider-callback:1".to_owned()
        )
    );
    assert!(admission
        .evidence_refs
        .contains(&"executor-admission-evidence:1".to_owned()));
    assert!(!admission.executor_invoked);
    assert!(!admission.provider_write_executed);
    assert!(!admission.raw_callback_material_retained);
    assert!(!admission.task_mutation_permitted);
    assert!(!admission.review_acceptance_permitted);
}

#[test]
fn callback_response_executor_admission_blocks_non_accepted_policy() {
    let mut input = ready_input();
    input.policy.status = CodexAppServerCallbackResponseExecutionPolicyStatus::Blocked;

    let admission = admit_codex_callback_response_executor(input);

    assert_eq!(
        admission.status,
        CodexAppServerCallbackResponseExecutorAdmissionStatus::Blocked
    );
    assert!(admission
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutorAdmissionBlocker::PolicyNotAccepted));
}

#[test]
fn callback_response_executor_admission_blocks_missing_identity() {
    let mut input = ready_input();
    input.request_id.clear();
    input.callback_response_id.clear();
    input.envelope_id.clear();
    input.provider_callback_id.clear();
    input.task_id.clear();
    input.work_item_id.clear();
    input.provider_instance_id.clear();
    input.runtime_session_ref.clear();
    input.callback_response_write_attempt_id = ProviderTransportWriteAttemptId(String::new());
    input.idempotency_key = ProviderTransportWriteIdempotencyKey(String::new());

    let admission = admit_codex_callback_response_executor(input);

    assert_eq!(
        admission.status,
        CodexAppServerCallbackResponseExecutorAdmissionStatus::Blocked
    );
    assert!(admission
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingRequestId));
    assert!(admission.blockers.contains(
        &CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingCallbackResponseId
    ));
    assert!(admission
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingEnvelopeId));
    assert!(admission.blockers.contains(
        &CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingProviderCallbackId
    ));
    assert!(admission
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingTaskId));
    assert!(admission
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingWorkItemId));
    assert!(admission.blockers.contains(
        &CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingProviderInstanceId
    ));
    assert!(admission.blockers.contains(
        &CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingRuntimeSessionRef
    ));
    assert!(admission.blockers.contains(
        &CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingCallbackResponseWriteAttemptId
    ));
    assert!(admission
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutorAdmissionBlocker::MissingIdempotencyKey));
}

#[test]
fn callback_response_executor_admission_blocks_identity_mismatch() {
    let mut input = ready_input();
    input.request_id = "request:other".to_owned();
    input.callback_response_id = "callback-response:other".to_owned();
    input.envelope_id = "envelope:other".to_owned();
    input.provider_callback_id = "provider-callback:other".to_owned();
    input.task_id = "task:other".to_owned();
    input.work_item_id = "work:other".to_owned();
    input.provider_instance_id = "codex:other".to_owned();
    input.runtime_session_ref = "runtime-session:other".to_owned();

    let admission = admit_codex_callback_response_executor(input);

    assert_eq!(
        admission.status,
        CodexAppServerCallbackResponseExecutorAdmissionStatus::Blocked
    );
    assert!(admission
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutorAdmissionBlocker::RequestPolicyMismatch));
    assert!(admission.blockers.contains(
        &CodexAppServerCallbackResponseExecutorAdmissionBlocker::CallbackResponsePolicyMismatch
    ));
    assert!(admission
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutorAdmissionBlocker::EnvelopePolicyMismatch));
    assert!(admission.blockers.contains(
        &CodexAppServerCallbackResponseExecutorAdmissionBlocker::ProviderCallbackPolicyMismatch
    ));
    assert!(admission
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutorAdmissionBlocker::TaskPolicyMismatch));
    assert!(admission
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutorAdmissionBlocker::WorkItemPolicyMismatch));
    assert!(admission.blockers.contains(
        &CodexAppServerCallbackResponseExecutorAdmissionBlocker::ProviderInstancePolicyMismatch
    ));
    assert!(admission.blockers.contains(
        &CodexAppServerCallbackResponseExecutorAdmissionBlocker::RuntimeSessionPolicyMismatch
    ));
}

#[test]
fn callback_response_executor_admission_blocks_inspect_only_violations() {
    let mut input = ready_input();
    input.invoke_executor_requested = true;
    input.raw_callback_material_requested = true;
    input.task_mutation_requested = true;
    input.review_acceptance_requested = true;

    let admission = admit_codex_callback_response_executor(input);

    assert_eq!(
        admission.blockers,
        vec![
            CodexAppServerCallbackResponseExecutorAdmissionBlocker::ExecutorInvocationRequested,
            CodexAppServerCallbackResponseExecutorAdmissionBlocker::RawCallbackMaterialRequested,
            CodexAppServerCallbackResponseExecutorAdmissionBlocker::TaskMutationRequested,
            CodexAppServerCallbackResponseExecutorAdmissionBlocker::ReviewAcceptanceRequested,
        ]
    );
    assert!(!admission.executor_invoked);
    assert!(!admission.provider_write_executed);
    assert!(!admission.task_mutation_permitted);
    assert!(!admission.review_acceptance_permitted);
}
