//! Shared effect-state, admission, and evidence-reference vocabulary.
//!
//! Domain crates (command policy, SCM/forge, native harness) re-export these
//! under their historical names instead of re-declaring near-identical
//! copies. This module names states only; it does not schedule, execute,
//! persist, or retry anything.

/// Sanitized reference to evidence held elsewhere.
///
/// The ref string carries its own provenance prefix by convention
/// (`evidence:...`, `assertion:cli-flag:...`); the type is shared across
/// domains rather than re-declared per crate.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EvidenceRef(pub String);

/// Admission decision for a domain command before any effect runs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdmissionStatus {
    Accepted,
    RequiresApproval,
    Blocked(String),
    Rejected(String),
    Unsupported,
}

/// Effect lifecycle state shared by command and adapter runtimes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EffectState {
    NonTerminal(EffectNonTerminalState),
    Terminal(EffectTerminalState),
}

/// Non-terminal effect state. This is the union across domains; a domain
/// that never enters a state simply never constructs it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EffectNonTerminalState {
    Requested,
    PolicyInspection,
    ApprovalRequired,
    Accepted,
    Queued,
    Running,
    CancellationRequested,
    RecoveryRequired,
}

/// Terminal effect state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EffectTerminalState {
    Rejected,
    BlockedByPolicy,
    Unsupported,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
}

impl EffectState {
    /// Returns whether this state is terminal.
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Terminal(_))
    }
}
