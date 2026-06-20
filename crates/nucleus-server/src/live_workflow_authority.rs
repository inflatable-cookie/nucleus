use nucleus_engine::{EngineRuntimeReceiptRecordId, EngineTaskWorkItemId};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::codex_supervision::{
    admit_codex_task_work_live_executor, codex_live_executor_outcome_record,
    codex_task_backed_live_execution_policy, codex_task_work_live_executor_receipt_link,
    CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorMethod,
    CodexAppServerLiveExecutorOutcomeInput, CodexAppServerLiveExecutorOutcomeRecord,
    CodexAppServerLiveExecutorOutcomeStatus, CodexAppServerTaskBackedLiveExecutionPathwayEvidence,
    CodexAppServerTaskBackedLiveExecutionPolicyBlocker,
    CodexAppServerTaskBackedLiveExecutionPolicyInput,
    CodexAppServerTaskBackedLiveExecutionPolicyRecord,
    CodexAppServerTaskBackedLiveExecutionPolicyStatus,
    CodexAppServerTaskBackedLiveExecutionToolPolicy,
    CodexAppServerTaskBackedLiveExecutionToolProjectionMode,
    CodexAppServerTaskWorkLiveExecutorAdmissionBlocker,
    CodexAppServerTaskWorkLiveExecutorAdmissionInput,
    CodexAppServerTaskWorkLiveExecutorAdmissionRecord,
    CodexAppServerTaskWorkLiveExecutorAdmissionStatus,
    CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker,
    CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus,
};
use crate::host_authority::EngineHostId;
use crate::provider_retention_policy::{
    provider_retention_policy, ProviderRetentionPolicyBlocker, ProviderRetentionPolicyInput,
    ProviderRetentionPolicyStatus,
};
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptId, ProviderTransportWriteIdempotencyKey,
};

#[test]
fn live_workflow_authority_policy_blocks_provider_callback_control_and_mutation_widening() {
    let mut input = policy_input();
    input.callback_response_requested = true;
    input.cancellation_requested = true;
    input.resume_requested = true;
    input.task_completion_requested = true;
    input.review_acceptance_requested = true;
    input.scm_mutation_requested = true;
    input.raw_provider_material_requested = true;

    let record = codex_task_backed_live_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerTaskBackedLiveExecutionPolicyStatus::Blocked
    );
    assert_eq!(
        record.blockers,
        vec![
            CodexAppServerTaskBackedLiveExecutionPolicyBlocker::CallbackResponseRequested,
            CodexAppServerTaskBackedLiveExecutionPolicyBlocker::CancellationRequested,
            CodexAppServerTaskBackedLiveExecutionPolicyBlocker::ResumeRequested,
            CodexAppServerTaskBackedLiveExecutionPolicyBlocker::TaskCompletionRequested,
            CodexAppServerTaskBackedLiveExecutionPolicyBlocker::ReviewAcceptanceRequested,
            CodexAppServerTaskBackedLiveExecutionPolicyBlocker::ScmMutationRequested,
            CodexAppServerTaskBackedLiveExecutionPolicyBlocker::RawProviderMaterialRequested,
        ]
    );
    assert!(!record.provider_write_executed);
    assert!(!record.callback_response_permitted);
    assert!(!record.cancellation_permitted);
    assert!(!record.resume_permitted);
    assert!(!record.task_completion_permitted);
    assert!(!record.review_acceptance_permitted);
    assert!(!record.scm_mutation_permitted);
    assert!(!record.raw_provider_material_retained);
}

#[test]
fn live_workflow_authority_admission_blocks_executor_invocation_raw_material_and_task_mutation() {
    let mut input = admission_input(accepted_policy());
    input.invoke_executor_requested = true;
    input.raw_provider_material_requested = true;
    input.task_mutation_requested = true;

    let admission = admit_codex_task_work_live_executor(input);

    assert_eq!(
        admission.status,
        CodexAppServerTaskWorkLiveExecutorAdmissionStatus::Blocked
    );
    assert_eq!(
        admission.blockers,
        vec![
            CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::ExecutorInvocationRequested,
            CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::RawProviderMaterialRequested,
            CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::TaskMutationRequested,
        ]
    );
    assert!(!admission.executor_invoked);
    assert!(!admission.provider_write_executed);
    assert!(!admission.raw_provider_material_retained);
    assert!(!admission.task_mutation_permitted);
    assert!(!admission.review_acceptance_permitted);
}

#[test]
fn live_workflow_authority_admission_blocks_policy_that_was_already_widened() {
    let mut policy = accepted_policy();
    policy.callback_response_permitted = true;
    policy.cancellation_permitted = true;
    policy.resume_permitted = true;
    policy.task_completion_permitted = true;
    policy.review_acceptance_permitted = true;
    policy.scm_mutation_permitted = true;
    policy.raw_provider_material_retained = true;
    policy.provider_write_executed = true;

    let admission = admit_codex_task_work_live_executor(admission_input(policy));

    assert_eq!(
        admission.status,
        CodexAppServerTaskWorkLiveExecutorAdmissionStatus::Blocked
    );
    assert!(admission.blockers.contains(
        &CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::PolicyAlreadyExecutedProviderWrite
    ));
    assert!(admission.blockers.contains(
        &CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::PolicyPermitsForbiddenAuthority
    ));
    assert!(!admission.provider_write_executed);
    assert!(!admission.task_mutation_permitted);
    assert!(!admission.review_acceptance_permitted);
}

#[test]
fn live_workflow_authority_receipt_link_blocks_unsafe_outcome_and_admission_widening() {
    let mut admission = accepted_admission();
    admission.task_mutation_permitted = true;
    admission.review_acceptance_permitted = true;
    let mut outcome = completed_outcome();
    outcome.raw_payload_retained = true;
    outcome.raw_stream_retained = true;
    outcome.task_mutation_permitted = true;

    let link = codex_task_work_live_executor_receipt_link(
        &admission,
        &outcome,
        EngineRuntimeReceiptRecordId(String::new()),
    );

    assert_eq!(
        link.status,
        CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus::Blocked(vec![
            CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::MissingRuntimeReceiptId,
            CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::OutcomeRetainedRawPayload,
            CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::OutcomeRetainedRawStream,
            CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::OutcomePermitsTaskMutation,
            CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::AdmissionPermitsTaskMutation,
            CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::AdmissionPermitsReviewAcceptance,
        ])
    );
    assert!(!link.task_completion_permitted);
    assert!(!link.review_acceptance_permitted);
    assert!(!link.raw_provider_material_retained);
}

#[test]
fn live_workflow_authority_retention_rejects_raw_payload_stream_and_unbounded_refs() {
    let record = provider_retention_policy(ProviderRetentionPolicyInput {
        record_ref: "provider-record:authority".to_owned(),
        evidence_refs: vec!["evidence:authority".to_owned()],
        artifact_refs: vec!["artifact:authority".to_owned()],
        raw_payload_present: true,
        raw_stream_present: true,
        secret_material_present: true,
        credential_material_present: true,
        unbounded_local_path_present: true,
        artifact_policy_approved: false,
        diagnostics_requested: true,
    });

    assert_eq!(record.status, ProviderRetentionPolicyStatus::Blocked);
    assert!(record
        .blockers
        .contains(&ProviderRetentionPolicyBlocker::RawPayloadPresent));
    assert!(record
        .blockers
        .contains(&ProviderRetentionPolicyBlocker::RawStreamPresent));
    assert!(record
        .blockers
        .contains(&ProviderRetentionPolicyBlocker::SecretMaterialPresent));
    assert!(record
        .blockers
        .contains(&ProviderRetentionPolicyBlocker::CredentialMaterialPresent));
    assert!(record
        .blockers
        .contains(&ProviderRetentionPolicyBlocker::UnboundedLocalPathPresent));
    assert!(record
        .blockers
        .contains(&ProviderRetentionPolicyBlocker::ArtifactPolicyMissing));
    assert!(!record.raw_payload_retained);
    assert!(!record.raw_stream_retained);
    assert!(!record.approved_artifacts_reference_only);
}

fn accepted_admission() -> CodexAppServerTaskWorkLiveExecutorAdmissionRecord {
    admit_codex_task_work_live_executor(admission_input(accepted_policy()))
}

fn accepted_policy() -> CodexAppServerTaskBackedLiveExecutionPolicyRecord {
    codex_task_backed_live_execution_policy(policy_input())
}

fn admission_input(
    policy: CodexAppServerTaskBackedLiveExecutionPolicyRecord,
) -> CodexAppServerTaskWorkLiveExecutorAdmissionInput {
    CodexAppServerTaskWorkLiveExecutorAdmissionInput {
        policy,
        work_item_id: EngineTaskWorkItemId("work:authority".to_owned()),
        task_id: TaskId("task:authority".to_owned()),
        project_id: ProjectId("project:authority".to_owned()),
        provider_instance_id: "codex:authority".to_owned(),
        runtime_session_ref: "runtime-session:authority".to_owned(),
        live_executor_write_attempt_id: ProviderTransportWriteAttemptId(
            "write:authority".to_owned(),
        ),
        idempotency_key: ProviderTransportWriteIdempotencyKey("idempotency:authority".to_owned()),
        evidence_refs: vec!["evidence:admission:authority".to_owned()],
        invoke_executor_requested: false,
        raw_provider_material_requested: false,
        task_mutation_requested: false,
    }
}

fn policy_input() -> CodexAppServerTaskBackedLiveExecutionPolicyInput {
    CodexAppServerTaskBackedLiveExecutionPolicyInput {
        work_item_id: EngineTaskWorkItemId("work:authority".to_owned()),
        task_id: TaskId("task:authority".to_owned()),
        project_id: ProjectId("project:authority".to_owned()),
        provider_instance_id: "codex:authority".to_owned(),
        runtime_session_ref: Some("runtime-session:authority".to_owned()),
        adapter_id: "adapter:codex".to_owned(),
        execution_host_id: EngineHostId("host:authority".to_owned()),
        operator_evidence_ref: Some("evidence:operator:authority".to_owned()),
        pathway_evidence: CodexAppServerTaskBackedLiveExecutionPathwayEvidence::RoadmapReadyCard {
            roadmap_ref: "docs/roadmaps/g02/082-task-backed-live-workflow-closeout.md".to_owned(),
            card_ref:
                "docs/roadmaps/g02/batch-cards/376-live-workflow-authority-regression-suite.md"
                    .to_owned(),
            evidence_ref: "evidence:pathway:authority".to_owned(),
        },
        tool_policy: CodexAppServerTaskBackedLiveExecutionToolPolicy {
            projection_mode: CodexAppServerTaskBackedLiveExecutionToolProjectionMode::PortalTool,
            adapter_capability_evidence_ref: Some("evidence:tool-capability:authority".to_owned()),
            portal_tool_family: Some("Effigy".to_owned()),
            published_actions: vec!["run_selector_request".to_owned()],
            flat_tool_count: 1,
        },
        callback_response_requested: false,
        cancellation_requested: false,
        resume_requested: false,
        task_completion_requested: false,
        review_acceptance_requested: false,
        scm_mutation_requested: false,
        raw_provider_material_requested: false,
    }
}

fn completed_outcome() -> CodexAppServerLiveExecutorOutcomeRecord {
    codex_live_executor_outcome_record(CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: "codex:authority".to_owned(),
        write_attempt_id: "write:authority".to_owned(),
        receipt_refs: vec!["receipt:authority".to_owned()],
        thread_id: Some("thread:authority".to_owned()),
        turn_id: Some("turn:authority".to_owned()),
        final_turn_status: Some("completed".to_owned()),
        status: CodexAppServerLiveExecutorOutcomeStatus::Completed,
        method_sequence: vec![
            CodexAppServerLiveExecutorMethod::Initialize,
            CodexAppServerLiveExecutorMethod::InitializedNotification,
            CodexAppServerLiveExecutorMethod::ThreadStart,
            CodexAppServerLiveExecutorMethod::TurnStart,
            CodexAppServerLiveExecutorMethod::TurnCompleted,
            CodexAppServerLiveExecutorMethod::Cleanup,
        ],
        notification_count: 1,
        server_request_count: 0,
        cleanup_status: CodexAppServerLiveExecutorCleanupStatus::Completed,
        evidence_refs: vec!["evidence:outcome:authority".to_owned()],
        provider_write_executed: true,
    })
}
