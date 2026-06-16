//! Compile-only command runtime effect state vocabulary.
//!
//! These records describe command effect state names and final retry
//! classification only. They do not execute commands, schedule retries,
//! supervise processes, persist state, retain artifacts, or emit server events.

use crate::effects::{CommandEffectRequestId, CommandEffectRetry};
use crate::ids::CommandRequestId;

/// Provider-neutral command effect state record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandEffectStateRecord {
    pub request_id: CommandEffectRequestId,
    pub command_request_id: CommandRequestId,
    pub state: CommandEffectState,
    pub retry: Option<CommandEffectRetry>,
    pub summary: Option<String>,
}

/// Command effect state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandEffectState {
    NonTerminal(CommandEffectNonTerminalState),
    Terminal(CommandEffectTerminalState),
}

/// Non-terminal command effect state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandEffectNonTerminalState {
    Requested,
    PolicyInspection,
    ApprovalRequired,
    Accepted,
    Queued,
    Running,
    CancellationRequested,
    RecoveryRequired,
}

/// Terminal command effect state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandEffectTerminalState {
    Rejected,
    BlockedByPolicy,
    Unsupported,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
}

impl CommandEffectState {
    /// Returns whether this state is terminal.
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Terminal(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_effect_state_keeps_approval_and_cancellation_non_terminal() {
        let command_request_id = CommandRequestId("command:approval".to_owned());
        let approval = CommandEffectStateRecord {
            request_id: CommandEffectRequestId("effect:approval".to_owned()),
            command_request_id: command_request_id.clone(),
            state: CommandEffectState::NonTerminal(CommandEffectNonTerminalState::ApprovalRequired),
            retry: None,
            summary: Some("approval needed before execution".to_owned()),
        };
        let cancellation = CommandEffectStateRecord {
            request_id: CommandEffectRequestId("effect:cancel".to_owned()),
            command_request_id,
            state: CommandEffectState::NonTerminal(
                CommandEffectNonTerminalState::CancellationRequested,
            ),
            retry: None,
            summary: Some("cancellation requested, outcome pending".to_owned()),
        };

        assert!(!approval.state.is_terminal());
        assert!(!cancellation.state.is_terminal());
    }

    #[test]
    fn command_effect_state_keeps_terminal_retry_classification_value_only() {
        let timed_out = CommandEffectStateRecord {
            request_id: CommandEffectRequestId("effect:timeout".to_owned()),
            command_request_id: CommandRequestId("command:timeout".to_owned()),
            state: CommandEffectState::Terminal(CommandEffectTerminalState::TimedOut),
            retry: Some(CommandEffectRetry::TimedOut),
            summary: None,
        };

        assert!(timed_out.state.is_terminal());
        assert_eq!(timed_out.retry, Some(CommandEffectRetry::TimedOut));
    }
}
