use super::*;
use crate::codex_supervision::{
    admit_codex_recovery, codex_recovery_envelope, codex_recovery_execution_policy,
    codex_recovery_need_record,
    test_support::{metadata_only, runtime, session_binding, task_id, work_item_id},
    CodexAppServerRecoveryAdmissionInput, CodexAppServerRecoveryCapability,
    CodexAppServerRecoveryExecutionPolicyInput, CodexAppServerRecoveryExecutionToolPolicy,
    CodexAppServerRecoveryExecutionToolProjectionMode, CodexAppServerRecoverySummaryRef,
    CodexAppServerRecoveryTrigger,
};
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptId, ProviderTransportWriteIdempotencyKey,
};
use crate::EngineHostId;

fn summary_ref() -> CodexAppServerRecoverySummaryRef {
    CodexAppServerRecoverySummaryRef {
        summary_ref: "recovery-summary:1".to_owned(),
        summary: "Codex process exited while a task-backed turn was active".to_owned(),
    }
}

fn policy() -> CodexAppServerRecoveryExecutionPolicyRecord {
    let need = codex_recovery_need_record(
        &runtime(),
        &session_binding(),
        Some("turn:provider:1".to_owned()),
        Some("request:provider:1".to_owned()),
        task_id(),
        work_item_id(),
        CodexAppServerRecoveryTrigger::ProcessExit {
            exit_summary: "process exited before terminal turn event".to_owned(),
        },
        summary_ref(),
        metadata_only(),
    )
    .expect("recovery need");
    let admission = admit_codex_recovery(CodexAppServerRecoveryAdmissionInput {
        need: need.clone(),
        recovery_authority_confirmed: true,
        runtime_ready_evidence_refs: vec!["evidence:runtime-ready".to_owned()],
        provider_identity_evidence_refs: vec!["evidence:provider-thread".to_owned()],
        resume_capability: CodexAppServerRecoveryCapability::ThreadResumeSupported,
        replacement_thread_observed: false,
        raw_payload_policy_confirmed: true,
    });
    let envelope = codex_recovery_envelope(&need, &admission).expect("envelope");

    codex_recovery_execution_policy(CodexAppServerRecoveryExecutionPolicyInput {
        need,
        admission,
        envelope,
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: Some("runtime-session:1".to_owned()),
        adapter_id: "codex-app-server".to_owned(),
        execution_host_id: EngineHostId("host:local".to_owned()),
        operator_evidence_ref: Some("operator-evidence:recovery:1".to_owned()),
        recovery_target_evidence_ref: Some("recovery-target-evidence:thread:1".to_owned()),
        provider_identity_evidence_ref: Some("provider-identity-evidence:thread:1".to_owned()),
        resume_capability_evidence_ref: Some("resume-capability-evidence:thread-resume".to_owned()),
        tool_policy: CodexAppServerRecoveryExecutionToolPolicy {
            projection_mode: CodexAppServerRecoveryExecutionToolProjectionMode::PortalTool,
            adapter_capability_evidence_ref: Some(
                "adapter-capability-evidence:recovery-tools".to_owned(),
            ),
            portal_tool_family: Some("Effigy".to_owned()),
            published_actions: vec!["run_selector_request".to_owned()],
            flat_tool_count: 1,
        },
        automatic_resume_requested: false,
        replacement_thread_promotion_requested: false,
        task_completion_requested: false,
        review_acceptance_requested: false,
        interruption_requested: false,
        callback_answer_requested: false,
        scm_mutation_requested: false,
        raw_provider_material_requested: false,
        raw_callback_material_requested: false,
    })
}

fn input() -> CodexAppServerRecoveryExecutorAdmissionInput {
    let policy = policy();
    CodexAppServerRecoveryExecutorAdmissionInput {
        need_id: policy.need_id.clone(),
        envelope_id: policy.envelope_id.clone(),
        provider_thread_id: policy.provider_thread_id.clone(),
        provider_turn_id: policy.provider_turn_id.clone(),
        provider_request_id: policy.provider_request_id.clone(),
        task_id: policy.task_id.clone(),
        work_item_id: policy.work_item_id.clone(),
        provider_instance_id: policy.provider_instance_id.clone(),
        runtime_session_ref: policy
            .runtime_session_ref
            .clone()
            .expect("runtime session ref"),
        recovery_write_attempt_id: ProviderTransportWriteAttemptId(
            "write-attempt:recovery:1".to_owned(),
        ),
        idempotency_key: ProviderTransportWriteIdempotencyKey("idempotency:recovery:1".to_owned()),
        evidence_refs: vec!["evidence:recovery-write:1".to_owned()],
        invoke_executor_requested: false,
        raw_provider_material_requested: false,
        raw_callback_material_requested: false,
        task_mutation_requested: false,
        review_acceptance_requested: false,
        replacement_thread_promotion_requested: false,
        interruption_requested: false,
        callback_answer_requested: false,
        scm_mutation_requested: false,
        policy,
    }
}

#[test]
fn recovery_executor_admission_accepts_policy_without_invoking_executor() {
    let record = admit_codex_recovery_executor(input());

    assert_eq!(
        record.status,
        CodexAppServerRecoveryExecutorAdmissionStatus::AcceptedForExecutorHandoff
    );
    assert!(record.blockers.is_empty());
    assert!(record.admission_id.0.contains("write-attempt:recovery:1"));
    assert_eq!(record.provider_thread_id, "thread:provider:1");
    assert_eq!(record.provider_turn_id.as_deref(), Some("turn:provider:1"));
    assert_eq!(
        record.provider_request_id.as_deref(),
        Some("request:provider:1")
    );
    assert_eq!(record.task_id, "task:1");
    assert_eq!(record.work_item_id, "work:1");
    assert!(!record.executor_invoked);
    assert!(!record.provider_write_executed);
    assert!(!record.raw_provider_material_retained);
    assert!(!record.raw_callback_material_retained);
    assert!(!record.task_mutation_permitted);
    assert!(!record.review_acceptance_permitted);
    assert!(!record.replacement_thread_promotion_permitted);
    assert!(!record.interruption_permitted);
    assert!(!record.callback_answer_permitted);
    assert!(!record.scm_mutation_permitted);
}

#[test]
fn recovery_executor_admission_blocks_missing_identity() {
    let mut input = input();
    input.need_id.clear();
    input.envelope_id.clear();
    input.provider_thread_id.clear();
    input.provider_turn_id = Some(String::new());
    input.provider_request_id = Some(String::new());
    input.task_id.clear();
    input.work_item_id.clear();
    input.provider_instance_id.clear();
    input.runtime_session_ref.clear();
    input.recovery_write_attempt_id = ProviderTransportWriteAttemptId(String::new());
    input.idempotency_key = ProviderTransportWriteIdempotencyKey(String::new());

    let record = admit_codex_recovery_executor(input);

    assert_eq!(
        record.status,
        CodexAppServerRecoveryExecutorAdmissionStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::MissingNeedId));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::MissingEnvelopeId));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::MissingProviderThreadId));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::EmptyProviderTurnId));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::EmptyProviderRequestId));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::MissingTaskId));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::MissingWorkItemId));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::MissingProviderInstanceId));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::MissingRuntimeSessionRef));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::MissingRecoveryWriteAttemptId));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::MissingIdempotencyKey));
}

#[test]
fn recovery_executor_admission_blocks_identity_mismatch() {
    let mut input = input();
    input.need_id = "other-need".to_owned();
    input.envelope_id = "other-envelope".to_owned();
    input.provider_thread_id = "other-thread".to_owned();
    input.provider_turn_id = Some("other-turn".to_owned());
    input.provider_request_id = Some("other-request".to_owned());
    input.task_id = "other-task".to_owned();
    input.work_item_id = "other-work".to_owned();
    input.provider_instance_id = "other-provider".to_owned();
    input.runtime_session_ref = "other-runtime-session".to_owned();

    let record = admit_codex_recovery_executor(input);

    assert_eq!(
        record.status,
        CodexAppServerRecoveryExecutorAdmissionStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::NeedPolicyMismatch));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::EnvelopePolicyMismatch));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::ProviderThreadPolicyMismatch));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::ProviderTurnPolicyMismatch));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::ProviderRequestPolicyMismatch));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::TaskPolicyMismatch));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::WorkItemPolicyMismatch));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::ProviderInstancePolicyMismatch));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::RuntimeSessionPolicyMismatch));
}

#[test]
fn recovery_executor_admission_blocks_non_accepted_policy() {
    let mut input = input();
    input.policy.status = CodexAppServerRecoveryExecutionPolicyStatus::Blocked;

    let record = admit_codex_recovery_executor(input);

    assert_eq!(
        record.status,
        CodexAppServerRecoveryExecutorAdmissionStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::PolicyNotAccepted));
}

#[test]
fn recovery_executor_admission_blocks_execution_and_authority_requests() {
    let mut input = input();
    input.invoke_executor_requested = true;
    input.raw_provider_material_requested = true;
    input.raw_callback_material_requested = true;
    input.task_mutation_requested = true;
    input.review_acceptance_requested = true;
    input.replacement_thread_promotion_requested = true;
    input.interruption_requested = true;
    input.callback_answer_requested = true;
    input.scm_mutation_requested = true;

    let record = admit_codex_recovery_executor(input);

    assert_eq!(
        record.status,
        CodexAppServerRecoveryExecutorAdmissionStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::ExecutorInvocationRequested));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::RawProviderMaterialRequested));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::RawCallbackMaterialRequested));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::TaskMutationRequested));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::ReviewAcceptanceRequested));
    assert!(record.blockers.contains(
        &CodexAppServerRecoveryExecutorAdmissionBlocker::ReplacementThreadPromotionRequested
    ));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::InterruptionRequested));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::CallbackAnswerRequested));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutorAdmissionBlocker::ScmMutationRequested));
}
