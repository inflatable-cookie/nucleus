//! Local in-process supervision event transport boundary.
//!
//! This module names a local supervision event channel and produces readiness
//! descriptors for future host spawning. It does not spawn processes, publish
//! events, open sockets, create subscriptions, persist replay logs, or deliver
//! messages to clients.

use nucleus_command_policy::CommandProcessSupervisionEventKind;

use crate::host_authority::EngineHostId;
use crate::local_host_runtime_discovery::{
    LocalHostRuntimeDiscovery, LocalHostRuntimeDiscoveryEvidenceRef,
    LocalHostRuntimeDiscoveryFinding, LocalHostRuntimeDiscoveryStatus,
};
use crate::process_event_transport_backend::{
    ProcessEventTransportBackendKind, ProcessEventTransportEvidenceRef,
    ProcessEventTransportReadiness,
};

mod types;

pub use types::{
    LocalEventTransportBackend, LocalEventTransportChannelId, LocalEventTransportError,
    LocalEventTransportReplayPosture, LocalSupervisionEventChannel,
};

impl LocalEventTransportBackend {
    /// Create a local in-process event transport backend.
    pub fn new(execution_host_id: EngineHostId) -> Self {
        Self {
            execution_host_id: execution_host_id.clone(),
            channel: LocalSupervisionEventChannel {
                id: LocalEventTransportChannelId(format!(
                    "event-transport:{}:supervision",
                    execution_host_id.0
                )),
                supported_event_kinds: required_spawn_event_kinds(),
                bounded_in_process_delivery: true,
                replay_posture: LocalEventTransportReplayPosture::MetadataRefsOnly,
            },
        }
    }

    /// Report process event transport readiness for the local channel.
    pub fn readiness(&self) -> ProcessEventTransportReadiness {
        let evidence_prefix = self.execution_host_id.0.clone();
        let delivery_evidence_refs = if self.channel.bounded_in_process_delivery {
            vec![ProcessEventTransportEvidenceRef(format!(
                "evidence:{evidence_prefix}:event-transport:delivery:in-process"
            ))]
        } else {
            Vec::new()
        };
        let replay_evidence_refs = if self.channel.replay_posture.is_ready() {
            vec![ProcessEventTransportEvidenceRef(format!(
                "evidence:{evidence_prefix}:event-transport:replay:metadata-refs"
            ))]
        } else {
            Vec::new()
        };

        ProcessEventTransportReadiness {
            execution_host_id: self.execution_host_id.clone(),
            backend_kind: ProcessEventTransportBackendKind::InProcess,
            supported_event_kinds: self.channel.supported_event_kinds.clone(),
            delivery_evidence_refs,
            replay_evidence_refs,
            summary: Some(if self.channel.is_ready_for_spawn_events() {
                "local in-process supervision event transport ready".to_owned()
            } else {
                "local in-process supervision event transport incomplete".to_owned()
            }),
        }
    }
}

impl LocalSupervisionEventChannel {
    /// Returns true when the channel covers required spawn event delivery and
    /// replay metadata.
    pub fn is_ready_for_spawn_events(&self) -> bool {
        self.bounded_in_process_delivery
            && self.replay_posture.is_ready()
            && required_spawn_event_kinds()
                .iter()
                .all(|kind| self.supported_event_kinds.contains(kind))
    }
}

impl LocalEventTransportReplayPosture {
    /// Returns true when replay can be represented by server-owned metadata
    /// refs without a full event store in this slice.
    pub fn is_ready(&self) -> bool {
        matches!(self, Self::MetadataRefsOnly)
    }
}

/// Compose concrete local event transport readiness into discovery output.
pub fn with_local_event_transport_readiness(
    mut discovery: LocalHostRuntimeDiscovery,
    readiness: ProcessEventTransportReadiness,
) -> Result<LocalHostRuntimeDiscovery, LocalEventTransportError> {
    if readiness.execution_host_id != discovery.execution_host_id {
        return Err(LocalEventTransportError::HostMismatch {
            expected: discovery.execution_host_id,
            actual: readiness.execution_host_id,
        });
    }

    discovery.event_transport_backend = readiness;
    discovery.findings.retain(|finding| {
        !matches!(
            finding,
            LocalHostRuntimeDiscoveryFinding::EventTransportBackendUnsupported(_)
        )
    });
    discovery
        .evidence_refs
        .push(LocalHostRuntimeDiscoveryEvidenceRef(format!(
            "evidence:{}:local-host-runtime:event-transport:ready",
            discovery.execution_host_id.0
        )));
    discovery.status = if discovery.findings.is_empty() {
        LocalHostRuntimeDiscoveryStatus::Ready
    } else {
        LocalHostRuntimeDiscoveryStatus::Degraded
    };
    discovery.summary =
        Some("local host runtime discovery with event transport readiness".to_owned());

    Ok(discovery)
}

fn required_spawn_event_kinds() -> Vec<CommandProcessSupervisionEventKind> {
    vec![
        CommandProcessSupervisionEventKind::Running,
        CommandProcessSupervisionEventKind::Terminal,
        CommandProcessSupervisionEventKind::CleanupFailed,
    ]
}

#[cfg(test)]
mod tests;
