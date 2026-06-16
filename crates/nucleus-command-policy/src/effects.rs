//! Type-only command authority runtime effect vocabulary.
//!
//! These records describe command effect requests and outcomes. They do not
//! execute commands, spawn processes, open terminals, stream output, retain
//! artifacts, schedule retries, or implement sandboxes.

use crate::evidence::CommandEvidence;
use crate::ids::CommandRequestId;
use crate::policy::CommandExecutionRequest;

/// Stable command effect request id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CommandEffectRequestId(pub String);

/// Command authority effect request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandEffectRequest {
    pub id: CommandEffectRequestId,
    pub command_request_id: CommandRequestId,
    pub kind: CommandEffectRequestKind,
    pub command: Option<CommandExecutionRequest>,
    pub cancellation: CommandEffectCancellation,
}

/// Command effect request category.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandEffectRequestKind {
    PolicyInspection,
    ApprovalRequest,
    AcceptanceDecision,
    QueueForExecution,
    ProcessPreparation,
    SandboxPreparation,
    ProcessStart,
    OutputCapture,
    CancellationRequest,
    TimeoutHandling,
    ArtifactRetention,
    EvidencePublication,
    Recovery,
    Custom(String),
}

/// Cancellation posture for a command effect request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandEffectCancellation {
    NotRequested,
    Requested,
    CooperativeOnly,
    Unsupported,
}

/// Retry classification for a command effect outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandEffectRetry {
    Retryable,
    NotRetryable,
    BlockedByPolicy,
    MissingApproval,
    MissingCredential,
    TimedOut,
    Cancelled,
    Unsupported,
    Unknown,
}

/// Command authority effect outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandEffectOutcome {
    pub request_id: CommandEffectRequestId,
    pub command_request_id: CommandRequestId,
    pub kind: CommandEffectOutcomeKind,
    pub retry: CommandEffectRetry,
    pub summary: Option<String>,
}

/// Command authority effect outcome payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandEffectOutcomeKind {
    Accepted,
    Rejected,
    Queued,
    Running,
    Succeeded(CommandEvidence),
    Failed(CommandEvidence),
    Cancelled(CommandEvidence),
    TimedOut(CommandEvidence),
    BlockedByPolicy(CommandEvidence),
    ApprovalRequired,
    RecoveryRequired,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::evidence::{CommandExecutionStatus, CommandOutputRetention};
    use crate::ids::{CommandEvidenceId, CommandPolicyId};
    use crate::policy::{
        CommandApprovalPolicy, CommandAuthorityArea, CommandRisk, CommandSandboxProfile,
        CommandScope,
    };

    #[test]
    fn command_effect_request_keeps_effect_id_separate_from_command_request_id() {
        let command_request_id = CommandRequestId("command:inspect-status".to_owned());
        let effect_request_id = CommandEffectRequestId("effect:policy-inspection".to_owned());
        let command = CommandExecutionRequest {
            id: command_request_id.clone(),
            policy_id: Some(CommandPolicyId("policy:read-only".to_owned())),
            authority_area: CommandAuthorityArea::ScmAdapter,
            scope: CommandScope::ReadOnlyInspection,
            risk: CommandRisk::Low,
            sandbox: CommandSandboxProfile::NoFilesystemWrite,
            approval: CommandApprovalPolicy::AutoAllowed,
            command_display: Some("status inspection".to_owned()),
            working_directory_hint: Some("project root".to_owned()),
        };

        let request = CommandEffectRequest {
            id: effect_request_id.clone(),
            command_request_id: command_request_id.clone(),
            kind: CommandEffectRequestKind::PolicyInspection,
            command: Some(command),
            cancellation: CommandEffectCancellation::NotRequested,
        };
        let outcome = CommandEffectOutcome {
            request_id: effect_request_id,
            command_request_id,
            kind: CommandEffectOutcomeKind::Queued,
            retry: CommandEffectRetry::NotRetryable,
            summary: Some("policy inspection accepted".to_owned()),
        };

        assert_ne!(request.id.0, request.command_request_id.0);
        assert_eq!(request.id, outcome.request_id);
        assert_eq!(request.command_request_id, outcome.command_request_id);
        assert_eq!(
            request.cancellation,
            CommandEffectCancellation::NotRequested
        );
        assert_eq!(outcome.retry, CommandEffectRetry::NotRetryable);
        assert!(matches!(outcome.kind, CommandEffectOutcomeKind::Queued));
    }

    #[test]
    fn command_effect_outcomes_carry_sanitized_evidence_and_retry_classification() {
        let command_request_id = CommandRequestId("command:management-write".to_owned());
        let effect_request_id = CommandEffectRequestId("effect:queue-management-write".to_owned());

        let request = CommandEffectRequest {
            id: effect_request_id.clone(),
            command_request_id: command_request_id.clone(),
            kind: CommandEffectRequestKind::QueueForExecution,
            command: None,
            cancellation: CommandEffectCancellation::Requested,
        };
        let blocked_evidence = CommandEvidence {
            id: CommandEvidenceId("evidence:blocked".to_owned()),
            request_id: command_request_id.clone(),
            status: CommandExecutionStatus::BlockedByPolicy,
            exit_status: None,
            retention: CommandOutputRetention::SummaryOnly,
            summary: Some("management-state write requires approval".to_owned()),
            stdout_artifact_ref: None,
            stderr_artifact_ref: None,
        };
        let timed_out_evidence = CommandEvidence {
            id: CommandEvidenceId("evidence:timeout".to_owned()),
            request_id: command_request_id.clone(),
            status: CommandExecutionStatus::TimedOut,
            exit_status: None,
            retention: CommandOutputRetention::ArtifactReference,
            summary: Some("command timed out before producing a final status".to_owned()),
            stdout_artifact_ref: Some("artifact:stdout".to_owned()),
            stderr_artifact_ref: Some("artifact:stderr".to_owned()),
        };

        let blocked = CommandEffectOutcome {
            request_id: effect_request_id.clone(),
            command_request_id: command_request_id.clone(),
            kind: CommandEffectOutcomeKind::BlockedByPolicy(blocked_evidence),
            retry: CommandEffectRetry::BlockedByPolicy,
            summary: None,
        };
        let timed_out = CommandEffectOutcome {
            request_id: effect_request_id,
            command_request_id,
            kind: CommandEffectOutcomeKind::TimedOut(timed_out_evidence),
            retry: CommandEffectRetry::TimedOut,
            summary: None,
        };

        assert_eq!(request.cancellation, CommandEffectCancellation::Requested);
        assert_eq!(blocked.request_id, request.id);
        assert_eq!(blocked.retry, CommandEffectRetry::BlockedByPolicy);
        assert_eq!(timed_out.retry, CommandEffectRetry::TimedOut);
        assert!(matches!(
            blocked.kind,
            CommandEffectOutcomeKind::BlockedByPolicy(_)
        ));
        assert!(matches!(
            timed_out.kind,
            CommandEffectOutcomeKind::TimedOut(_)
        ));
    }
}
