//! Compile-only runtime effect server event envelope vocabulary.
//!
//! These records describe event identity, ordering, and domain payloads only.
//! They do not implement an event bus, transport, subscriptions, persistence,
//! replay, scheduling, or runtime execution.

use std::time::SystemTime;

use nucleus_command_policy::CommandEffectEventPayload;
use nucleus_scm_forge::AdapterEffectEventPayload;

use crate::host_identity::ServerEventId;

/// Monotonic ordering token assigned by the server.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ServerEventSequence(pub u64);

/// Runtime effect event emitted by the server for client reconciliation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeEffectServerEvent {
    pub id: ServerEventId,
    pub sequence: ServerEventSequence,
    pub occurred_at: Option<SystemTime>,
    pub prior_effect_request_ref: Option<String>,
    pub kind: RuntimeEffectServerEventKind,
    pub summary: Option<String>,
}

/// Runtime effect event payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectServerEventKind {
    Adapter(AdapterEffectEventPayload),
    Command(CommandEffectEventPayload),
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_command_policy::{
        CommandEffectEventKind, CommandEffectEventPayload, CommandEffectNonTerminalState,
        CommandEffectRequestId, CommandRequestId,
    };

    #[test]
    fn runtime_effect_server_event_wraps_command_payload_without_transport() {
        let event = RuntimeEffectServerEvent {
            id: ServerEventId("event:1".to_owned()),
            sequence: ServerEventSequence(1),
            occurred_at: None,
            prior_effect_request_ref: None,
            kind: RuntimeEffectServerEventKind::Command(CommandEffectEventPayload {
                request_id: CommandEffectRequestId("effect:command".to_owned()),
                command_request_id: CommandRequestId("command:1".to_owned()),
                kind: CommandEffectEventKind::Queued,
                state: Some(CommandEffectNonTerminalState::Queued),
                terminal_state: None,
                retry: None,
                evidence_ref: None,
                artifact_refs: Vec::new(),
                policy_decision_ref: None,
                summary: Some("queued for execution".to_owned()),
            }),
            summary: Some("command effect queued".to_owned()),
        };

        assert_eq!(event.sequence, ServerEventSequence(1));
        assert!(matches!(
            event.kind,
            RuntimeEffectServerEventKind::Command(_)
        ));
    }
}
