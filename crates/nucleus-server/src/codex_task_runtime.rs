//! Task-scoped Codex runtime admission records.
//!
//! This module bridges task work units to the inert scheduler boundary. It does
//! not spawn Codex, answer callbacks, retry sessions, or mutate task state.

use nucleus_agent_protocol::{AdapterIdentity, AgentSessionId};
use nucleus_command_policy::CommandRequestId;
use nucleus_engine::{EngineTaskAgentWorkUnitSourceId, EngineTaskWorkItemId};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::codex_wait_state::CodexWaitStateRecord;
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

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_agent_protocol::{
        AuthenticationPreflight, ProviderDriverKind, TransportFamily, VersionDiscovery,
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
}
