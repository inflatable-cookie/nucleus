use super::*;
use crate::codex_supervision::{
    admit_codex_recovery, codex_recovery_envelope, codex_recovery_need_record,
    test_support::{metadata_only, runtime, session_binding, task_id, work_item_id},
    CodexAppServerRecoveryAdmissionInput, CodexAppServerRecoveryCapability,
    CodexAppServerRecoveryEnvelopeId, CodexAppServerRecoveryEnvelopeRecord,
    CodexAppServerRecoverySummaryRef,
};

fn summary_ref() -> CodexAppServerRecoverySummaryRef {
    CodexAppServerRecoverySummaryRef {
        summary_ref: "recovery-summary:1".to_owned(),
        summary: "Codex process exited while a task-backed turn was active".to_owned(),
    }
}

fn need(trigger: CodexAppServerRecoveryTrigger) -> CodexAppServerRecoveryNeedRecord {
    codex_recovery_need_record(
        &runtime(),
        &session_binding(),
        Some("turn:provider:1".to_owned()),
        Some("request:provider:1".to_owned()),
        task_id(),
        work_item_id(),
        trigger,
        summary_ref(),
        metadata_only(),
    )
    .expect("recovery need")
}

fn ready_need() -> CodexAppServerRecoveryNeedRecord {
    need(CodexAppServerRecoveryTrigger::ProcessExit {
        exit_summary: "process exited before terminal turn event".to_owned(),
    })
}

fn accepted_admission(need: CodexAppServerRecoveryNeedRecord) -> CodexAppServerRecoveryAdmission {
    admit_codex_recovery(CodexAppServerRecoveryAdmissionInput {
        need,
        recovery_authority_confirmed: true,
        runtime_ready_evidence_refs: vec!["evidence:runtime-ready".to_owned()],
        provider_identity_evidence_refs: vec!["evidence:provider-thread".to_owned()],
        resume_capability: CodexAppServerRecoveryCapability::ThreadResumeSupported,
        replacement_thread_observed: false,
        raw_payload_policy_confirmed: true,
    })
}

fn ready_input() -> CodexAppServerRecoveryExecutionPolicyInput {
    let need = ready_need();
    let admission = accepted_admission(need.clone());
    let envelope = codex_recovery_envelope(&need, &admission).expect("envelope");

    CodexAppServerRecoveryExecutionPolicyInput {
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
    }
}

#[test]
fn recovery_execution_policy_accepts_thread_resume_without_execution() {
    let record = codex_recovery_execution_policy(ready_input());

    assert_eq!(
        record.status,
        CodexAppServerRecoveryExecutionPolicyStatus::AcceptedForExecutionAdmission
    );
    assert!(record.blockers.is_empty());
    assert_eq!(record.provider_thread_id, "thread:provider:1");
    assert_eq!(record.provider_turn_id.as_deref(), Some("turn:provider:1"));
    assert_eq!(
        record.provider_request_id.as_deref(),
        Some("request:provider:1")
    );
    assert_eq!(record.task_id, "task:1");
    assert_eq!(record.work_item_id, "work:1");
    assert_eq!(record.method, "thread/resume");
    assert!(record.evidence_refs.contains(&"tool:Effigy".to_owned()));
    assert!(!record.provider_write_executed);
    assert!(!record.automatic_resume_permitted);
    assert!(!record.replacement_thread_promotion_permitted);
    assert!(!record.task_completion_permitted);
    assert!(!record.review_acceptance_permitted);
    assert!(!record.interruption_permitted);
    assert!(!record.callback_answer_permitted);
    assert!(!record.scm_mutation_permitted);
    assert!(!record.raw_provider_material_retained);
    assert!(!record.raw_callback_material_retained);
}

#[test]
fn recovery_execution_policy_blocks_missing_required_evidence() {
    let mut input = ready_input();
    input.provider_instance_id.clear();
    input.runtime_session_ref = None;
    input.adapter_id.clear();
    input.execution_host_id = EngineHostId(String::new());
    input.operator_evidence_ref = None;
    input.recovery_target_evidence_ref = None;
    input.provider_identity_evidence_ref = None;
    input.resume_capability_evidence_ref = None;

    let record = codex_recovery_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerRecoveryExecutionPolicyStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::MissingProviderInstanceId));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::MissingRuntimeSessionRef));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::MissingAdapterId));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::MissingExecutionHostId));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::MissingOperatorEvidence));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::MissingRecoveryTargetEvidence));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::MissingProviderIdentityEvidence));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::MissingResumeCapabilityEvidence));
}

#[test]
fn recovery_execution_policy_blocks_non_accepted_admission() {
    let need = ready_need();
    let blocked_admission = admit_codex_recovery(CodexAppServerRecoveryAdmissionInput {
        need: need.clone(),
        recovery_authority_confirmed: false,
        runtime_ready_evidence_refs: vec!["evidence:runtime-ready".to_owned()],
        provider_identity_evidence_refs: vec!["evidence:provider-thread".to_owned()],
        resume_capability: CodexAppServerRecoveryCapability::ThreadResumeSupported,
        replacement_thread_observed: false,
        raw_payload_policy_confirmed: true,
    });
    let accepted_admission = accepted_admission(need.clone());
    let envelope = codex_recovery_envelope(&need, &accepted_admission).expect("envelope");
    let mut input = ready_input();
    input.need = need;
    input.admission = blocked_admission;
    input.envelope = envelope;

    let record = codex_recovery_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerRecoveryExecutionPolicyStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::AdmissionNotAccepted));
}

#[test]
fn recovery_execution_policy_blocks_identity_mismatch() {
    let mut input = ready_input();
    input.need = need(CodexAppServerRecoveryTrigger::ServerRestart {
        restart_summary: "server restarted".to_owned(),
    });

    let record = codex_recovery_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerRecoveryExecutionPolicyStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::NeedAdmissionMismatch));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::NeedEnvelopeMismatch));
}

#[test]
fn recovery_execution_policy_blocks_provider_identity_mismatch_trigger() {
    let need = need(CodexAppServerRecoveryTrigger::ProviderIdentityMismatch {
        expected_thread_id: Some("thread:provider:1".to_owned()),
        observed_thread_id: Some("thread:replacement:1".to_owned()),
    });
    let admission = accepted_admission(need.clone());
    let envelope = CodexAppServerRecoveryEnvelopeRecord {
        envelope_id: CodexAppServerRecoveryEnvelopeId(format!(
            "codex-recovery-envelope:{}",
            need.need_id.0
        )),
        admission_id: admission.admission_id.0.clone(),
        need_id: need.need_id.0.clone(),
        method: "thread/resume".to_owned(),
        runtime_instance_id: need.runtime_instance_id.clone(),
        session_id: need.session_id.0.clone(),
        provider_thread_id: need.provider_thread_id.clone().expect("provider thread id"),
        provider_turn_id: need.provider_turn_id.clone(),
        provider_request_id: need.provider_request_id.clone(),
        task_id: need.task_id.0.clone(),
        work_item_id: need.work_item_id.0.clone(),
        evidence_refs: need.evidence_refs.clone(),
        raw_payload_retained: false,
        provider_send_started: false,
        replacement_thread_allowed: false,
        task_mutation_permitted: false,
    };
    let mut input = ready_input();
    input.need = need;
    input.admission = admission;
    input.envelope = envelope;

    let record = codex_recovery_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerRecoveryExecutionPolicyStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::ProviderIdentityMismatchTrigger));
}

#[test]
fn recovery_execution_policy_blocks_flat_tool_overload() {
    let mut input = ready_input();
    input.tool_policy = CodexAppServerRecoveryExecutionToolPolicy {
        projection_mode: CodexAppServerRecoveryExecutionToolProjectionMode::NativeToolRegistration,
        adapter_capability_evidence_ref: Some("adapter-capability-evidence:tools".to_owned()),
        portal_tool_family: None,
        published_actions: vec![
            "resume_thread".to_owned(),
            "repair_binding".to_owned(),
            "inspect_provider".to_owned(),
            "cleanup_process".to_owned(),
        ],
        flat_tool_count: 4,
    };

    let record = codex_recovery_execution_policy(input);

    assert_eq!(
        record.blockers,
        vec![
            CodexAppServerRecoveryExecutionPolicyBlocker::FlatToolMenuRequested {
                flat_tool_count: 4
            }
        ]
    );
}

#[test]
fn recovery_execution_policy_blocks_authority_widening() {
    let mut input = ready_input();
    input.automatic_resume_requested = true;
    input.replacement_thread_promotion_requested = true;
    input.task_completion_requested = true;
    input.review_acceptance_requested = true;
    input.interruption_requested = true;
    input.callback_answer_requested = true;
    input.scm_mutation_requested = true;
    input.raw_provider_material_requested = true;
    input.raw_callback_material_requested = true;

    let record = codex_recovery_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerRecoveryExecutionPolicyStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::AutomaticResumeRequested));
    assert!(record.blockers.contains(
        &CodexAppServerRecoveryExecutionPolicyBlocker::ReplacementThreadPromotionRequested
    ));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::TaskCompletionRequested));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::ReviewAcceptanceRequested));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::InterruptionRequested));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::CallbackAnswerRequested));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::ScmMutationRequested));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::RawProviderMaterialRequested));
    assert!(record
        .blockers
        .contains(&CodexAppServerRecoveryExecutionPolicyBlocker::RawCallbackMaterialRequested));
}
