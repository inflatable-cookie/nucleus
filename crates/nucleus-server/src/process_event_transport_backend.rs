//! Process event transport backend readiness descriptors.
//!
//! These records describe whether supervision event transport is ready for
//! future host spawning. They do not publish events, open sockets, create
//! subscriptions, persist replay logs, or deliver messages to clients.

use nucleus_command_policy::CommandProcessSupervisionEventKind;

use crate::host_authority::EngineHostId;

/// Stable process event transport evidence ref.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProcessEventTransportEvidenceRef(pub String);

/// Host process event transport backend family.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProcessEventTransportBackendKind {
    None,
    InProcess,
    LocalIpc,
    ServerEventBus,
    RemoteStream,
    Custom(String),
}

/// Process event transport readiness descriptor for one execution host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessEventTransportReadiness {
    pub execution_host_id: EngineHostId,
    pub backend_kind: ProcessEventTransportBackendKind,
    pub supported_event_kinds: Vec<CommandProcessSupervisionEventKind>,
    pub delivery_evidence_refs: Vec<ProcessEventTransportEvidenceRef>,
    pub replay_evidence_refs: Vec<ProcessEventTransportEvidenceRef>,
    pub summary: Option<String>,
}

impl ProcessEventTransportReadiness {
    /// Returns true when event transport can carry required spawn events.
    pub fn supports_required_spawn_events(&self) -> bool {
        self.backend_kind != ProcessEventTransportBackendKind::None
            && self
                .supported_event_kinds
                .contains(&CommandProcessSupervisionEventKind::Running)
            && self
                .supported_event_kinds
                .contains(&CommandProcessSupervisionEventKind::Terminal)
            && self
                .supported_event_kinds
                .contains(&CommandProcessSupervisionEventKind::CleanupFailed)
            && !self.delivery_evidence_refs.is_empty()
            && !self.replay_evidence_refs.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> EngineHostId {
        EngineHostId("host:local".to_owned())
    }

    #[test]
    fn event_transport_requires_terminal_and_cleanup_failed_support() {
        let readiness = ProcessEventTransportReadiness {
            execution_host_id: host(),
            backend_kind: ProcessEventTransportBackendKind::InProcess,
            supported_event_kinds: vec![CommandProcessSupervisionEventKind::Running],
            delivery_evidence_refs: vec![ProcessEventTransportEvidenceRef(
                "evidence:delivery".to_owned(),
            )],
            replay_evidence_refs: vec![ProcessEventTransportEvidenceRef(
                "evidence:replay".to_owned(),
            )],
            summary: Some("terminal events missing".to_owned()),
        };

        assert!(!readiness.supports_required_spawn_events());
    }

    #[test]
    fn event_transport_requires_delivery_and_replay_evidence() {
        let readiness = ProcessEventTransportReadiness {
            execution_host_id: host(),
            backend_kind: ProcessEventTransportBackendKind::InProcess,
            supported_event_kinds: vec![
                CommandProcessSupervisionEventKind::Running,
                CommandProcessSupervisionEventKind::Terminal,
                CommandProcessSupervisionEventKind::CleanupFailed,
            ],
            delivery_evidence_refs: Vec::new(),
            replay_evidence_refs: vec![ProcessEventTransportEvidenceRef(
                "evidence:replay".to_owned(),
            )],
            summary: Some("delivery evidence missing".to_owned()),
        };

        assert!(!readiness.supports_required_spawn_events());
    }

    #[test]
    fn event_transport_can_support_required_spawn_events_without_transport() {
        let readiness = ProcessEventTransportReadiness {
            execution_host_id: host(),
            backend_kind: ProcessEventTransportBackendKind::InProcess,
            supported_event_kinds: vec![
                CommandProcessSupervisionEventKind::Running,
                CommandProcessSupervisionEventKind::Terminal,
                CommandProcessSupervisionEventKind::CleanupFailed,
            ],
            delivery_evidence_refs: vec![ProcessEventTransportEvidenceRef(
                "evidence:delivery".to_owned(),
            )],
            replay_evidence_refs: vec![ProcessEventTransportEvidenceRef(
                "evidence:replay".to_owned(),
            )],
            summary: Some("metadata-only readiness".to_owned()),
        };

        assert!(readiness.supports_required_spawn_events());
    }
}
