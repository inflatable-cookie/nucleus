//! Stable identifier vocabulary for shared memory.

/// Stable server-assigned accepted memory id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct MemoryId(pub String);

/// Stable server-assigned memory proposal id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct MemoryProposalId(pub String);
