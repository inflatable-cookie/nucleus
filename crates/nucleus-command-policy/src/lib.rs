//! Command authority, sandbox, approval, and evidence boundary types.
//!
//! This crate does not spawn processes, open terminals, implement sandboxes,
//! execute shell commands, persist command output, fake command execution, or
//! provide fixture builders.

pub mod authority;
pub mod effects;
pub mod evidence;
pub mod ids;
pub mod policy;
pub mod runtime_effects;

pub use authority::{CommandAuthorityPolicySurface, CommandAuthorityReadiness};
pub use effects::{
    CommandEffectCancellation, CommandEffectOutcome, CommandEffectOutcomeKind,
    CommandEffectRequest, CommandEffectRequestId, CommandEffectRequestKind, CommandEffectRetry,
};
pub use evidence::{CommandEvidence, CommandExecutionStatus, CommandOutputRetention};
pub use ids::{CommandEvidenceId, CommandPolicyId, CommandRequestId};
pub use policy::{
    CommandApprovalPolicy, CommandAuthorityArea, CommandExecutionRequest, CommandRisk,
    CommandSandboxProfile, CommandScope,
};
pub use runtime_effects::{
    CommandRuntimeEffectAcceptanceSurface, CommandRuntimeEffectOutcomeSurface,
};
