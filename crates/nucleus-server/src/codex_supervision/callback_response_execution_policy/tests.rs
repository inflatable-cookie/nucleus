use super::*;
use crate::codex_supervision::{
    admit_codex_callback_response, codex_callback_request, codex_callback_response_envelope,
    CodexAppServerCallbackPromptRef, CodexAppServerCallbackPromptRetentionPolicy,
    CodexAppServerCallbackResponseAdmissionInput, CodexAppServerPayloadRetentionPolicy,
    CodexAppServerProviderCallbackId,
};
use nucleus_agent_protocol::{AgentSessionId, ApprovalScope, UserInputPromptKind};
use nucleus_engine::EngineTaskWorkItemId;
use nucleus_tasks::TaskId;

fn ready_input(
    request_kind: CodexAppServerCallbackRequestKind,
    response: CodexAppServerCallbackResponse,
) -> CodexAppServerCallbackResponseExecutionPolicyInput {
    let request = callback_request("1", request_kind);
    let admission = admit_codex_callback_response(CodexAppServerCallbackResponseAdmissionInput {
        request: request.clone(),
        response,
        response_authority_confirmed: true,
        runtime_ready_evidence_refs: vec!["runtime-ready-evidence:1".to_owned()],
        raw_payload_policy_confirmed: true,
    });
    let envelope =
        codex_callback_response_envelope(&request, &admission).expect("accepted envelope");

    CodexAppServerCallbackResponseExecutionPolicyInput {
        request,
        admission,
        envelope,
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: Some("runtime-session:1".to_owned()),
        adapter_id: "codex-app-server".to_owned(),
        execution_host_id: EngineHostId("host:local".to_owned()),
        operator_evidence_ref: Some("operator-evidence:callback-response:1".to_owned()),
        callback_kind_evidence_ref: Some("callback-kind-evidence:permission".to_owned()),
        response_shape_evidence_ref: Some("response-shape-evidence:allow".to_owned()),
        tool_policy: CodexAppServerCallbackResponseExecutionToolPolicy {
            projection_mode: CodexAppServerCallbackResponseExecutionToolProjectionMode::PortalTool,
            adapter_capability_evidence_ref: Some(
                "adapter-capability-evidence:codex-callback-tools".to_owned(),
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
    }
}

#[test]
fn callback_response_execution_policy_accepts_permission_response_without_execution() {
    let record = codex_callback_response_execution_policy(ready_input(
        CodexAppServerCallbackRequestKind::Permission {
            scope: ApprovalScope::Command,
            options: vec!["allow".to_owned(), "deny".to_owned()],
        },
        CodexAppServerCallbackResponse::Permission {
            selected_option: "allow".to_owned(),
        },
    ));

    assert_eq!(
        record.status,
        CodexAppServerCallbackResponseExecutionPolicyStatus::AcceptedForExecutionAdmission
    );
    assert!(record.blockers.is_empty());
    assert_eq!(record.provider_callback_id, "provider-callback:1");
    assert_eq!(record.task_id, "task:1");
    assert_eq!(record.work_item_id, "work:1");
    assert!(record.evidence_refs.contains(&"tool:Effigy".to_owned()));
    assert!(!record.provider_write_executed);
    assert!(!record.automatic_callback_answer_permitted);
    assert!(!record.task_completion_permitted);
    assert!(!record.review_acceptance_permitted);
    assert!(!record.cancellation_permitted);
    assert!(!record.resume_permitted);
    assert!(!record.scm_mutation_permitted);
    assert!(!record.raw_callback_material_retained);
}

#[test]
fn callback_response_execution_policy_accepts_user_input_response_without_execution() {
    let record = codex_callback_response_execution_policy(ready_input(
        CodexAppServerCallbackRequestKind::UserInput {
            kind: UserInputPromptKind::SelectOne,
            options: vec!["first".to_owned(), "second".to_owned()],
        },
        CodexAppServerCallbackResponse::UserInput {
            values: vec!["first".to_owned()],
        },
    ));

    assert_eq!(
        record.status,
        CodexAppServerCallbackResponseExecutionPolicyStatus::AcceptedForExecutionAdmission
    );
    assert!(matches!(
        record.callback_kind,
        CodexAppServerCallbackRequestKind::UserInput { .. }
    ));
    assert!(matches!(
        record.response,
        CodexAppServerCallbackResponse::UserInput { .. }
    ));
    assert!(!record.raw_callback_material_retained);
}

#[test]
fn callback_response_execution_policy_blocks_missing_required_evidence() {
    let mut input = ready_permission_input();
    input.provider_instance_id.clear();
    input.runtime_session_ref = None;
    input.adapter_id.clear();
    input.execution_host_id = EngineHostId(String::new());
    input.operator_evidence_ref = None;
    input.callback_kind_evidence_ref = None;
    input.response_shape_evidence_ref = None;

    let record = codex_callback_response_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerCallbackResponseExecutionPolicyStatus::Blocked
    );
    assert!(record.blockers.contains(
        &CodexAppServerCallbackResponseExecutionPolicyBlocker::MissingProviderInstanceId
    ));
    assert!(record
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutionPolicyBlocker::MissingRuntimeSessionRef));
    assert!(record
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutionPolicyBlocker::MissingAdapterId));
    assert!(record
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutionPolicyBlocker::MissingExecutionHostId));
    assert!(record
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutionPolicyBlocker::MissingOperatorEvidence));
    assert!(record.blockers.contains(
        &CodexAppServerCallbackResponseExecutionPolicyBlocker::MissingCallbackKindEvidence
    ));
    assert!(record.blockers.contains(
        &CodexAppServerCallbackResponseExecutionPolicyBlocker::MissingResponseShapeEvidence
    ));
}

#[test]
fn callback_response_execution_policy_blocks_non_accepted_admission() {
    let request = callback_request(
        "1",
        CodexAppServerCallbackRequestKind::Permission {
            scope: ApprovalScope::Command,
            options: vec!["allow".to_owned(), "deny".to_owned()],
        },
    );
    let blocked_admission =
        admit_codex_callback_response(CodexAppServerCallbackResponseAdmissionInput {
            request: request.clone(),
            response: CodexAppServerCallbackResponse::Permission {
                selected_option: "allow".to_owned(),
            },
            response_authority_confirmed: false,
            runtime_ready_evidence_refs: vec!["runtime-ready-evidence:1".to_owned()],
            raw_payload_policy_confirmed: true,
        });
    let accepted_admission =
        admit_codex_callback_response(CodexAppServerCallbackResponseAdmissionInput {
            request: request.clone(),
            response: CodexAppServerCallbackResponse::Permission {
                selected_option: "allow".to_owned(),
            },
            response_authority_confirmed: true,
            runtime_ready_evidence_refs: vec!["runtime-ready-evidence:1".to_owned()],
            raw_payload_policy_confirmed: true,
        });
    let envelope =
        codex_callback_response_envelope(&request, &accepted_admission).expect("envelope");
    let mut input = ready_permission_input();
    input.request = request;
    input.admission = blocked_admission;
    input.envelope = envelope;

    let record = codex_callback_response_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerCallbackResponseExecutionPolicyStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutionPolicyBlocker::AdmissionNotAccepted));
}

#[test]
fn callback_response_execution_policy_blocks_identity_mismatch() {
    let mut input = ready_permission_input();
    let other_request = callback_request(
        "other",
        CodexAppServerCallbackRequestKind::Permission {
            scope: ApprovalScope::Command,
            options: vec!["allow".to_owned(), "deny".to_owned()],
        },
    );
    input.request = other_request;

    let record = codex_callback_response_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerCallbackResponseExecutionPolicyStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutionPolicyBlocker::RequestAdmissionMismatch));
    assert!(record
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutionPolicyBlocker::RequestEnvelopeMismatch));
    assert!(record
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutionPolicyBlocker::ProviderCallbackMismatch));
    assert!(record
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutionPolicyBlocker::TaskMismatch));
    assert!(record
        .blockers
        .contains(&CodexAppServerCallbackResponseExecutionPolicyBlocker::WorkItemMismatch));
}

#[test]
fn callback_response_execution_policy_blocks_flat_tool_overload() {
    let mut input = ready_permission_input();
    input.tool_policy = CodexAppServerCallbackResponseExecutionToolPolicy {
        projection_mode:
            CodexAppServerCallbackResponseExecutionToolProjectionMode::NativeToolRegistration,
        adapter_capability_evidence_ref: Some("adapter-capability-evidence:tools".to_owned()),
        portal_tool_family: None,
        published_actions: vec![
            "callback_allow".to_owned(),
            "callback_deny".to_owned(),
            "callback_input".to_owned(),
            "callback_repair".to_owned(),
        ],
        flat_tool_count: 4,
    };

    let record = codex_callback_response_execution_policy(input);

    assert_eq!(
        record.blockers,
        vec![
            CodexAppServerCallbackResponseExecutionPolicyBlocker::FlatToolMenuRequested {
                flat_tool_count: 4
            }
        ]
    );
}

#[test]
fn callback_response_execution_policy_blocks_forbidden_authority_requests() {
    let mut input = ready_permission_input();
    input.automatic_callback_answer_requested = true;
    input.task_completion_requested = true;
    input.review_acceptance_requested = true;
    input.cancellation_requested = true;
    input.resume_requested = true;
    input.scm_mutation_requested = true;
    input.raw_callback_material_requested = true;

    let record = codex_callback_response_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerCallbackResponseExecutionPolicyStatus::Blocked
    );
    assert_eq!(
        record.blockers,
        vec![
            CodexAppServerCallbackResponseExecutionPolicyBlocker::AutomaticCallbackAnswerRequested,
            CodexAppServerCallbackResponseExecutionPolicyBlocker::TaskCompletionRequested,
            CodexAppServerCallbackResponseExecutionPolicyBlocker::ReviewAcceptanceRequested,
            CodexAppServerCallbackResponseExecutionPolicyBlocker::CancellationRequested,
            CodexAppServerCallbackResponseExecutionPolicyBlocker::ResumeRequested,
            CodexAppServerCallbackResponseExecutionPolicyBlocker::ScmMutationRequested,
            CodexAppServerCallbackResponseExecutionPolicyBlocker::RawCallbackMaterialRequested,
        ]
    );
    assert!(!record.provider_write_executed);
    assert!(!record.automatic_callback_answer_permitted);
    assert!(!record.task_completion_permitted);
    assert!(!record.review_acceptance_permitted);
    assert!(!record.raw_callback_material_retained);
}

fn ready_permission_input() -> CodexAppServerCallbackResponseExecutionPolicyInput {
    ready_input(
        CodexAppServerCallbackRequestKind::Permission {
            scope: ApprovalScope::Command,
            options: vec!["allow".to_owned(), "deny".to_owned()],
        },
        CodexAppServerCallbackResponse::Permission {
            selected_option: "allow".to_owned(),
        },
    )
}

fn callback_request(
    suffix: &str,
    kind: CodexAppServerCallbackRequestKind,
) -> CodexAppServerCallbackRequest {
    codex_callback_request(
        &crate::codex_supervision::test_support::runtime(),
        CodexAppServerProviderCallbackId(format!("provider-callback:{suffix}")),
        AgentSessionId(format!("session:{suffix}")),
        Some(format!("turn:provider:{suffix}")),
        Some(format!("item:provider:{suffix}")),
        TaskId(format!("task:{suffix}")),
        EngineTaskWorkItemId(format!("work:{suffix}")),
        kind,
        CodexAppServerCallbackPromptRef {
            prompt_ref: format!("callback-prompt:{suffix}"),
            summary: "callback summary".to_owned(),
            retention: CodexAppServerCallbackPromptRetentionPolicy::SummaryAndRefOnly,
        },
        CodexAppServerPayloadRetentionPolicy::MetadataOnly,
    )
    .expect("callback request")
}
