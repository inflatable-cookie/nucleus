use super::*;
use crate::codex_supervision::{
    admit_codex_task_work_live_executor, codex_live_executor_outcome_record,
    codex_task_backed_live_execution_policy, CodexAppServerLiveExecutorCleanupStatus,
    CodexAppServerLiveExecutorMethod, CodexAppServerLiveExecutorOutcomeInput,
    CodexAppServerTaskBackedLiveExecutionPathwayEvidence,
    CodexAppServerTaskBackedLiveExecutionPolicyInput,
    CodexAppServerTaskBackedLiveExecutionToolPolicy,
    CodexAppServerTaskBackedLiveExecutionToolProjectionMode,
    CodexAppServerTaskWorkLiveExecutorAdmissionInput,
};
use crate::host_authority::EngineHostId;
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptId, ProviderTransportWriteIdempotencyKey,
};

use nucleus_engine::{
    EngineTaskWorkItemAssignment, EngineTaskWorkItemRecord, EngineTaskWorkItemReviewState,
    EngineTaskWorkItemRuntimeProjectionEntryKind, EngineTaskWorkItemRuntimeState,
};
use nucleus_tasks::TaskActionType;

#[test]
fn receipt_linkage_preserves_completed_outcome_without_task_completion() {
    let link = codex_task_work_live_executor_receipt_link(
        &accepted_admission(),
        &outcome(CodexAppServerLiveExecutorOutcomeStatus::Completed),
        receipt_id(),
    );

    assert_eq!(
        link.status,
        CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus::Linked
    );
    assert_eq!(
        link.runtime_progress,
        CodexAppServerTaskWorkLiveExecutorRuntimeProgress::Completed
    );
    assert!(link.provider_completion_recorded);
    assert!(!link.task_completion_permitted);
    assert!(!link.review_acceptance_permitted);
    assert!(!link.raw_provider_material_retained);
    assert_eq!(link.refs.receipt_ids, vec![receipt_id()]);
    assert_eq!(
        link.refs.artifact_refs,
        vec!["codex-live-executor-outcome:codex-live-executor-outcome:write:1:completed"]
    );

    let projection = work_item_from_link(&link).runtime_projection();
    assert!(projection.entries.iter().any(|entry| {
        entry.kind == EngineTaskWorkItemRuntimeProjectionEntryKind::Receipt
            && entry.source_ref == "receipt:codex-live-executor:write:1"
    }));
    assert!(projection.entries.iter().any(|entry| {
        entry.kind == EngineTaskWorkItemRuntimeProjectionEntryKind::Artifact
            && entry.source_ref
                == "codex-live-executor-outcome:codex-live-executor-outcome:write:1:completed"
    }));
    assert!(projection
        .entries
        .iter()
        .all(|entry| !entry.source_ref.contains("raw_provider")));
}

#[test]
fn receipt_linkage_keeps_failed_outcome_inspectable() {
    let link = codex_task_work_live_executor_receipt_link(
        &accepted_admission(),
        &outcome(CodexAppServerLiveExecutorOutcomeStatus::Failed(
            "provider error".to_owned(),
        )),
        receipt_id(),
    );

    assert_eq!(
        link.runtime_progress,
        CodexAppServerTaskWorkLiveExecutorRuntimeProgress::Failed("provider error".to_owned())
    );
    assert_eq!(
        link.status,
        CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus::Linked
    );
    assert!(!link.provider_completion_recorded);
    assert!(!link.task_completion_permitted);
}

#[test]
fn receipt_linkage_keeps_timed_out_outcome_inspectable() {
    let link = codex_task_work_live_executor_receipt_link(
        &accepted_admission(),
        &outcome(CodexAppServerLiveExecutorOutcomeStatus::TimedOut),
        receipt_id(),
    );

    assert_eq!(
        link.runtime_progress,
        CodexAppServerTaskWorkLiveExecutorRuntimeProgress::TimedOut
    );
    assert_eq!(
        link.status,
        CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus::Linked
    );
    assert!(!link.task_completion_permitted);
    assert!(!link.review_acceptance_permitted);
}

#[test]
fn receipt_linkage_keeps_cleanup_required_outcome_inspectable() {
    let link = codex_task_work_live_executor_receipt_link(
        &accepted_admission(),
        &outcome(CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(
            "process still running".to_owned(),
        )),
        receipt_id(),
    );

    assert_eq!(
        link.runtime_progress,
        CodexAppServerTaskWorkLiveExecutorRuntimeProgress::CleanupRequired(
            "process still running".to_owned()
        )
    );
    assert_eq!(
        link.status,
        CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus::Linked
    );
    assert!(link
        .evidence_refs
        .contains(&"live-executor-evidence:1".to_owned()));
}

#[test]
fn receipt_linkage_blocks_mismatched_or_unsafe_records() {
    let mut admission = accepted_admission();
    admission.provider_instance_id = "codex:other".to_owned();
    let mut unsafe_outcome = outcome(CodexAppServerLiveExecutorOutcomeStatus::Completed);
    unsafe_outcome.raw_payload_retained = true;
    unsafe_outcome.task_mutation_permitted = true;

    let link = codex_task_work_live_executor_receipt_link(
        &admission,
        &unsafe_outcome,
        EngineRuntimeReceiptRecordId(String::new()),
    );

    assert_eq!(
        link.status,
        CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus::Blocked(vec![
            CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::MissingRuntimeReceiptId,
            CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::ProviderInstanceMismatch,
            CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::OutcomeRetainedRawPayload,
            CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::OutcomePermitsTaskMutation,
        ])
    );
    assert!(!link.task_completion_permitted);
    assert!(!link.review_acceptance_permitted);
}

fn accepted_admission() -> CodexAppServerTaskWorkLiveExecutorAdmissionRecord {
    admit_codex_task_work_live_executor(CodexAppServerTaskWorkLiveExecutorAdmissionInput {
        policy: codex_task_backed_live_execution_policy(policy_input()),
        work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        project_id: ProjectId("project:1".to_owned()),
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: "runtime-session:1".to_owned(),
        live_executor_write_attempt_id: ProviderTransportWriteAttemptId("write:1".to_owned()),
        idempotency_key: ProviderTransportWriteIdempotencyKey(
            "codex-live-executor:work:1".to_owned(),
        ),
        evidence_refs: vec!["admission-evidence:1".to_owned()],
        invoke_executor_requested: false,
        raw_provider_material_requested: false,
        task_mutation_requested: false,
    })
}

fn policy_input() -> CodexAppServerTaskBackedLiveExecutionPolicyInput {
    CodexAppServerTaskBackedLiveExecutionPolicyInput {
        work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        project_id: ProjectId("project:1".to_owned()),
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: Some("runtime-session:1".to_owned()),
        adapter_id: "codex-app-server".to_owned(),
        execution_host_id: EngineHostId("host:local".to_owned()),
        operator_evidence_ref: Some("operator-evidence:1".to_owned()),
        pathway_evidence: CodexAppServerTaskBackedLiveExecutionPathwayEvidence::RoadmapReadyCard {
            roadmap_ref: "roadmap:069".to_owned(),
            card_ref: "card:311".to_owned(),
            evidence_ref: "pathway-evidence:311".to_owned(),
        },
        tool_policy: CodexAppServerTaskBackedLiveExecutionToolPolicy {
            projection_mode: CodexAppServerTaskBackedLiveExecutionToolProjectionMode::PortalTool,
            adapter_capability_evidence_ref: Some(
                "adapter-capability-evidence:codex:tools".to_owned(),
            ),
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

fn outcome(
    status: CodexAppServerLiveExecutorOutcomeStatus,
) -> CodexAppServerLiveExecutorOutcomeRecord {
    codex_live_executor_outcome_record(CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: "codex:local-default".to_owned(),
        write_attempt_id: "write:1".to_owned(),
        receipt_refs: vec!["provider-receipt:1".to_owned()],
        thread_id: Some("thread:1".to_owned()),
        turn_id: Some("turn:1".to_owned()),
        final_turn_status: Some("completed".to_owned()),
        status,
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
        evidence_refs: vec!["live-executor-evidence:1".to_owned()],
        provider_write_executed: true,
    })
}

fn receipt_id() -> EngineRuntimeReceiptRecordId {
    EngineRuntimeReceiptRecordId("receipt:codex-live-executor:write:1".to_owned())
}

fn work_item_from_link(
    link: &CodexAppServerTaskWorkLiveExecutorReceiptLink,
) -> EngineTaskWorkItemRecord {
    EngineTaskWorkItemRecord {
        work_item_id: link.work_item_id.clone(),
        task_id: link.task_id.clone(),
        project_id: link.project_id.clone(),
        title: "Task-backed live executor proof".to_owned(),
        intent: TaskActionType::Execute,
        assignment: EngineTaskWorkItemAssignment::AdapterInstance {
            adapter_id: "codex-app-server".to_owned(),
            provider_instance_id: link.provider_instance_id.clone(),
        },
        runtime: EngineTaskWorkItemRuntimeState::Running,
        review: EngineTaskWorkItemReviewState::NotReady,
        refs: link.refs.clone(),
        summary: Some("sanitized runtime linkage only".to_owned()),
    }
}
