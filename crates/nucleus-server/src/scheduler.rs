//! Inert runtime scheduler acceptance queue.
//!
//! This module decides whether work is shaped well enough to enter a queue. It
//! does not spawn processes, run commands, start adapters, manage worktrees,
//! schedule background workers, retry work, or execute runtime effects.

use std::collections::VecDeque;

use nucleus_agent_protocol::{AdapterIdentity, AgentSessionId};
use nucleus_command_policy::{CommandEffectRequestId, CommandRequestId};
use nucleus_projects::ProjectId;
use nucleus_scm_forge::AdapterEffectRequestId;
use nucleus_tasks::TaskId;

use crate::ids::ServerEventId;
use crate::runtime_effect_storage::{RuntimeEffectStorageRecordId, RuntimeEffectStorageRef};

/// Stable scheduler request id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RuntimeSchedulerRequestId(pub String);

/// Request submitted to the scheduler acceptance boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeSchedulerRequest {
    pub id: RuntimeSchedulerRequestId,
    pub kind: RuntimeSchedulerRequestKind,
    pub refs: RuntimeSchedulerRequestRefs,
    pub summary: Option<String>,
}

/// Runtime work category.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeSchedulerRequestKind {
    AgentSessionTurn { session_id: AgentSessionId },
    CommandEffect { request_id: CommandEffectRequestId },
    AdapterEffect { request_id: AdapterEffectRequestId },
    NativeStewardTask,
    Validation,
    Custom(String),
}

/// Authority and metadata refs attached to a queued request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeSchedulerRequestRefs {
    pub project_id: ProjectId,
    pub task_id: Option<TaskId>,
    pub adapter: Option<AdapterIdentity>,
    pub command_request_id: Option<CommandRequestId>,
    pub server_event_id: Option<ServerEventId>,
    pub runtime_effect_record_id: Option<RuntimeEffectStorageRecordId>,
    pub retained_refs: Vec<RuntimeEffectStorageRef>,
}

/// Result of admission into the inert scheduler queue.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeSchedulerAdmissionDecision {
    Accepted(RuntimeSchedulerQueuedItem),
    Rejected(RuntimeSchedulerAdmissionRejection),
}

/// Rejection reason before any runtime execution exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeSchedulerAdmissionRejection {
    MissingProject,
    MissingCommandAuthority,
    MissingAdapter,
    MissingEventMetadata,
    UnsupportedRequestKind,
    RuntimeExecutionDeferred,
    Custom(String),
}

/// Inert queued runtime item.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeSchedulerQueuedItem {
    pub request: RuntimeSchedulerRequest,
    pub position: usize,
}

/// In-memory acceptance queue for tests and local boundary composition.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RuntimeSchedulerQueue {
    queued: VecDeque<RuntimeSchedulerQueuedItem>,
}

impl RuntimeSchedulerQueue {
    /// Create an empty inert queue.
    pub fn new() -> Self {
        Self::default()
    }

    /// Submit work to the queue after boundary-level admission checks.
    pub fn submit(
        &mut self,
        request: RuntimeSchedulerRequest,
    ) -> RuntimeSchedulerAdmissionDecision {
        if request.refs.project_id.0.is_empty() {
            return RuntimeSchedulerAdmissionDecision::Rejected(
                RuntimeSchedulerAdmissionRejection::MissingProject,
            );
        }

        if matches!(
            request.kind,
            RuntimeSchedulerRequestKind::CommandEffect { .. }
        ) && request.refs.command_request_id.is_none()
        {
            return RuntimeSchedulerAdmissionDecision::Rejected(
                RuntimeSchedulerAdmissionRejection::MissingCommandAuthority,
            );
        }

        if matches!(
            request.kind,
            RuntimeSchedulerRequestKind::AgentSessionTurn { .. }
                | RuntimeSchedulerRequestKind::AdapterEffect { .. }
        ) && request.refs.adapter.is_none()
        {
            return RuntimeSchedulerAdmissionDecision::Rejected(
                RuntimeSchedulerAdmissionRejection::MissingAdapter,
            );
        }

        if request.refs.server_event_id.is_none()
            && request.refs.runtime_effect_record_id.is_none()
            && request.refs.retained_refs.is_empty()
        {
            return RuntimeSchedulerAdmissionDecision::Rejected(
                RuntimeSchedulerAdmissionRejection::MissingEventMetadata,
            );
        }

        let queued = RuntimeSchedulerQueuedItem {
            request,
            position: self.queued.len(),
        };
        self.queued.push_back(queued.clone());
        RuntimeSchedulerAdmissionDecision::Accepted(queued)
    }

    /// Inspect queued items without executing them.
    pub fn queued_items(&self) -> Vec<RuntimeSchedulerQueuedItem> {
        self.queued.iter().cloned().collect()
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
            provider_name: "codex".to_owned(),
            harness_name: "codex-cli".to_owned(),
            transport_family: TransportFamily::CliTerminalBridge,
            version_discovery: VersionDiscovery::Unsupported,
            authentication_preflight: AuthenticationPreflight::Unsupported,
        }
    }

    fn refs() -> RuntimeSchedulerRequestRefs {
        RuntimeSchedulerRequestRefs {
            project_id: ProjectId("project:1".to_owned()),
            task_id: Some(TaskId("task:1".to_owned())),
            adapter: Some(adapter()),
            command_request_id: Some(CommandRequestId("command:1".to_owned())),
            server_event_id: Some(ServerEventId("event:1".to_owned())),
            runtime_effect_record_id: None,
            retained_refs: Vec::new(),
        }
    }

    #[test]
    fn queue_accepts_inert_command_effect_with_authority_and_metadata_refs() {
        let mut queue = RuntimeSchedulerQueue::new();
        let request = RuntimeSchedulerRequest {
            id: RuntimeSchedulerRequestId("scheduler:1".to_owned()),
            kind: RuntimeSchedulerRequestKind::CommandEffect {
                request_id: CommandEffectRequestId("effect:command:1".to_owned()),
            },
            refs: refs(),
            summary: Some("queue command effect after policy acceptance".to_owned()),
        };

        let decision = queue.submit(request);

        assert!(matches!(
            decision,
            RuntimeSchedulerAdmissionDecision::Accepted(_)
        ));
        assert_eq!(queue.queued_items().len(), 1);
    }

    #[test]
    fn queue_rejects_command_effect_without_command_authority_ref() {
        let mut queue = RuntimeSchedulerQueue::new();
        let mut refs = refs();
        refs.command_request_id = None;
        let request = RuntimeSchedulerRequest {
            id: RuntimeSchedulerRequestId("scheduler:missing-command".to_owned()),
            kind: RuntimeSchedulerRequestKind::CommandEffect {
                request_id: CommandEffectRequestId("effect:command:missing".to_owned()),
            },
            refs,
            summary: None,
        };

        let decision = queue.submit(request);

        assert_eq!(
            decision,
            RuntimeSchedulerAdmissionDecision::Rejected(
                RuntimeSchedulerAdmissionRejection::MissingCommandAuthority
            )
        );
        assert!(queue.queued_items().is_empty());
    }

    #[test]
    fn queue_rejects_adapter_effect_without_adapter_ref() {
        let mut queue = RuntimeSchedulerQueue::new();
        let mut refs = refs();
        refs.adapter = None;
        let request = RuntimeSchedulerRequest {
            id: RuntimeSchedulerRequestId("scheduler:missing-adapter".to_owned()),
            kind: RuntimeSchedulerRequestKind::AdapterEffect {
                request_id: AdapterEffectRequestId("effect:adapter:1".to_owned()),
            },
            refs,
            summary: None,
        };

        let decision = queue.submit(request);

        assert_eq!(
            decision,
            RuntimeSchedulerAdmissionDecision::Rejected(
                RuntimeSchedulerAdmissionRejection::MissingAdapter
            )
        );
        assert!(queue.queued_items().is_empty());
    }

    #[test]
    fn queue_rejects_requests_without_event_metadata_refs() {
        let mut queue = RuntimeSchedulerQueue::new();
        let mut refs = refs();
        refs.server_event_id = None;
        refs.runtime_effect_record_id = None;
        refs.retained_refs.clear();
        let request = RuntimeSchedulerRequest {
            id: RuntimeSchedulerRequestId("scheduler:missing-event".to_owned()),
            kind: RuntimeSchedulerRequestKind::NativeStewardTask,
            refs,
            summary: None,
        };

        let decision = queue.submit(request);

        assert_eq!(
            decision,
            RuntimeSchedulerAdmissionDecision::Rejected(
                RuntimeSchedulerAdmissionRejection::MissingEventMetadata
            )
        );
        assert!(queue.queued_items().is_empty());
    }
}
