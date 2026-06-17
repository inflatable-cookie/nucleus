//! Server-owned process supervision event envelopes.
//!
//! These records bind raw-output-free command supervision payloads to project,
//! host, and server ordering refs. They do not implement event transport,
//! process spawning, persistence, or artifact storage.

use std::time::SystemTime;

use nucleus_command_policy::CommandProcessSupervisionEventPayload;
use nucleus_projects::ProjectId;

use crate::host_authority::EngineHostId;
use crate::ids::ServerEventId;
use crate::runtime_effect_events::ServerEventSequence;

/// Server event emitted for process supervision state changes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessSupervisionServerEvent {
    pub id: ServerEventId,
    pub sequence: ServerEventSequence,
    pub occurred_at: Option<SystemTime>,
    pub project_id: ProjectId,
    pub execution_host_id: EngineHostId,
    pub payload: CommandProcessSupervisionEventPayload,
    pub summary: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_command_policy::{
        CommandEvidenceRef, CommandProcessSupervisionEventId, CommandProcessSupervisionEventKind,
        CommandProcessSupervisionEventPayload, CommandProcessSupervisionStatus, CommandRequestId,
    };

    #[test]
    fn process_supervision_server_event_preserves_project_and_host_refs() {
        let event = ProcessSupervisionServerEvent {
            id: ServerEventId("server:event:supervision:1".to_owned()),
            sequence: ServerEventSequence(7),
            occurred_at: None,
            project_id: ProjectId("project:nucleus".to_owned()),
            execution_host_id: EngineHostId("host:local".to_owned()),
            payload: CommandProcessSupervisionEventPayload {
                id: CommandProcessSupervisionEventId("supervision:event:accepted".to_owned()),
                command_request_id: CommandRequestId("command:request:1".to_owned()),
                kind: CommandProcessSupervisionEventKind::Accepted,
                status: CommandProcessSupervisionStatus::Accepted,
                terminal_status: None,
                evidence_ref: Some(CommandEvidenceRef("evidence:accepted".to_owned())),
                policy_decision_ref: None,
                retry_ref: None,
                summary: Some("accepted for supervision".to_owned()),
            },
            summary: Some("supervision accepted".to_owned()),
        };

        assert_eq!(event.project_id, ProjectId("project:nucleus".to_owned()));
        assert_eq!(
            event.execution_host_id,
            EngineHostId("host:local".to_owned())
        );
        assert_eq!(event.sequence, ServerEventSequence(7));
        assert_eq!(
            event.payload.evidence_ref,
            Some(CommandEvidenceRef("evidence:accepted".to_owned()))
        );
    }
}
