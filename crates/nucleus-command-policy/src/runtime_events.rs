//! Compile-only command runtime effect event payload vocabulary.
//!
//! These records describe sanitized command effect event payloads only. They do
//! not implement transport, subscriptions, persistence, replay, process
//! supervision, artifact retention, or server event fan-out.

use crate::effects::{CommandEffectRequestId, CommandEffectRetry};
use crate::ids::CommandRequestId;
use crate::runtime_states::{CommandEffectNonTerminalState, CommandEffectTerminalState};

/// Symbolic ref to sanitized command evidence (shared core type).
pub use nucleus_core::EvidenceRef as CommandEvidenceRef;

/// Symbolic ref to a retained command artifact.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CommandArtifactRef(pub String);

/// Symbolic ref to command policy or approval state.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CommandPolicyDecisionRef(pub String);

/// Sanitized command effect event payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandEffectEventPayload {
    pub request_id: CommandEffectRequestId,
    pub command_request_id: CommandRequestId,
    pub kind: CommandEffectEventKind,
    pub state: Option<CommandEffectNonTerminalState>,
    pub terminal_state: Option<CommandEffectTerminalState>,
    pub retry: Option<CommandEffectRetry>,
    pub evidence_ref: Option<CommandEvidenceRef>,
    pub artifact_refs: Vec<CommandArtifactRef>,
    pub policy_decision_ref: Option<CommandPolicyDecisionRef>,
    pub summary: Option<String>,
}

/// Command effect event kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandEffectEventKind {
    Requested,
    Accepted,
    Queued,
    Running,
    ApprovalRequired,
    CancellationRequested,
    EvidencePublished,
    RetryScheduled,
    RecoveryRequired,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_effect_event_payload_uses_sanitized_refs_without_raw_output() {
        let payload = CommandEffectEventPayload {
            request_id: CommandEffectRequestId("effect:command".to_owned()),
            command_request_id: CommandRequestId("command:1".to_owned()),
            kind: CommandEffectEventKind::EvidencePublished,
            state: None,
            terminal_state: Some(CommandEffectTerminalState::TimedOut),
            retry: Some(CommandEffectRetry::TimedOut),
            evidence_ref: Some(CommandEvidenceRef("evidence:1".to_owned())),
            artifact_refs: vec![CommandArtifactRef("artifact:stdout".to_owned())],
            policy_decision_ref: Some(CommandPolicyDecisionRef("policy:decision".to_owned())),
            summary: Some("sanitized command evidence published".to_owned()),
        };

        assert_eq!(payload.kind, CommandEffectEventKind::EvidencePublished);
        assert_eq!(
            payload.terminal_state,
            Some(CommandEffectTerminalState::TimedOut)
        );
        assert!(payload.evidence_ref.is_some());
    }
}
