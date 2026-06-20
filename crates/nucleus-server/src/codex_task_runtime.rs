//! Task-scoped Codex runtime admission records.
//!
//! This module bridges task work units to the inert scheduler boundary. It does
//! not spawn Codex, answer callbacks, retry sessions, or mutate task state.

use nucleus_agent_protocol::{AdapterRuntimeEvent, RuntimeEventKind, RuntimeEventPayload};
use nucleus_engine::{EngineRuntimeReceiptRecord, EngineRuntimeReceiptRef};

use crate::codex_supervision::{
    CodexAppServerLiveIngestion, CodexAppServerLiveProjection, CodexAppServerUnsupportedObservation,
};
use crate::codex_wait_state::{CodexWaitStateRecord, CodexWaitStateStatus};
use crate::scheduler::{
    RuntimeSchedulerAdmissionDecision, RuntimeSchedulerAdmissionRejection, RuntimeSchedulerQueue,
    RuntimeSchedulerRequest, RuntimeSchedulerRequestId, RuntimeSchedulerRequestKind,
    RuntimeSchedulerRequestRefs,
};

mod live_observation_timeline_projection;
mod observation_links;
mod review_readiness;
mod types;
mod work_item_candidates;
mod work_item_transition_admission;

pub use live_observation_timeline_projection::{
    rebuild_codex_live_observation_task_timeline, CodexLiveObservationTaskTimelineEntry,
    CodexLiveObservationTaskTimelineProjection,
};
pub use observation_links::{
    link_codex_observation_to_task_runtime, CodexTaskRuntimeObservationLink,
    CodexTaskRuntimeObservationLinkStatus,
};
pub use review_readiness::{
    codex_review_readiness_from_live_observation, CodexReviewReadinessFromLiveObservationBlocker,
    CodexReviewReadinessFromLiveObservationInput, CodexReviewReadinessFromLiveObservationRecord,
    CodexReviewReadinessFromLiveObservationStatus,
};
pub use types::{
    CodexTaskRuntimeAdmission, CodexTaskRuntimeErrorClass, CodexTaskRuntimeErrorClassification,
    CodexTaskRuntimeProgressEvent, CodexTaskRuntimeProgressKind, CodexTaskRuntimeProviderRefs,
    CodexTaskRuntimeReceiptLink, CodexTaskRuntimeRecoveryGate, CodexTaskRuntimeRecoveryState,
    CodexTaskRuntimeRequestId, CodexTaskRuntimeRequestRecord, CodexTaskRuntimeWaitLink,
};
pub use work_item_candidates::{
    codex_live_observation_work_item_candidate, CodexLiveObservationWorkItemCandidate,
    CodexLiveObservationWorkItemCandidateBlocker, CodexLiveObservationWorkItemCandidateInput,
    CodexLiveObservationWorkItemCandidateState, CodexLiveObservationWorkItemCandidateStatus,
};
pub use work_item_transition_admission::{
    admit_codex_work_item_runtime_transition, CodexWorkItemRuntimeTransitionAdmissionBlocker,
    CodexWorkItemRuntimeTransitionAdmissionInput, CodexWorkItemRuntimeTransitionAdmissionRecord,
    CodexWorkItemRuntimeTransitionAdmissionStatus,
};

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
mod tests;
