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
pub mod invocation;
pub mod policy;
pub mod process_supervision;
pub mod process_supervision_events;
pub mod runtime_effects;
pub mod runtime_events;
pub mod runtime_readiness;
pub mod runtime_states;
pub mod storage_codec;

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
pub use invocation::{CommandEnvironmentPolicy, CommandInvocation};
pub use policy::{
    CommandApprovalPolicy, CommandAuthorityArea, CommandExecutionRequest, CommandRisk,
    CommandSandboxProfile, CommandScope,
};
pub use process_supervision::{
    CommandCancellationPolicy, CommandCleanupFailurePolicy, CommandOutputBoundPolicy,
    CommandProcessInterruptionContract, CommandProcessSupervisionBlocker,
    CommandProcessSupervisionReadiness, CommandProcessSupervisionReadinessStatus,
    CommandProcessSupervisionSurface, CommandSandboxEnforcement, CommandTimeoutPolicy,
    CommandTimeoutStartPolicy,
};
pub use process_supervision_events::{
    CommandProcessSupervisionEventId, CommandProcessSupervisionEventKind,
    CommandProcessSupervisionEventPayload, CommandProcessSupervisionRetryRef,
    CommandProcessSupervisionStatus, CommandProcessTerminalStatus,
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
pub use storage_codec::{
    CommandEvidenceStorageRecord, CommandExecutionRequestStorageRecord, CommandRecordCodecError,
    CommandStorageApprovalPolicy, CommandStorageAuthorityArea, CommandStorageExecutionStatus,
    CommandStorageOutputRetention, CommandStorageRisk, CommandStorageSandboxProfile,
    CommandStorageScope, command_evidence_from_storage_record, command_request_from_storage_record,
    decode_command_evidence_storage_record, decode_command_request_storage_record,
    encode_command_evidence_storage_payload, encode_command_evidence_storage_record,
    encode_command_request_storage_payload, encode_command_request_storage_record,
};
