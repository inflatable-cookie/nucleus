//! Stable identifier vocabulary for memory proposals.

/// Stable server-assigned memory proposal id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct MemoryProposalId(pub String);
