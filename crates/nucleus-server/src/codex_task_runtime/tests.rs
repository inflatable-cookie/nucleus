use super::*;
use nucleus_agent_protocol::{
    AdapterIdentity, AgentSessionId, AuthenticationPreflight, ProviderDriverKind,
    RuntimeEventIdentity, RuntimeEventSource, ToolCallPayload, ToolCallStatus, TransportFamily,
    VersionDiscovery,
};
use nucleus_command_policy::CommandRequestId;
use nucleus_engine::{
    EngineRuntimeReceiptRecord, EngineRuntimeReceiptStatus, EngineTaskAgentWorkUnitSourceId,
    EngineTaskWorkItemId,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::ids::ServerEventId;

fn adapter() -> AdapterIdentity {
    AdapterIdentity {
        adapter_id: "adapter:codex".to_owned(),
        provider_driver_kind: ProviderDriverKind::Codex,
        provider_instance_id: "provider:codex".to_owned(),
        provider_name: "OpenAI Codex".to_owned(),
        harness_name: "codex app-server".to_owned(),
        transport_family: TransportFamily::StructuredAppServerRuntime,
        version_discovery: VersionDiscovery::Unsupported,
        authentication_preflight: AuthenticationPreflight::Unsupported,
    }
}

fn request() -> CodexTaskRuntimeRequestRecord {
    CodexTaskRuntimeRequestRecord {
        request_id: CodexTaskRuntimeRequestId("codex-task-runtime:1".to_owned()),
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
        source_id: EngineTaskAgentWorkUnitSourceId("source:1".to_owned()),
        adapter: adapter(),
        command_request_id: CommandRequestId("command:delegate".to_owned()),
        event_id: ServerEventId("event:task-runtime-request".to_owned()),
        nucleus_session_id: AgentSessionId("session:nucleus".to_owned()),
        codex_refs: CodexTaskRuntimeProviderRefs {
            provider_session_id: Some("session:provider".to_owned()),
            provider_thread_id: Some("thread:provider".to_owned()),
            provider_turn_id: None,
            provider_item_id: None,
            provider_request_id: None,
        },
        summary: "admit task work unit to Codex runtime".to_owned(),
    }
}

#[test]
fn codex_task_runtime_request_admits_to_scheduler_without_execution() {
    let mut queue = RuntimeSchedulerQueue::new();

    let admission = admit_codex_task_runtime_request(&mut queue, request());

    assert!(matches!(
        admission.decision,
        RuntimeSchedulerAdmissionDecision::Accepted(_)
    ));
    assert!(!admission.provider_execution_started);
    assert_eq!(queue.queued_items().len(), 1);
    assert!(matches!(
        queue.queued_items()[0].request.kind,
        RuntimeSchedulerRequestKind::AgentSessionTurn { .. }
    ));
}

#[test]
fn codex_task_runtime_request_rejects_missing_authority_refs() {
    let mut queue = RuntimeSchedulerQueue::new();
    let mut request = request();
    request.command_request_id = CommandRequestId(String::new());

    let admission = admit_codex_task_runtime_request(&mut queue, request);

    assert_eq!(
        admission.decision,
        RuntimeSchedulerAdmissionDecision::Rejected(
            RuntimeSchedulerAdmissionRejection::MissingCommandAuthority
        )
    );
    assert!(queue.queued_items().is_empty());
}

#[test]
fn codex_wait_state_links_to_task_work_unit_without_auto_approval() {
    let request = request();
    let wait = CodexWaitStateRecord {
        wait_id: "wait:1".to_owned(),
        kind: crate::CodexWaitStateKind::Approval,
        status: crate::CodexWaitStateStatus::Waiting,
        provider_instance_id: "provider:codex".to_owned(),
        nucleus_session_id: request.nucleus_session_id.0.clone(),
        provider_session_id: request.codex_refs.provider_session_id.clone(),
        provider_turn_id: Some("turn:provider".to_owned()),
        provider_item_id: Some("item:provider".to_owned()),
        provider_request_id: Some("approval:provider".to_owned()),
        evidence_event_id: "event:approval".to_owned(),
        prompt: "approve command?".to_owned(),
        options: vec!["approve".to_owned(), "deny".to_owned()],
    };

    let link = link_codex_wait_to_task_runtime(&request, &wait);

    assert_eq!(link.task_id, TaskId("task:1".to_owned()));
    assert_eq!(link.work_item_id, EngineTaskWorkItemId("work:1".to_owned()));
    assert_eq!(
        link.provider_request_id.as_deref(),
        Some("approval:provider")
    );
    assert!(!link.approval_is_automatic);
}

#[test]
fn codex_recovery_gate_records_blockers_without_retry_execution() {
    let request = request();

    let gate = codex_task_runtime_recovery_gate(
        &request,
        CodexTaskRuntimeRecoveryState::ResumeBlocked("provider session missing".to_owned()),
        vec!["receipt:recovery".to_owned()],
    );

    assert_eq!(gate.request_id, request.request_id);
    assert_eq!(gate.evidence_refs, vec!["receipt:recovery".to_owned()]);
    assert!(!gate.retry_execution_allowed);
}

#[test]
fn codex_supported_observation_maps_to_task_progress_without_raw_payload() {
    let request = request();
    let ingestion = CodexAppServerLiveIngestion {
        sequence: 1,
        status: crate::CodexAppServerLiveIngestionStatus::Accepted,
        projection: Some(CodexAppServerLiveProjection::Event(runtime_event(
            RuntimeEventKind::ToolCall,
            RuntimeEventPayload::ToolCall(ToolCallPayload {
                tool_name: "shell".to_owned(),
                status: ToolCallStatus::Completed,
                arguments: None,
                result: None,
                source: RuntimeEventSource::Live,
                raw_provider_payload: None,
            }),
        ))),
        unsupported: None,
    };

    let progress = map_codex_task_progress_from_ingestion(&request, &ingestion);

    assert_eq!(progress.kind, CodexTaskRuntimeProgressKind::ToolCall);
    assert_eq!(progress.task_id, TaskId("task:1".to_owned()));
    assert!(progress.terminal);
    assert!(!progress.summary.contains("raw"));
}

#[test]
fn codex_unsupported_observation_stays_inspectable() {
    let request = request();
    let ingestion = CodexAppServerLiveIngestion {
        sequence: 99,
        status: crate::CodexAppServerLiveIngestionStatus::Unsupported,
        projection: None,
        unsupported: Some(CodexAppServerUnsupportedObservation {
            method: "unknown/method".to_owned(),
            provider_instance_id: "provider:codex".to_owned(),
            sequence: 99,
            reason: "unsupported fixture shape".to_owned(),
            raw_payload_policy: crate::CodexRawPayloadPolicy::MetadataOnly,
        }),
    };

    let progress = map_codex_task_progress_from_ingestion(&request, &ingestion);
    let classification = classify_codex_task_runtime_error(&request, &progress);

    assert_eq!(progress.kind, CodexTaskRuntimeProgressKind::Unsupported);
    assert_eq!(
        classification.class,
        CodexTaskRuntimeErrorClass::UnsupportedObservation
    );
    assert!(classification.recovery_required);
    assert!(!classification.retry_eligible);
}

#[test]
fn codex_task_receipt_link_is_reference_only() {
    let request = request();
    let receipt = EngineRuntimeReceiptRecord {
        receipt_id: nucleus_engine::EngineRuntimeReceiptRecordId("receipt:tool:1".to_owned()),
        family: nucleus_engine::EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status: EngineRuntimeReceiptStatus::Completed,
        command_ref: None,
        effect_ref: None,
        evidence_refs: vec![nucleus_engine::EngineRuntimeReceiptRef::EventId(
            "event:tool:complete".to_owned(),
        )],
        artifact_refs: vec![nucleus_engine::EngineRuntimeReceiptRef::Artifact(
            "artifact:summary".to_owned(),
        )],
        summary: Some("tool completed with sanitized evidence".to_owned()),
    };

    let link = link_codex_task_runtime_receipt(&request, &receipt);

    assert_eq!(link.receipt_id, "receipt:tool:1");
    assert_eq!(link.evidence_refs, vec!["event:tool:complete".to_owned()]);
    assert_eq!(link.artifact_refs, vec!["artifact:summary".to_owned()]);
    assert!(!format!("{link:?}").contains("raw_stdout"));
}

#[test]
fn codex_wait_progress_distinguishes_wait_cancel_and_timeout() {
    let request = request();
    let wait = CodexWaitStateRecord {
        wait_id: "wait:approval".to_owned(),
        kind: crate::CodexWaitStateKind::Approval,
        status: crate::CodexWaitStateStatus::Waiting,
        provider_instance_id: "provider:codex".to_owned(),
        nucleus_session_id: request.nucleus_session_id.0.clone(),
        provider_session_id: request.codex_refs.provider_session_id.clone(),
        provider_turn_id: None,
        provider_item_id: None,
        provider_request_id: Some("approval:provider".to_owned()),
        evidence_event_id: "event:approval".to_owned(),
        prompt: "approve?".to_owned(),
        options: Vec::new(),
    };
    let link = link_codex_wait_to_task_runtime(&request, &wait);

    let waiting = progress_from_codex_wait_link(&link, &crate::CodexWaitStateStatus::Waiting);
    let cancelled = progress_from_codex_wait_link(&link, &crate::CodexWaitStateStatus::Cancelled);
    let classification = classify_codex_task_runtime_error(&request, &cancelled);

    assert_eq!(waiting.kind, CodexTaskRuntimeProgressKind::PermissionWait);
    assert!(!waiting.terminal);
    assert!(cancelled.terminal);
    assert_eq!(
        classification.class,
        CodexTaskRuntimeErrorClass::PermissionDenied
    );
    assert!(!classification.retry_eligible);
}

#[test]
fn task_backed_workflow_fixture_projects_to_control_progress_without_side_effects() {
    let work_item = nucleus_engine::EngineTaskWorkItemRecord {
        work_item_id: EngineTaskWorkItemId("work:fixture".to_owned()),
        task_id: TaskId("task:fixture".to_owned()),
        project_id: ProjectId("project:fixture".to_owned()),
        title: "Fixture work".to_owned(),
        intent: nucleus_tasks::TaskActionType::Plan,
        assignment: nucleus_engine::EngineTaskWorkItemAssignment::AdapterInstance {
            adapter_id: "adapter:codex".to_owned(),
            provider_instance_id: "provider:codex".to_owned(),
        },
        runtime: nucleus_engine::EngineTaskWorkItemRuntimeState::Scheduled,
        review: nucleus_engine::EngineTaskWorkItemReviewState::NotReady,
        refs: nucleus_engine::EngineTaskWorkItemRefs {
            session_id: Some(AgentSessionId("session:nucleus".to_owned())),
            ..Default::default()
        },
        summary: Some("fixture work admitted".to_owned()),
    };
    let admission = nucleus_engine::admit_task_agent_work_unit(
        "command:delegate:fixture",
        "actor:operator",
        "fixture",
        None,
        &work_item,
    );
    let mut request = request();
    request.project_id = work_item.project_id.clone();
    request.task_id = work_item.task_id.clone();
    request.work_item_id = work_item.work_item_id.clone();
    request.source_id = admission.source_record.source_id.clone();

    let mut queue = RuntimeSchedulerQueue::new();
    let scheduler_admission = admit_codex_task_runtime_request(&mut queue, request.clone());
    let wait = CodexWaitStateRecord {
        wait_id: "wait:fixture".to_owned(),
        kind: crate::CodexWaitStateKind::Approval,
        status: crate::CodexWaitStateStatus::Waiting,
        provider_instance_id: "provider:codex".to_owned(),
        nucleus_session_id: request.nucleus_session_id.0.clone(),
        provider_session_id: request.codex_refs.provider_session_id.clone(),
        provider_turn_id: Some("turn:provider".to_owned()),
        provider_item_id: Some("item:provider".to_owned()),
        provider_request_id: Some("approval:fixture".to_owned()),
        evidence_event_id: "event:approval:fixture".to_owned(),
        prompt: "approve fixture?".to_owned(),
        options: vec!["approve".to_owned(), "deny".to_owned()],
    };
    let wait_link = link_codex_wait_to_task_runtime(&request, &wait);
    let wait_progress = progress_from_codex_wait_link(&wait_link, &CodexWaitStateStatus::Waiting);
    let receipt = EngineRuntimeReceiptRecord {
        receipt_id: nucleus_engine::EngineRuntimeReceiptRecordId("receipt:fixture".to_owned()),
        family: nucleus_engine::EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status: EngineRuntimeReceiptStatus::Completed,
        command_ref: Some(nucleus_engine::EngineRuntimeReceiptRef::CommandId(
            "command:delegate:fixture".to_owned(),
        )),
        effect_ref: None,
        evidence_refs: vec![nucleus_engine::EngineRuntimeReceiptRef::EventId(
            "event:tool:fixture".to_owned(),
        )],
        artifact_refs: vec![nucleus_engine::EngineRuntimeReceiptRef::Artifact(
            "artifact:fixture-summary".to_owned(),
        )],
        summary: Some("fixture runtime completed".to_owned()),
    };
    let receipt_link = link_codex_task_runtime_receipt(&request, &receipt);
    let completed_work_item = nucleus_engine::EngineTaskWorkItemRecord {
        runtime: nucleus_engine::EngineTaskWorkItemRuntimeState::Completed,
        review: nucleus_engine::EngineTaskWorkItemReviewState::AwaitingReview,
        refs: nucleus_engine::EngineTaskWorkItemRefs {
            session_id: Some(AgentSessionId("session:nucleus".to_owned())),
            receipt_ids: vec![nucleus_engine::EngineRuntimeReceiptRecordId(
                "receipt:fixture".to_owned(),
            )],
            checkpoint_ids: vec![nucleus_engine::EngineCheckpointRecordId(
                "checkpoint:fixture".to_owned(),
            )],
            diff_summary_ids: vec![nucleus_engine::EngineDiffSummaryRecordId(
                "diff:fixture".to_owned(),
            )],
            validation_refs: vec!["validation:fixture".to_owned()],
            artifact_refs: vec!["artifact:fixture-summary".to_owned()],
            ..Default::default()
        },
        ..work_item
    };
    let review_transition = completed_work_item
        .apply_review_command(nucleus_engine::EngineTaskWorkItemReviewCommand {
            command_id: "command:review:fixture".to_owned(),
            work_item_id: EngineTaskWorkItemId("work:fixture".to_owned()),
            expected_review: Some(nucleus_engine::EngineTaskWorkItemReviewState::AwaitingReview),
            decision: nucleus_engine::EngineTaskWorkItemReviewDecision {
                reviewer_ref: "operator:tom".to_owned(),
                outcome: nucleus_engine::EngineTaskWorkItemReviewOutcome::Accept,
                validation_refs: vec!["validation:fixture".to_owned()],
                checkpoint_ids: vec![nucleus_engine::EngineCheckpointRecordId(
                    "checkpoint:fixture".to_owned(),
                )],
                diff_summary_ids: vec![nucleus_engine::EngineDiffSummaryRecordId(
                    "diff:fixture".to_owned(),
                )],
                note: Some("fixture accepted".to_owned()),
            },
        })
        .expect("review transition");
    let mut review_source = admission.source_record.clone();
    review_source.source_id =
        nucleus_engine::EngineTaskAgentWorkUnitSourceId("source:fixture:review".to_owned());
    review_source.source_cursor =
        nucleus_engine::EngineTaskAgentWorkUnitSourceCursor("zz:fixture:review".to_owned());
    review_source.runtime = nucleus_engine::EngineTaskAgentWorkUnitRuntimeStatus::Completed;
    review_source.review = nucleus_engine::EngineTaskAgentWorkUnitReviewStatus::Accepted;
    review_source.refs = review_transition.work_item.refs.clone();
    review_source.previous_source_id = Some(admission.source_record.source_id.clone());
    review_source.summary = "fixture accepted after review".to_owned();
    let diagnostics = crate::task_agent_diagnostics(&[admission.source_record, review_source]);
    let response = crate::control_api::ServerControlResponse {
        request_id: crate::ServerControlRequestId("request:fixture:progress".to_owned()),
        status: crate::control_api::ServerControlResponseStatus::Complete,
        body: crate::control_api::ServerControlResponseBody::Query(
            crate::control_api::ServerQueryResult::TaskWorkProgress(diagnostics.work_units.clone()),
        ),
    };
    let dto = crate::control_envelope_dto::ControlResponseEnvelopeDto::try_from(&response)
        .expect("progress dto");

    assert!(matches!(
        scheduler_admission.decision,
        RuntimeSchedulerAdmissionDecision::Accepted(_)
    ));
    assert!(!scheduler_admission.provider_execution_started);
    assert_eq!(queue.queued_items().len(), 1);
    assert_eq!(
        wait_progress.kind,
        CodexTaskRuntimeProgressKind::PermissionWait
    );
    assert!(!wait_progress.terminal);
    assert_eq!(receipt_link.receipt_id, "receipt:fixture");
    assert!(!review_transition.task_completion_allowed);
    assert!(matches!(
        dto.body,
        crate::control_envelope_dto::ControlResponseBodyDto::TaskWorkProgressRecords {
            records,
            client_can_mutate: false,
            provider_execution_available: false,
        } if records.len() == 1
            && records[0].runtime == "completed"
            && records[0].review == "accepted"
            && records[0].receipt_ids == vec!["receipt:fixture".to_owned()]
            && records[0].checkpoint_ids == vec!["checkpoint:fixture".to_owned()]
            && records[0].diff_summary_ids == vec!["diff:fixture".to_owned()]
    ));
}

fn runtime_event(kind: RuntimeEventKind, payload: RuntimeEventPayload) -> AdapterRuntimeEvent {
    AdapterRuntimeEvent {
        identity: RuntimeEventIdentity {
            nucleus_event_id: "event:codex:1".to_owned(),
            provider_driver_kind: ProviderDriverKind::Codex,
            provider_instance_id: "provider:codex".to_owned(),
            provider_session_id: Some("session:provider".to_owned()),
            nucleus_session_id: "session:nucleus".to_owned(),
            provider_message_id: None,
            nucleus_message_id: None,
            turn_id: Some("turn:nucleus".to_owned()),
            item_id: Some("item:nucleus".to_owned()),
            request_id: None,
            provider_turn_id: Some("turn:provider".to_owned()),
            provider_item_id: Some("item:provider".to_owned()),
            provider_request_id: None,
            event_sequence: 1,
            parent_event_id: None,
            synthetic: false,
        },
        kind,
        payload,
    }
}
