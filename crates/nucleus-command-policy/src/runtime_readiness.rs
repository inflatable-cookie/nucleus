//! Compile-only command runner and sandbox readiness vocabulary.
//!
//! These records describe pre-execution readiness only. They do not spawn
//! processes, select sandbox backends, construct environments, inject
//! credentials, capture output, retain artifacts, or publish evidence.

use crate::evidence::CommandOutputRetention;
use crate::ids::CommandRequestId;
use crate::policy::{CommandExecutionRequest, CommandSandboxProfile, CommandScope};
use crate::runtime_events::CommandArtifactRef;

/// Readiness surface that must be planned before command execution begins.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandRunnerRuntimeSurface {
    ProcessSpawning,
    PtyAttachment,
    SandboxSelection,
    WorkingDirectoryValidation,
    EnvironmentConstruction,
    CredentialInjection,
    OutputCapture,
    Cancellation,
    Timeout,
    ArtifactRetention,
    SanitizedEvidencePublication,
    Custom(String),
}

/// Pre-execution gate that can block a command runner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandRunnerReadinessGate {
    PolicyAccepted,
    ApprovalResolved,
    SandboxProfileSupported,
    WorkingDirectoryValidated,
    EnvironmentPlanAccepted,
    CredentialReadinessChecked,
    OutputCapturePlanAccepted,
    CancellationPolicyAccepted,
    TimeoutPolicyAccepted,
    ArtifactRetentionPolicyAccepted,
    EvidencePublicationPolicyAccepted,
    Custom(String),
}

/// Overall readiness status for a command execution plan.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandRunnerReadinessStatus {
    Ready,
    Blocked,
    RepairRequired,
    Unsupported,
}

/// Reason a command runner is not ready.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandRunnerReadinessBlocker {
    MissingApproval,
    MissingSandboxPolicy,
    UnsupportedSandboxProfile(CommandSandboxProfile),
    UnsupportedScope(CommandScope),
    MissingWorkingDirectoryValidation,
    MissingEnvironmentPlan,
    MissingCredentialReadiness,
    MissingOutputCapturePlan,
    MissingCancellationPolicy,
    MissingTimeoutPolicy,
    MissingArtifactRetentionPolicy,
    MissingEvidencePublicationPolicy,
    RawOutputRetentionDenied,
    Custom(String),
}

/// Non-secret credential readiness reference used by a command environment.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CommandCredentialReadinessRef(pub String);

/// Planned environment shape for a command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandEnvironmentPlan {
    pub sanitized_environment_keys: Vec<String>,
    pub credential_readiness_refs: Vec<CommandCredentialReadinessRef>,
    pub allows_raw_credential_material: bool,
}

/// Planned output capture posture.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandOutputCapturePlan {
    pub retention: CommandOutputRetention,
    pub stdout_artifact_ref: Option<CommandArtifactRef>,
    pub stderr_artifact_ref: Option<CommandArtifactRef>,
    pub publish_sanitized_summary: bool,
}

/// Cancellation and timeout readiness policy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandInterruptionPlan {
    pub cancellation_supported: bool,
    pub cancellation_is_cooperative: bool,
    pub timeout_required: bool,
    pub timeout_label: Option<String>,
}

/// Pre-execution readiness plan for a command runner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandRunnerReadinessPlan {
    pub command_request_id: CommandRequestId,
    pub command: Option<CommandExecutionRequest>,
    pub status: CommandRunnerReadinessStatus,
    pub surfaces: Vec<CommandRunnerRuntimeSurface>,
    pub satisfied_gates: Vec<CommandRunnerReadinessGate>,
    pub blockers: Vec<CommandRunnerReadinessBlocker>,
    pub environment: Option<CommandEnvironmentPlan>,
    pub output_capture: Option<CommandOutputCapturePlan>,
    pub interruption: Option<CommandInterruptionPlan>,
    pub summary: Option<String>,
}

impl CommandRunnerReadinessPlan {
    /// Returns true only when the plan is explicitly ready and has no blockers.
    pub fn may_execute(&self) -> bool {
        self.status == CommandRunnerReadinessStatus::Ready && self.blockers.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::evidence::CommandOutputRetention;
    use crate::policy::{
        CommandApprovalPolicy, CommandAuthorityArea, CommandRisk, CommandSandboxProfile,
    };

    #[test]
    fn command_runner_readiness_blocks_secret_scope_without_credential_readiness() {
        let command_request_id = CommandRequestId("command:secret".to_owned());
        let command = CommandExecutionRequest {
            id: command_request_id.clone(),
            policy_id: None,
            authority_area: CommandAuthorityArea::Validation,
            scope: CommandScope::SecretAccess,
            risk: CommandRisk::High,
            sandbox: CommandSandboxProfile::ProjectRestricted,
            approval: CommandApprovalPolicy::ApprovalRequiredEveryTime,
            command_display: Some("secret-backed validation".to_owned()),
            working_directory_hint: Some("project root".to_owned()),
        };

        let readiness = CommandRunnerReadinessPlan {
            command_request_id,
            command: Some(command),
            status: CommandRunnerReadinessStatus::Blocked,
            surfaces: vec![
                CommandRunnerRuntimeSurface::CredentialInjection,
                CommandRunnerRuntimeSurface::SandboxSelection,
            ],
            satisfied_gates: vec![CommandRunnerReadinessGate::SandboxProfileSupported],
            blockers: vec![CommandRunnerReadinessBlocker::MissingCredentialReadiness],
            environment: Some(CommandEnvironmentPlan {
                sanitized_environment_keys: vec!["PROVIDER_TOKEN".to_owned()],
                credential_readiness_refs: Vec::new(),
                allows_raw_credential_material: false,
            }),
            output_capture: None,
            interruption: None,
            summary: Some("credential readiness must run before execution".to_owned()),
        };

        assert!(!readiness.may_execute());
        assert!(
            readiness
                .blockers
                .contains(&CommandRunnerReadinessBlocker::MissingCredentialReadiness)
        );
    }

    #[test]
    fn command_runner_readiness_keeps_raw_output_out_of_default_plan() {
        let command_request_id = CommandRequestId("command:inspect".to_owned());
        let readiness = CommandRunnerReadinessPlan {
            command_request_id,
            command: None,
            status: CommandRunnerReadinessStatus::Ready,
            surfaces: vec![
                CommandRunnerRuntimeSurface::OutputCapture,
                CommandRunnerRuntimeSurface::SanitizedEvidencePublication,
            ],
            satisfied_gates: vec![
                CommandRunnerReadinessGate::OutputCapturePlanAccepted,
                CommandRunnerReadinessGate::EvidencePublicationPolicyAccepted,
            ],
            blockers: Vec::new(),
            environment: Some(CommandEnvironmentPlan {
                sanitized_environment_keys: Vec::new(),
                credential_readiness_refs: Vec::new(),
                allows_raw_credential_material: false,
            }),
            output_capture: Some(CommandOutputCapturePlan {
                retention: CommandOutputRetention::SummaryOnly,
                stdout_artifact_ref: None,
                stderr_artifact_ref: None,
                publish_sanitized_summary: true,
            }),
            interruption: Some(CommandInterruptionPlan {
                cancellation_supported: true,
                cancellation_is_cooperative: true,
                timeout_required: true,
                timeout_label: Some("bounded inspection".to_owned()),
            }),
            summary: Some("ready for value-only execution handoff".to_owned()),
        };

        assert!(readiness.may_execute());
        assert_eq!(
            readiness
                .output_capture
                .as_ref()
                .map(|plan| &plan.retention),
            Some(&CommandOutputRetention::SummaryOnly)
        );
    }
}
