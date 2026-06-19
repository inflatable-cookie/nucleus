use super::*;
use crate::codex_supervision::{
    admit_codex_interruption, codex_interruption_envelope, codex_interruption_request,
    CodexAppServerInterruptionAdmissionInput, CodexAppServerInterruptionReasonRef,
    CodexAppServerInterruptionReasonRetentionPolicy, CodexAppServerInterruptionRequestRef,
    CodexAppServerInterruptionTargetState, CodexAppServerPayloadRetentionPolicy,
};
use nucleus_agent_protocol::AgentSessionId;
use nucleus_engine::EngineTaskWorkItemId;
use nucleus_tasks::TaskId;

fn ready_input() -> CodexAppServerInterruptionExecutionPolicyInput {
    let request = interruption_request("1");
    let admission = admit_codex_interruption(CodexAppServerInterruptionAdmissionInput {
        request: request.clone(),
        interruption_authority_confirmed: true,
        runtime_ready_evidence_refs: vec!["runtime-ready-evidence:1".to_owned()],
        target_state: CodexAppServerInterruptionTargetState::Interruptible,
        duplicate_or_in_flight: false,
        raw_payload_policy_confirmed: true,
    });
    let envelope = codex_interruption_envelope(&request, &admission).expect("envelope");

    CodexAppServerInterruptionExecutionPolicyInput {
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
    }
}

#[test]
fn interruption_execution_policy_accepts_interruptible_target_without_execution() {
    let record = codex_interruption_execution_policy(ready_input());

    assert_eq!(
        record.status,
        CodexAppServerInterruptionExecutionPolicyStatus::AcceptedForExecutionAdmission
    );
    assert!(record.blockers.is_empty());
    assert_eq!(record.provider_turn_id, "turn:provider:1");
    assert_eq!(
        record.provider_request_id.as_deref(),
        Some("request:provider:1")
    );
    assert_eq!(record.task_id, "task:1");
    assert_eq!(record.work_item_id, "work:1");
    assert_eq!(record.method, "turn/interrupt");
    assert!(record.evidence_refs.contains(&"tool:Effigy".to_owned()));
    assert!(!record.provider_write_executed);
    assert!(!record.automatic_interruption_permitted);
    assert!(!record.task_completion_permitted);
    assert!(!record.review_acceptance_permitted);
    assert!(!record.resume_permitted);
    assert!(!record.callback_answer_permitted);
    assert!(!record.scm_mutation_permitted);
    assert!(!record.raw_provider_material_retained);
    assert!(!record.raw_callback_material_retained);
}

#[test]
fn interruption_execution_policy_blocks_missing_required_evidence() {
    let mut input = ready_input();
    input.provider_instance_id.clear();
    input.runtime_session_ref = None;
    input.adapter_id.clear();
    input.execution_host_id = EngineHostId(String::new());
    input.operator_evidence_ref = None;
    input.target_evidence_ref = None;
    input.interruption_capability_evidence_ref = None;

    let record = codex_interruption_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerInterruptionExecutionPolicyStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&CodexAppServerInterruptionExecutionPolicyBlocker::MissingProviderInstanceId));
    assert!(record
        .blockers
        .contains(&CodexAppServerInterruptionExecutionPolicyBlocker::MissingRuntimeSessionRef));
    assert!(record
        .blockers
        .contains(&CodexAppServerInterruptionExecutionPolicyBlocker::MissingAdapterId));
    assert!(record
        .blockers
        .contains(&CodexAppServerInterruptionExecutionPolicyBlocker::MissingExecutionHostId));
    assert!(record
        .blockers
        .contains(&CodexAppServerInterruptionExecutionPolicyBlocker::MissingOperatorEvidence));
    assert!(record
        .blockers
        .contains(&CodexAppServerInterruptionExecutionPolicyBlocker::MissingTargetEvidence));
    assert!(record.blockers.contains(
        &CodexAppServerInterruptionExecutionPolicyBlocker::MissingInterruptionCapabilityEvidence
    ));
}

#[test]
fn interruption_execution_policy_blocks_non_accepted_admission() {
    let request = interruption_request("1");
    let blocked_admission = admit_codex_interruption(CodexAppServerInterruptionAdmissionInput {
        request: request.clone(),
        interruption_authority_confirmed: false,
        runtime_ready_evidence_refs: vec!["runtime-ready-evidence:1".to_owned()],
        target_state: CodexAppServerInterruptionTargetState::Interruptible,
        duplicate_or_in_flight: false,
        raw_payload_policy_confirmed: true,
    });
    let accepted_admission = admit_codex_interruption(CodexAppServerInterruptionAdmissionInput {
        request: request.clone(),
        interruption_authority_confirmed: true,
        runtime_ready_evidence_refs: vec!["runtime-ready-evidence:1".to_owned()],
        target_state: CodexAppServerInterruptionTargetState::Interruptible,
        duplicate_or_in_flight: false,
        raw_payload_policy_confirmed: true,
    });
    let envelope = codex_interruption_envelope(&request, &accepted_admission).expect("envelope");
    let mut input = ready_input();
    input.request = request;
    input.admission = blocked_admission;
    input.envelope = envelope;

    let record = codex_interruption_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerInterruptionExecutionPolicyStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&CodexAppServerInterruptionExecutionPolicyBlocker::AdmissionNotAccepted));
}

#[test]
fn interruption_execution_policy_blocks_identity_mismatch() {
    let mut input = ready_input();
    input.request = interruption_request("other");

    let record = codex_interruption_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerInterruptionExecutionPolicyStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&CodexAppServerInterruptionExecutionPolicyBlocker::RequestAdmissionMismatch));
    assert!(record
        .blockers
        .contains(&CodexAppServerInterruptionExecutionPolicyBlocker::RequestEnvelopeMismatch));
    assert!(record
        .blockers
        .contains(&CodexAppServerInterruptionExecutionPolicyBlocker::SessionMismatch));
    assert!(record
        .blockers
        .contains(&CodexAppServerInterruptionExecutionPolicyBlocker::TargetMismatch));
    assert!(record
        .blockers
        .contains(&CodexAppServerInterruptionExecutionPolicyBlocker::TaskMismatch));
    assert!(record
        .blockers
        .contains(&CodexAppServerInterruptionExecutionPolicyBlocker::WorkItemMismatch));
}

#[test]
fn interruption_execution_policy_blocks_flat_tool_overload() {
    let mut input = ready_input();
    input.tool_policy = CodexAppServerInterruptionExecutionToolPolicy {
        projection_mode:
            CodexAppServerInterruptionExecutionToolProjectionMode::NativeToolRegistration,
        adapter_capability_evidence_ref: Some("adapter-capability-evidence:tools".to_owned()),
        portal_tool_family: None,
        published_actions: vec![
            "interrupt_active_turn".to_owned(),
            "cancel_request".to_owned(),
            "cleanup_process".to_owned(),
            "repair_binding".to_owned(),
        ],
        flat_tool_count: 4,
    };

    let record = codex_interruption_execution_policy(input);

    assert_eq!(
        record.blockers,
        vec![
            CodexAppServerInterruptionExecutionPolicyBlocker::FlatToolMenuRequested {
                flat_tool_count: 4
            }
        ]
    );
}

#[test]
fn interruption_execution_policy_blocks_forbidden_authority_requests() {
    let mut input = ready_input();
    input.automatic_interruption_requested = true;
    input.task_completion_requested = true;
    input.review_acceptance_requested = true;
    input.resume_requested = true;
    input.callback_answer_requested = true;
    input.scm_mutation_requested = true;
    input.raw_provider_material_requested = true;
    input.raw_callback_material_requested = true;

    let record = codex_interruption_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerInterruptionExecutionPolicyStatus::Blocked
    );
    assert_eq!(
        record.blockers,
        vec![
            CodexAppServerInterruptionExecutionPolicyBlocker::AutomaticInterruptionRequested,
            CodexAppServerInterruptionExecutionPolicyBlocker::TaskCompletionRequested,
            CodexAppServerInterruptionExecutionPolicyBlocker::ReviewAcceptanceRequested,
            CodexAppServerInterruptionExecutionPolicyBlocker::ResumeRequested,
            CodexAppServerInterruptionExecutionPolicyBlocker::CallbackAnswerRequested,
            CodexAppServerInterruptionExecutionPolicyBlocker::ScmMutationRequested,
            CodexAppServerInterruptionExecutionPolicyBlocker::RawProviderMaterialRequested,
            CodexAppServerInterruptionExecutionPolicyBlocker::RawCallbackMaterialRequested,
        ]
    );
    assert!(!record.provider_write_executed);
    assert!(!record.automatic_interruption_permitted);
    assert!(!record.task_completion_permitted);
    assert!(!record.review_acceptance_permitted);
    assert!(!record.raw_provider_material_retained);
}

fn interruption_request(suffix: &str) -> CodexAppServerInterruptionRequest {
    codex_interruption_request(
        &crate::codex_supervision::test_support::runtime(),
        CodexAppServerInterruptionRequestRef(format!("interrupt:{suffix}")),
        AgentSessionId(format!("session:{suffix}")),
        CodexAppServerInterruptionTarget::ActiveTurn {
            provider_turn_id: format!("turn:provider:{suffix}"),
            provider_request_id: Some(format!("request:provider:{suffix}")),
        },
        TaskId(format!("task:{suffix}")),
        EngineTaskWorkItemId(format!("work:{suffix}")),
        CodexAppServerInterruptionReasonRef {
            reason_ref: format!("interruption-reason:{suffix}"),
            summary: "operator stopped the active turn".to_owned(),
            retention: CodexAppServerInterruptionReasonRetentionPolicy::SummaryAndRefOnly,
        },
        CodexAppServerPayloadRetentionPolicy::MetadataOnly,
    )
    .expect("interruption request")
}
