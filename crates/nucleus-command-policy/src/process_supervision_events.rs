//! Process supervision event payload vocabulary.
//!
//! These records describe sanitized supervision events only. They do not spawn
//! child processes, open PTYs, capture output, persist artifacts, or publish
//! events to clients.

use crate::ids::CommandRequestId;
use crate::runtime_events::{CommandEvidenceRef, CommandPolicyDecisionRef};

/// Stable process supervision event id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CommandProcessSupervisionEventId(pub String);

/// Symbolic ref to supervisor retry classification.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CommandProcessSupervisionRetryRef(pub String);

/// Sanitized process supervision event payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandProcessSupervisionEventPayload {
    pub id: CommandProcessSupervisionEventId,
    pub command_request_id: CommandRequestId,
    pub kind: CommandProcessSupervisionEventKind,
    pub status: CommandProcessSupervisionStatus,
    pub terminal_status: Option<CommandProcessTerminalStatus>,
    pub evidence_ref: Option<CommandEvidenceRef>,
    pub policy_decision_ref: Option<CommandPolicyDecisionRef>,
    pub retry_ref: Option<CommandProcessSupervisionRetryRef>,
    pub summary: Option<String>,
}

impl CommandProcessSupervisionEventPayload {
    /// Returns true when this payload names a terminal supervision outcome.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.kind,
            CommandProcessSupervisionEventKind::Terminal
                | CommandProcessSupervisionEventKind::CleanupFailed
        )
    }
}

/// Process supervision event kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandProcessSupervisionEventKind {
    Accepted,
    Blocked,
    Queued,
    Running,
    Terminal,
    CleanupFailed,
}

/// Coarse process supervision status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandProcessSupervisionStatus {
    Accepted,
    Blocked,
    Queued,
    Running,
    Terminal,
    CleanupFailed,
}

/// Terminal process supervision outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandProcessTerminalStatus {
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_supervision_event_payload_uses_refs_instead_of_raw_output() {
        let payload = CommandProcessSupervisionEventPayload {
            id: CommandProcessSupervisionEventId("supervision:event:1".to_owned()),
            command_request_id: CommandRequestId("command:request:1".to_owned()),
            kind: CommandProcessSupervisionEventKind::Terminal,
            status: CommandProcessSupervisionStatus::Terminal,
            terminal_status: Some(CommandProcessTerminalStatus::Succeeded),
            evidence_ref: Some(CommandEvidenceRef("evidence:command:1".to_owned())),
            policy_decision_ref: Some(CommandPolicyDecisionRef("policy:decision:1".to_owned())),
            retry_ref: Some(CommandProcessSupervisionRetryRef("retry:none".to_owned())),
            summary: Some("sanitized terminal process status".to_owned()),
        };

        assert!(payload.is_terminal());
        assert_eq!(
            payload.evidence_ref,
            Some(CommandEvidenceRef("evidence:command:1".to_owned()))
        );
        assert_eq!(
            payload.summary,
            Some("sanitized terminal process status".to_owned())
        );
    }

    #[test]
    fn cleanup_failed_is_terminal_without_embedding_streams() {
        let payload = CommandProcessSupervisionEventPayload {
            id: CommandProcessSupervisionEventId("supervision:event:cleanup".to_owned()),
            command_request_id: CommandRequestId("command:request:cleanup".to_owned()),
            kind: CommandProcessSupervisionEventKind::CleanupFailed,
            status: CommandProcessSupervisionStatus::CleanupFailed,
            terminal_status: Some(CommandProcessTerminalStatus::TimedOut),
            evidence_ref: Some(CommandEvidenceRef("evidence:cleanup".to_owned())),
            policy_decision_ref: None,
            retry_ref: None,
            summary: Some("cleanup failed after timeout".to_owned()),
        };

        let rendered = format!("{payload:?}");

        assert!(payload.is_terminal());
        assert!(!rendered.contains("stdout"));
        assert!(!rendered.contains("stderr"));
    }
}
