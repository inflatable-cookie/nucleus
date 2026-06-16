//! Command authority, sandbox, approval, and evidence boundary types.
//!
//! This crate does not spawn processes, open terminals, implement sandboxes,
//! execute shell commands, persist command output, fake command execution, or
//! provide fixture builders.

pub mod artifacts;
pub mod authority;
pub mod effects;
pub mod evidence;
pub mod ids;
pub mod policy;
pub mod runtime_effects;
pub mod runtime_events;
pub mod runtime_readiness;
pub mod runtime_states;

pub use artifacts::{
    CommandArtifactApprovalRequirement, CommandArtifactDescriptor, CommandArtifactPayloadClass,
    CommandArtifactRedactionStatus, CommandArtifactResolutionStatus,
    CommandArtifactRetentionPolicy, CommandArtifactSecretScanStatus,
};
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
pub use runtime_events::{
    CommandArtifactRef, CommandEffectEventKind, CommandEffectEventPayload, CommandEvidenceRef,
    CommandPolicyDecisionRef,
};
pub use runtime_readiness::{
    CommandCredentialReadinessRef, CommandEnvironmentPlan, CommandInterruptionPlan,
    CommandOutputCapturePlan, CommandRunnerReadinessBlocker, CommandRunnerReadinessGate,
    CommandRunnerReadinessPlan, CommandRunnerReadinessStatus, CommandRunnerRuntimeSurface,
};
pub use runtime_states::{
    CommandEffectNonTerminalState, CommandEffectState, CommandEffectStateRecord,
    CommandEffectTerminalState,
};
