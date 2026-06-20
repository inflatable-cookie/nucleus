//! Deterministic task-backed Codex live workflow fixture.
//!
//! The fixture stitches existing runtime admission, live executor linkage,
//! timeline, review, and diagnostics projections into one replayable proof. It
//! uses sanitized ids and refs only.

use nucleus_agent_protocol::{
    AdapterIdentity, AgentSessionId, AuthenticationPreflight, ProviderDriverKind, TransportFamily,
    VersionDiscovery,
};
use nucleus_command_policy::CommandRequestId;
use nucleus_engine::{
    admit_task_agent_work_unit, EngineCheckpointRecordId, EngineDiffSummaryRecordId,
    EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId, EngineRuntimeReceiptStatus,
    EngineTaskAgentWorkUnitRuntimeStatus, EngineTaskAgentWorkUnitSourceCursor,
    EngineTaskAgentWorkUnitSourceId, EngineTaskWorkItemAssignment, EngineTaskWorkItemId,
    EngineTaskWorkItemRecord, EngineTaskWorkItemRefs, EngineTaskWorkItemReviewCommand,
    EngineTaskWorkItemReviewDecision, EngineTaskWorkItemReviewOutcome,
    EngineTaskWorkItemReviewState, EngineTaskWorkItemRuntimeState,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::{TaskActionType, TaskId};

use crate::codex_supervision::{
    admit_codex_task_work_live_executor, codex_live_executor_outcome_record,
    codex_task_backed_live_execution_policy, codex_task_work_live_executor_receipt_link,
    CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorMethod,
    CodexAppServerLiveExecutorOutcomeInput, CodexAppServerLiveExecutorOutcomeStatus,
    CodexAppServerTaskBackedLiveExecutionPathwayEvidence,
    CodexAppServerTaskBackedLiveExecutionPolicyInput,
    CodexAppServerTaskBackedLiveExecutionPolicyStatus,
    CodexAppServerTaskBackedLiveExecutionToolPolicy,
    CodexAppServerTaskBackedLiveExecutionToolProjectionMode,
    CodexAppServerTaskWorkLiveExecutorAdmissionInput,
    CodexAppServerTaskWorkLiveExecutorAdmissionStatus,
};
use crate::diagnostics_read_models::{
    codex_task_backed_live_execution_diagnostics, task_agent_diagnostics,
    CodexTaskBackedLiveExecutionDiagnosticsDto, TaskAgentDiagnosticsDto,
};
use crate::host_authority::EngineHostId;
use crate::ids::ServerEventId;
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptId, ProviderTransportWriteIdempotencyKey,
};
use crate::scheduler::{RuntimeSchedulerAdmissionDecision, RuntimeSchedulerQueue};
use crate::{
    admit_codex_task_runtime_request, link_codex_task_runtime_receipt,
    CodexTaskRuntimeProviderRefs, CodexTaskRuntimeReceiptLink, CodexTaskRuntimeRequestId,
    CodexTaskRuntimeRequestRecord, CodexWorkItemRuntimeTransitionAdmissionInput,
};

use super::{
    admit_codex_work_item_runtime_transition, rebuild_codex_live_observation_task_timeline,
    CodexLiveObservationTaskTimelineProjection, CodexLiveObservationWorkItemCandidate,
    CodexLiveObservationWorkItemCandidateState, CodexLiveObservationWorkItemCandidateStatus,
};

/// Static fixture ids used by the replay.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskBackedLiveWorkflowFixture {
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub source_id: EngineTaskAgentWorkUnitSourceId,
    pub runtime_session_ref: String,
    pub provider_instance_id: String,
    pub write_attempt_id: ProviderTransportWriteAttemptId,
    pub runtime_receipt_id: EngineRuntimeReceiptRecordId,
    pub evidence_refs: Vec<String>,
}

/// Replayed product proof for task-backed Codex live workflow closeout.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskBackedLiveWorkflowReplay {
    pub fixture: TaskBackedLiveWorkflowFixture,
    pub scheduler_admitted: bool,
    pub live_executor_admitted: bool,
    pub runtime_progress: String,
    pub receipt_link: CodexTaskRuntimeReceiptLink,
    pub timeline: CodexLiveObservationTaskTimelineProjection,
    pub task_diagnostics: TaskAgentDiagnosticsDto,
    pub live_execution_diagnostics: CodexTaskBackedLiveExecutionDiagnosticsDto,
    pub task_completion_permitted_by_runtime: bool,
    pub review_acceptance_permitted_by_runtime: bool,
    pub review_accepted_by_explicit_command: bool,
    pub provider_write_executed_before_explicit_smoke: bool,
    pub raw_provider_material_retained: bool,
}

/// Replay the task-backed live workflow fixture without provider I/O.
pub fn task_backed_live_workflow_fixture() -> TaskBackedLiveWorkflowReplay {
    let fixture = fixture();
    let work_item = work_item(&fixture);
    let admission = admit_task_agent_work_unit(
        "command:delegate:fixture",
        "actor:operator",
        "task-backed-live-fixture",
        None,
        &work_item,
    );
    let runtime_request = runtime_request(&fixture, admission.source_record.source_id.clone());

    let mut queue = RuntimeSchedulerQueue::new();
    let scheduler_admission = admit_codex_task_runtime_request(&mut queue, runtime_request.clone());

    let policy = codex_task_backed_live_execution_policy(policy_input(&fixture));
    let live_executor_admission =
        admit_codex_task_work_live_executor(live_executor_input(&fixture, policy));
    let outcome = codex_live_executor_outcome_record(live_executor_outcome_input(&fixture));
    let live_executor_receipt_link = codex_task_work_live_executor_receipt_link(
        &live_executor_admission,
        &outcome,
        fixture.runtime_receipt_id.clone(),
    );
    let receipt = runtime_receipt(&fixture);
    let receipt_link = link_codex_task_runtime_receipt(&runtime_request, &receipt);
    let transition =
        admit_codex_work_item_runtime_transition(CodexWorkItemRuntimeTransitionAdmissionInput {
            candidate: completed_candidate(&fixture),
            expected_current_runtime: EngineTaskAgentWorkUnitRuntimeStatus::Running,
            expected_revision_ref: Some("rev:fixture:runtime".to_owned()),
            task_completion_requested: false,
            review_acceptance_requested: false,
            scm_mutation_requested: false,
        });
    let timeline =
        rebuild_codex_live_observation_task_timeline(fixture.task_id.clone(), &[transition]);

    let completed_work_item = completed_work_item(&fixture, work_item);
    let review_transition = completed_work_item
        .apply_review_command(EngineTaskWorkItemReviewCommand {
            command_id: "command:review:fixture".to_owned(),
            work_item_id: fixture.work_item_id.clone(),
            expected_review: Some(EngineTaskWorkItemReviewState::AwaitingReview),
            decision: EngineTaskWorkItemReviewDecision {
                reviewer_ref: "operator:fixture".to_owned(),
                outcome: EngineTaskWorkItemReviewOutcome::Accept,
                validation_refs: vec!["validation:fixture".to_owned()],
                checkpoint_ids: vec![EngineCheckpointRecordId("checkpoint:fixture".to_owned())],
                diff_summary_ids: vec![EngineDiffSummaryRecordId("diff:fixture".to_owned())],
                note: Some("fixture accepted after explicit review command".to_owned()),
            },
        })
        .expect("fixture review transition");

    let mut review_source = admission.source_record.clone();
    review_source.source_id = EngineTaskAgentWorkUnitSourceId("source:fixture:review".to_owned());
    review_source.source_cursor =
        EngineTaskAgentWorkUnitSourceCursor("zz:fixture:review".to_owned());
    review_source.runtime = EngineTaskAgentWorkUnitRuntimeStatus::Completed;
    review_source.review = nucleus_engine::EngineTaskAgentWorkUnitReviewStatus::Accepted;
    review_source.refs = review_transition.work_item.refs.clone();
    review_source.previous_source_id = Some(admission.source_record.source_id);
    review_source.summary = "fixture accepted by explicit review command".to_owned();

    let task_diagnostics = task_agent_diagnostics(&[review_source]);
    let live_execution_diagnostics = codex_task_backed_live_execution_diagnostics(
        &[live_executor_admission.clone()],
        &[live_executor_receipt_link.clone()],
    );

    TaskBackedLiveWorkflowReplay {
        fixture,
        scheduler_admitted: matches!(
            scheduler_admission.decision,
            RuntimeSchedulerAdmissionDecision::Accepted(_)
        ) && queue.queued_items().len() == 1,
        live_executor_admitted: live_executor_admission.status
            == CodexAppServerTaskWorkLiveExecutorAdmissionStatus::AcceptedForExecutorHandoff,
        runtime_progress: format!("{:?}", live_executor_receipt_link.runtime_progress),
        receipt_link,
        timeline,
        task_diagnostics,
        live_execution_diagnostics,
        task_completion_permitted_by_runtime: live_executor_receipt_link.task_completion_permitted,
        review_acceptance_permitted_by_runtime: live_executor_receipt_link
            .review_acceptance_permitted,
        review_accepted_by_explicit_command: matches!(
            review_transition.work_item.review,
            EngineTaskWorkItemReviewState::Accepted { .. }
        ),
        provider_write_executed_before_explicit_smoke: live_executor_admission
            .provider_write_executed,
        raw_provider_material_retained: live_executor_admission.raw_provider_material_retained
            || live_executor_receipt_link.raw_provider_material_retained,
    }
}

fn fixture() -> TaskBackedLiveWorkflowFixture {
    TaskBackedLiveWorkflowFixture {
        project_id: ProjectId("project:fixture".to_owned()),
        task_id: TaskId("task:fixture".to_owned()),
        work_item_id: EngineTaskWorkItemId("work:fixture".to_owned()),
        source_id: EngineTaskAgentWorkUnitSourceId("source:fixture".to_owned()),
        runtime_session_ref: "runtime-session:fixture".to_owned(),
        provider_instance_id: "codex:fixture".to_owned(),
        write_attempt_id: ProviderTransportWriteAttemptId(
            "provider-transport-write:fixture".to_owned(),
        ),
        runtime_receipt_id: EngineRuntimeReceiptRecordId("receipt:fixture".to_owned()),
        evidence_refs: vec![
            "evidence:fixture:pathway".to_owned(),
            "evidence:fixture:operator".to_owned(),
            "evidence:fixture:runtime".to_owned(),
        ],
    }
}

fn work_item(fixture: &TaskBackedLiveWorkflowFixture) -> EngineTaskWorkItemRecord {
    EngineTaskWorkItemRecord {
        work_item_id: fixture.work_item_id.clone(),
        task_id: fixture.task_id.clone(),
        project_id: fixture.project_id.clone(),
        title: "Task-backed live workflow fixture".to_owned(),
        intent: TaskActionType::Execute,
        assignment: EngineTaskWorkItemAssignment::AdapterInstance {
            adapter_id: "adapter:codex".to_owned(),
            provider_instance_id: fixture.provider_instance_id.clone(),
        },
        runtime: EngineTaskWorkItemRuntimeState::Scheduled,
        review: EngineTaskWorkItemReviewState::NotReady,
        refs: EngineTaskWorkItemRefs {
            session_id: Some(AgentSessionId(fixture.runtime_session_ref.clone())),
            ..Default::default()
        },
        summary: Some("fixture work admitted".to_owned()),
    }
}

fn runtime_request(
    fixture: &TaskBackedLiveWorkflowFixture,
    source_id: EngineTaskAgentWorkUnitSourceId,
) -> CodexTaskRuntimeRequestRecord {
    CodexTaskRuntimeRequestRecord {
        request_id: CodexTaskRuntimeRequestId("codex-task-runtime:fixture".to_owned()),
        project_id: fixture.project_id.clone(),
        task_id: fixture.task_id.clone(),
        work_item_id: fixture.work_item_id.clone(),
        source_id,
        adapter: codex_adapter(&fixture.provider_instance_id),
        command_request_id: CommandRequestId("command:delegate:fixture".to_owned()),
        event_id: ServerEventId("event:fixture:runtime-request".to_owned()),
        nucleus_session_id: AgentSessionId(fixture.runtime_session_ref.clone()),
        codex_refs: CodexTaskRuntimeProviderRefs {
            provider_session_id: Some("provider-session:fixture".to_owned()),
            provider_thread_id: Some("thread:fixture".to_owned()),
            provider_turn_id: Some("turn:fixture".to_owned()),
            provider_item_id: None,
            provider_request_id: None,
        },
        summary: "fixture task work unit to Codex runtime".to_owned(),
    }
}

fn completed_candidate(
    fixture: &TaskBackedLiveWorkflowFixture,
) -> CodexLiveObservationWorkItemCandidate {
    CodexLiveObservationWorkItemCandidate {
        candidate_id: "candidate:fixture:completed".to_owned(),
        task_id: fixture.task_id.clone(),
        project_id: fixture.project_id.clone(),
        work_item_id: fixture.work_item_id.clone(),
        provider_instance_id: fixture.provider_instance_id.clone(),
        runtime_session_ref: fixture.runtime_session_ref.clone(),
        event_id: Some("event:fixture:turn-completed".to_owned()),
        receipt_ref: Some(fixture.runtime_receipt_id.0.clone()),
        frame_source_id: "frame-source:fixture".to_owned(),
        decode_outcome_id: "decode-outcome:fixture".to_owned(),
        candidate_state: CodexLiveObservationWorkItemCandidateState::Completed,
        status: CodexLiveObservationWorkItemCandidateStatus::Candidate,
        blockers: Vec::new(),
        evidence_refs: fixture.evidence_refs.clone(),
        advisory_only: true,
        task_mutation_permitted: false,
        raw_provider_material_retained: false,
    }
}

fn codex_adapter(provider_instance_id: &str) -> AdapterIdentity {
    AdapterIdentity {
        adapter_id: "adapter:codex".to_owned(),
        provider_driver_kind: ProviderDriverKind::Codex,
        provider_instance_id: provider_instance_id.to_owned(),
        provider_name: "OpenAI Codex".to_owned(),
        harness_name: "codex app-server".to_owned(),
        transport_family: TransportFamily::StructuredAppServerRuntime,
        version_discovery: VersionDiscovery::Unsupported,
        authentication_preflight: AuthenticationPreflight::Unsupported,
    }
}

fn policy_input(
    fixture: &TaskBackedLiveWorkflowFixture,
) -> CodexAppServerTaskBackedLiveExecutionPolicyInput {
    CodexAppServerTaskBackedLiveExecutionPolicyInput {
        work_item_id: fixture.work_item_id.clone(),
        task_id: fixture.task_id.clone(),
        project_id: fixture.project_id.clone(),
        provider_instance_id: fixture.provider_instance_id.clone(),
        runtime_session_ref: Some(fixture.runtime_session_ref.clone()),
        adapter_id: "adapter:codex".to_owned(),
        execution_host_id: EngineHostId("host:fixture".to_owned()),
        operator_evidence_ref: Some("evidence:fixture:operator".to_owned()),
        pathway_evidence: CodexAppServerTaskBackedLiveExecutionPathwayEvidence::RoadmapReadyCard {
            roadmap_ref: "docs/roadmaps/g02/082-task-backed-live-workflow-closeout.md".to_owned(),
            card_ref: "docs/roadmaps/g02/batch-cards/374-task-backed-live-workflow-fixture.md"
                .to_owned(),
            evidence_ref: "evidence:fixture:pathway".to_owned(),
        },
        tool_policy: CodexAppServerTaskBackedLiveExecutionToolPolicy {
            projection_mode: CodexAppServerTaskBackedLiveExecutionToolProjectionMode::PortalTool,
            adapter_capability_evidence_ref: Some("evidence:fixture:tool-capability".to_owned()),
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

fn live_executor_input(
    fixture: &TaskBackedLiveWorkflowFixture,
    policy: crate::CodexAppServerTaskBackedLiveExecutionPolicyRecord,
) -> CodexAppServerTaskWorkLiveExecutorAdmissionInput {
    assert_eq!(
        policy.status,
        CodexAppServerTaskBackedLiveExecutionPolicyStatus::AcceptedForLiveExecutorAdmission
    );
    CodexAppServerTaskWorkLiveExecutorAdmissionInput {
        policy,
        work_item_id: fixture.work_item_id.clone(),
        task_id: fixture.task_id.clone(),
        project_id: fixture.project_id.clone(),
        provider_instance_id: fixture.provider_instance_id.clone(),
        runtime_session_ref: fixture.runtime_session_ref.clone(),
        live_executor_write_attempt_id: fixture.write_attempt_id.clone(),
        idempotency_key: ProviderTransportWriteIdempotencyKey(
            "idempotency:fixture:task-live-executor".to_owned(),
        ),
        evidence_refs: vec!["evidence:fixture:executor-admission".to_owned()],
        invoke_executor_requested: false,
        raw_provider_material_requested: false,
        task_mutation_requested: false,
    }
}

fn live_executor_outcome_input(
    fixture: &TaskBackedLiveWorkflowFixture,
) -> CodexAppServerLiveExecutorOutcomeInput {
    CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: fixture.provider_instance_id.clone(),
        write_attempt_id: fixture.write_attempt_id.0.clone(),
        receipt_refs: vec![fixture.runtime_receipt_id.0.clone()],
        thread_id: Some("thread:fixture".to_owned()),
        turn_id: Some("turn:fixture".to_owned()),
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
        notification_count: 3,
        server_request_count: 0,
        cleanup_status: CodexAppServerLiveExecutorCleanupStatus::Completed,
        evidence_refs: vec!["evidence:fixture:executor-outcome".to_owned()],
        provider_write_executed: true,
    }
}

fn runtime_receipt(fixture: &TaskBackedLiveWorkflowFixture) -> EngineRuntimeReceiptRecord {
    EngineRuntimeReceiptRecord {
        receipt_id: fixture.runtime_receipt_id.clone(),
        family: nucleus_engine::EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status: EngineRuntimeReceiptStatus::Completed,
        command_ref: None,
        effect_ref: None,
        evidence_refs: fixture
            .evidence_refs
            .iter()
            .map(|reference| nucleus_engine::EngineRuntimeReceiptRef::EventId(reference.clone()))
            .collect(),
        artifact_refs: vec![nucleus_engine::EngineRuntimeReceiptRef::Artifact(
            "artifact:fixture-summary".to_owned(),
        )],
        summary: Some("fixture runtime completed with sanitized evidence".to_owned()),
    }
}

fn completed_work_item(
    fixture: &TaskBackedLiveWorkflowFixture,
    work_item: EngineTaskWorkItemRecord,
) -> EngineTaskWorkItemRecord {
    EngineTaskWorkItemRecord {
        runtime: EngineTaskWorkItemRuntimeState::Completed,
        review: EngineTaskWorkItemReviewState::AwaitingReview,
        refs: EngineTaskWorkItemRefs {
            session_id: Some(AgentSessionId(fixture.runtime_session_ref.clone())),
            receipt_ids: vec![fixture.runtime_receipt_id.clone()],
            checkpoint_ids: vec![EngineCheckpointRecordId("checkpoint:fixture".to_owned())],
            diff_summary_ids: vec![EngineDiffSummaryRecordId("diff:fixture".to_owned())],
            validation_refs: vec!["validation:fixture".to_owned()],
            artifact_refs: vec!["artifact:fixture-summary".to_owned()],
            ..Default::default()
        },
        ..work_item
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_backed_live_workflow_fixture_replays_full_path_without_side_effects() {
        let replay = task_backed_live_workflow_fixture();

        assert!(replay.scheduler_admitted);
        assert!(replay.live_executor_admitted);
        assert_eq!(replay.runtime_progress, "Completed");
        assert_eq!(replay.receipt_link.receipt_id, "receipt:fixture");
        assert_eq!(replay.timeline.entries.len(), 1);
        assert_eq!(replay.task_diagnostics.work_units.len(), 1);
        assert_eq!(replay.live_execution_diagnostics.attempts.len(), 2);
        assert!(!replay.task_completion_permitted_by_runtime);
        assert!(!replay.review_acceptance_permitted_by_runtime);
        assert!(replay.review_accepted_by_explicit_command);
        assert!(!replay.provider_write_executed_before_explicit_smoke);
        assert!(!replay.raw_provider_material_retained);
    }

    #[test]
    fn task_backed_live_workflow_fixture_replay_is_deterministic() {
        let first = task_backed_live_workflow_fixture();
        let second = task_backed_live_workflow_fixture();

        assert_eq!(first, second);
    }

    #[test]
    fn task_backed_live_workflow_fixture_contains_no_raw_provider_material() {
        let replay = task_backed_live_workflow_fixture();
        let debug = format!("{replay:?}");

        assert!(!debug.contains("raw_stdout"));
        assert!(!debug.contains("raw_stderr"));
        assert!(!debug.contains("raw_payload"));
        assert!(!debug.contains("stream_delta"));
        assert!(!replay.live_execution_diagnostics.provider_material_exposed);
    }
}
