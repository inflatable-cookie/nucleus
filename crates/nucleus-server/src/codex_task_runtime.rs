//! Task-scoped Codex runtime admission records.
//!
//! This module bridges task work units to the inert scheduler boundary. It does
//! not spawn Codex, answer callbacks, retry sessions, or mutate task state.

use nucleus_agent_protocol::{
    AdapterIdentity, AdapterRuntimeEvent, AgentSessionId, RuntimeEventKind, RuntimeEventPayload,
};
use nucleus_command_policy::CommandRequestId;
use nucleus_engine::{
    EngineRuntimeReceiptRecord, EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
    EngineTaskAgentWorkUnitSourceId, EngineTaskWorkItemId,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::codex_supervision::{
    CodexAppServerLiveIngestion, CodexAppServerLiveProjection, CodexAppServerUnsupportedObservation,
};
use crate::codex_wait_state::{CodexWaitStateRecord, CodexWaitStateStatus};
use crate::ids::ServerEventId;
use crate::scheduler::{
    RuntimeSchedulerAdmissionDecision, RuntimeSchedulerAdmissionRejection, RuntimeSchedulerQueue,
    RuntimeSchedulerRequest, RuntimeSchedulerRequestId, RuntimeSchedulerRequestKind,
    RuntimeSchedulerRequestRefs,
};

/// Task-scoped request to admit Codex runtime work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexTaskRuntimeRequestRecord {
    pub request_id: CodexTaskRuntimeRequestId,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub source_id: EngineTaskAgentWorkUnitSourceId,
    pub adapter: AdapterIdentity,
    pub command_request_id: CommandRequestId,
    pub event_id: ServerEventId,
    pub nucleus_session_id: AgentSessionId,
    pub codex_refs: CodexTaskRuntimeProviderRefs,
    pub summary: String,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexTaskRuntimeRequestId(pub String);

/// Codex-native refs preserved outside the generic work-unit model.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CodexTaskRuntimeProviderRefs {
    pub provider_session_id: Option<String>,
    pub provider_thread_id: Option<String>,
    pub provider_turn_id: Option<String>,
    pub provider_item_id: Option<String>,
    pub provider_request_id: Option<String>,
}

/// Admission result for a task-scoped Codex runtime request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexTaskRuntimeAdmission {
    pub request_id: CodexTaskRuntimeRequestId,
    pub decision: RuntimeSchedulerAdmissionDecision,
    pub provider_execution_started: bool,
}

/// Link between a Codex wait state and the owning task work unit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexTaskRuntimeWaitLink {
    pub wait_id: String,
    pub request_id: CodexTaskRuntimeRequestId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub nucleus_session_id: AgentSessionId,
    pub provider_request_id: Option<String>,
    pub evidence_event_id: String,
    pub approval_is_automatic: bool,
}

/// Recovery gate for task-scoped Codex work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexTaskRuntimeRecoveryGate {
    pub request_id: CodexTaskRuntimeRequestId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub state: CodexTaskRuntimeRecoveryState,
    pub evidence_refs: Vec<String>,
    pub retry_execution_allowed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexTaskRuntimeRecoveryState {
    NotNeeded,
    CancellationRecorded,
    ResumeBlocked(String),
    RecoveryRequired(String),
}

/// Task progress fact derived from a Codex runtime observation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexTaskRuntimeProgressEvent {
    pub progress_id: String,
    pub request_id: CodexTaskRuntimeRequestId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub kind: CodexTaskRuntimeProgressKind,
    pub evidence_ref: String,
    pub summary: String,
    pub terminal: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexTaskRuntimeProgressKind {
    Session,
    Turn,
    Message,
    ToolCall,
    CommandExecution,
    PermissionWait,
    UserInputWait,
    Warning,
    Error,
    Unsupported,
    RuntimeReceipt,
}

/// Link between a work unit and a sanitized runtime receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexTaskRuntimeReceiptLink {
    pub request_id: CodexTaskRuntimeRequestId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub receipt_id: String,
    pub status: EngineRuntimeReceiptStatus,
    pub evidence_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub summary: Option<String>,
}

/// Error classification metadata. It never triggers retry execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexTaskRuntimeErrorClassification {
    pub request_id: CodexTaskRuntimeRequestId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub class: CodexTaskRuntimeErrorClass,
    pub evidence_ref: String,
    pub retry_eligible: bool,
    pub recovery_required: bool,
    pub summary: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexTaskRuntimeErrorClass {
    UnsupportedObservation,
    ProviderRuntimeError,
    PermissionDenied,
    RecoveryRequired,
    Unknown,
}

/// Admit a task-scoped Codex request into the inert scheduler.
pub fn admit_codex_task_runtime_request(
    queue: &mut RuntimeSchedulerQueue,
    request: CodexTaskRuntimeRequestRecord,
) -> CodexTaskRuntimeAdmission {
    let request_id = request.request_id.clone();
    let decision = validate_codex_task_runtime_request(&request)
        .map(|()| queue.submit(scheduler_request_from_codex_request(request)))
        .unwrap_or_else(RuntimeSchedulerAdmissionDecision::Rejected);

    CodexTaskRuntimeAdmission {
        request_id,
        decision,
        provider_execution_started: false,
    }
}

/// Attach a server-owned Codex wait to its task work unit.
pub fn link_codex_wait_to_task_runtime(
    request: &CodexTaskRuntimeRequestRecord,
    wait: &CodexWaitStateRecord,
) -> CodexTaskRuntimeWaitLink {
    CodexTaskRuntimeWaitLink {
        wait_id: wait.wait_id.clone(),
        request_id: request.request_id.clone(),
        task_id: request.task_id.clone(),
        work_item_id: request.work_item_id.clone(),
        nucleus_session_id: request.nucleus_session_id.clone(),
        provider_request_id: wait.provider_request_id.clone(),
        evidence_event_id: wait.evidence_event_id.clone(),
        approval_is_automatic: false,
    }
}

/// Represent a recovery gate without retrying or resuming Codex.
pub fn codex_task_runtime_recovery_gate(
    request: &CodexTaskRuntimeRequestRecord,
    state: CodexTaskRuntimeRecoveryState,
    evidence_refs: Vec<String>,
) -> CodexTaskRuntimeRecoveryGate {
    CodexTaskRuntimeRecoveryGate {
        request_id: request.request_id.clone(),
        task_id: request.task_id.clone(),
        work_item_id: request.work_item_id.clone(),
        state,
        evidence_refs,
        retry_execution_allowed: false,
    }
}

/// Map a Codex ingestion into task progress without retaining raw payloads.
pub fn map_codex_task_progress_from_ingestion(
    request: &CodexTaskRuntimeRequestRecord,
    ingestion: &CodexAppServerLiveIngestion,
) -> CodexTaskRuntimeProgressEvent {
    match &ingestion.projection {
        Some(CodexAppServerLiveProjection::Event(event)) => progress_from_event(request, event),
        Some(CodexAppServerLiveProjection::RuntimeReceipt(receipt)) => {
            CodexTaskRuntimeProgressEvent {
                progress_id: format!("progress:{}:receipt", request.request_id.0),
                request_id: request.request_id.clone(),
                task_id: request.task_id.clone(),
                work_item_id: request.work_item_id.clone(),
                kind: CodexTaskRuntimeProgressKind::RuntimeReceipt,
                evidence_ref: receipt
                    .evidence_event_id
                    .clone()
                    .unwrap_or_else(|| format!("receipt:{}", receipt.receipt_id)),
                summary: receipt.summary.clone(),
                terminal: matches!(
                    receipt.status,
                    nucleus_agent_protocol::CodexRuntimeReceiptStatus::Completed
                        | nucleus_agent_protocol::CodexRuntimeReceiptStatus::Cancelled
                        | nucleus_agent_protocol::CodexRuntimeReceiptStatus::Failed
                ),
            }
        }
        None => progress_from_unsupported(request, ingestion.unsupported.as_ref()),
    }
}

/// Link a sanitized receipt to a task work unit.
pub fn link_codex_task_runtime_receipt(
    request: &CodexTaskRuntimeRequestRecord,
    receipt: &EngineRuntimeReceiptRecord,
) -> CodexTaskRuntimeReceiptLink {
    CodexTaskRuntimeReceiptLink {
        request_id: request.request_id.clone(),
        task_id: request.task_id.clone(),
        work_item_id: request.work_item_id.clone(),
        receipt_id: receipt.receipt_id.0.clone(),
        status: receipt.status.clone(),
        evidence_refs: receipt
            .evidence_refs
            .iter()
            .map(runtime_receipt_ref)
            .collect(),
        artifact_refs: receipt
            .artifact_refs
            .iter()
            .map(runtime_receipt_ref)
            .collect(),
        summary: receipt.summary.clone(),
    }
}

/// Project a wait state into task progress.
pub fn progress_from_codex_wait_link(
    link: &CodexTaskRuntimeWaitLink,
    status: &CodexWaitStateStatus,
) -> CodexTaskRuntimeProgressEvent {
    CodexTaskRuntimeProgressEvent {
        progress_id: format!("progress:{}:wait:{}", link.request_id.0, link.wait_id),
        request_id: link.request_id.clone(),
        task_id: link.task_id.clone(),
        work_item_id: link.work_item_id.clone(),
        kind: CodexTaskRuntimeProgressKind::PermissionWait,
        evidence_ref: link.evidence_event_id.clone(),
        summary: match status {
            CodexWaitStateStatus::Waiting => "waiting for explicit operator approval".to_owned(),
            CodexWaitStateStatus::Cancelled => "approval wait cancelled".to_owned(),
            CodexWaitStateStatus::TimedOut => "approval wait timed out".to_owned(),
        },
        terminal: !matches!(status, CodexWaitStateStatus::Waiting),
    }
}

/// Classify a Codex task runtime error without retrying it.
pub fn classify_codex_task_runtime_error(
    request: &CodexTaskRuntimeRequestRecord,
    progress: &CodexTaskRuntimeProgressEvent,
) -> CodexTaskRuntimeErrorClassification {
    let class = match progress.kind {
        CodexTaskRuntimeProgressKind::Unsupported => {
            CodexTaskRuntimeErrorClass::UnsupportedObservation
        }
        CodexTaskRuntimeProgressKind::Error => CodexTaskRuntimeErrorClass::ProviderRuntimeError,
        CodexTaskRuntimeProgressKind::PermissionWait if progress.terminal => {
            CodexTaskRuntimeErrorClass::PermissionDenied
        }
        _ => CodexTaskRuntimeErrorClass::Unknown,
    };
    let recovery_required = matches!(
        class,
        CodexTaskRuntimeErrorClass::UnsupportedObservation
            | CodexTaskRuntimeErrorClass::ProviderRuntimeError
    );

    CodexTaskRuntimeErrorClassification {
        request_id: request.request_id.clone(),
        task_id: request.task_id.clone(),
        work_item_id: request.work_item_id.clone(),
        class,
        evidence_ref: progress.evidence_ref.clone(),
        retry_eligible: false,
        recovery_required,
        summary: progress.summary.clone(),
    }
}

fn validate_codex_task_runtime_request(
    request: &CodexTaskRuntimeRequestRecord,
) -> Result<(), RuntimeSchedulerAdmissionRejection> {
    if request.project_id.0.trim().is_empty() {
        return Err(RuntimeSchedulerAdmissionRejection::MissingProject);
    }
    if request.command_request_id.0.trim().is_empty() {
        return Err(RuntimeSchedulerAdmissionRejection::MissingCommandAuthority);
    }
    if request.adapter.adapter_id.trim().is_empty() {
        return Err(RuntimeSchedulerAdmissionRejection::MissingAdapter);
    }
    if request.event_id.0.trim().is_empty() {
        return Err(RuntimeSchedulerAdmissionRejection::MissingEventMetadata);
    }
    Ok(())
}

fn scheduler_request_from_codex_request(
    request: CodexTaskRuntimeRequestRecord,
) -> RuntimeSchedulerRequest {
    RuntimeSchedulerRequest {
        id: RuntimeSchedulerRequestId(format!("scheduler:{}", request.request_id.0)),
        kind: RuntimeSchedulerRequestKind::AgentSessionTurn {
            session_id: request.nucleus_session_id,
        },
        refs: RuntimeSchedulerRequestRefs {
            project_id: request.project_id,
            task_id: Some(request.task_id),
            adapter: Some(request.adapter),
            command_request_id: Some(request.command_request_id),
            server_event_id: Some(request.event_id),
            runtime_effect_record_id: None,
            retained_refs: Vec::new(),
        },
        summary: Some(request.summary),
    }
}

fn runtime_receipt_ref(receipt_ref: &EngineRuntimeReceiptRef) -> String {
    match receipt_ref {
        EngineRuntimeReceiptRef::CommandId(value)
        | EngineRuntimeReceiptRef::CommandRequestId(value)
        | EngineRuntimeReceiptRef::CommandEvidenceId(value)
        | EngineRuntimeReceiptRef::Artifact(value)
        | EngineRuntimeReceiptRef::EventId(value)
        | EngineRuntimeReceiptRef::Custom(value) => value.clone(),
    }
}

fn progress_from_event(
    request: &CodexTaskRuntimeRequestRecord,
    event: &AdapterRuntimeEvent,
) -> CodexTaskRuntimeProgressEvent {
    let kind = match event.kind {
        RuntimeEventKind::Session | RuntimeEventKind::Thread => {
            CodexTaskRuntimeProgressKind::Session
        }
        RuntimeEventKind::Turn => CodexTaskRuntimeProgressKind::Turn,
        RuntimeEventKind::MessageItem
        | RuntimeEventKind::Reasoning
        | RuntimeEventKind::ContentDelta => CodexTaskRuntimeProgressKind::Message,
        RuntimeEventKind::ToolCall => CodexTaskRuntimeProgressKind::ToolCall,
        RuntimeEventKind::CommandExecution => CodexTaskRuntimeProgressKind::CommandExecution,
        RuntimeEventKind::PermissionRequest => CodexTaskRuntimeProgressKind::PermissionWait,
        RuntimeEventKind::UserInputRequest => CodexTaskRuntimeProgressKind::UserInputWait,
        RuntimeEventKind::RuntimeWarning => CodexTaskRuntimeProgressKind::Warning,
        RuntimeEventKind::RuntimeError => CodexTaskRuntimeProgressKind::Error,
        RuntimeEventKind::FileChange
        | RuntimeEventKind::TokenUsage
        | RuntimeEventKind::ProviderExtension(_) => CodexTaskRuntimeProgressKind::Message,
    };
    let terminal = event_is_terminal(&event.payload);

    CodexTaskRuntimeProgressEvent {
        progress_id: format!(
            "progress:{}:{}",
            request.request_id.0, event.identity.nucleus_event_id
        ),
        request_id: request.request_id.clone(),
        task_id: request.task_id.clone(),
        work_item_id: request.work_item_id.clone(),
        kind,
        evidence_ref: event.identity.nucleus_event_id.clone(),
        summary: format!("Codex runtime event {:?}", event.kind),
        terminal,
    }
}

fn progress_from_unsupported(
    request: &CodexTaskRuntimeRequestRecord,
    unsupported: Option<&CodexAppServerUnsupportedObservation>,
) -> CodexTaskRuntimeProgressEvent {
    let evidence_ref = unsupported
        .map(|observation| {
            format!(
                "codex:unsupported:{}:{}",
                observation.method, observation.sequence
            )
        })
        .unwrap_or_else(|| format!("codex:unsupported:{}", request.request_id.0));
    CodexTaskRuntimeProgressEvent {
        progress_id: format!("progress:{}:unsupported", request.request_id.0),
        request_id: request.request_id.clone(),
        task_id: request.task_id.clone(),
        work_item_id: request.work_item_id.clone(),
        kind: CodexTaskRuntimeProgressKind::Unsupported,
        evidence_ref,
        summary: unsupported
            .map(|observation| observation.reason.clone())
            .unwrap_or_else(|| "unsupported Codex observation".to_owned()),
        terminal: false,
    }
}

fn event_is_terminal(payload: &RuntimeEventPayload) -> bool {
    use nucleus_agent_protocol::{CommandStatus, ToolCallStatus, TurnPayloadKind};

    match payload {
        RuntimeEventPayload::Turn(turn) => matches!(
            turn.kind,
            TurnPayloadKind::Completed | TurnPayloadKind::Aborted | TurnPayloadKind::Failed
        ),
        RuntimeEventPayload::ToolCall(tool) => {
            matches!(
                tool.status,
                ToolCallStatus::Completed | ToolCallStatus::Failed
            )
        }
        RuntimeEventPayload::CommandExecution(command) => matches!(
            command.status,
            CommandStatus::Completed | CommandStatus::Failed | CommandStatus::Cancelled
        ),
        RuntimeEventPayload::Error(_) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_agent_protocol::{
        AuthenticationPreflight, ProviderDriverKind, RuntimeEventIdentity, RuntimeEventSource,
        ToolCallPayload, ToolCallStatus, TransportFamily, VersionDiscovery,
    };

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
        let cancelled =
            progress_from_codex_wait_link(&link, &crate::CodexWaitStateStatus::Cancelled);
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
        let scheduler_admission =
            admit_codex_task_runtime_request(&mut queue, request.clone());
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
        let wait_progress =
            progress_from_codex_wait_link(&wait_link, &CodexWaitStateStatus::Waiting);
        let receipt = EngineRuntimeReceiptRecord {
            receipt_id: nucleus_engine::EngineRuntimeReceiptRecordId(
                "receipt:fixture".to_owned(),
            ),
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
                crate::control_api::ServerQueryResult::TaskWorkProgress(
                    diagnostics.work_units.clone(),
                ),
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
        assert_eq!(wait_progress.kind, CodexTaskRuntimeProgressKind::PermissionWait);
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
}
