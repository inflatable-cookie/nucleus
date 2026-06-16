//! Command policy identity types.

/// Stable command policy id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CommandPolicyId(pub String);

/// Stable command execution request id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CommandRequestId(pub String);

/// Stable sanitized command evidence id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CommandEvidenceId(pub String);
