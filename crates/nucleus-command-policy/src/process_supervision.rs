//! Local process supervision readiness vocabulary.
//!
//! These records describe whether a command invocation is ready for a future
//! local child-process supervisor. They do not spawn processes, open PTYs,
//! enforce sandboxes, capture output, or publish events.

use crate::ids::CommandRequestId;
use crate::invocation::CommandInvocation;

/// Process supervision readiness status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandProcessSupervisionReadinessStatus {
    Ready,
    Blocked,
    RepairRequired,
    Unsupported,
}

/// Process supervision surface that must be explicit before host spawn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandProcessSupervisionSurface {
    StructuredInvocation,
    WorkingDirectoryValidation,
    EnvironmentConstruction,
    SandboxEnforcement,
    Timeout,
    Cancellation,
    OutputBounding,
    OutputCapture,
    EvidencePublication,
    Cleanup,
    Custom(String),
}

/// Blocker for local process supervision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandProcessSupervisionBlocker {
    MissingStructuredInvocation,
    ShellPassthrough,
    MissingWorkingDirectoryValidation,
    MissingEnvironmentPolicy,
    MissingSandboxPolicy,
    SandboxNotEnforced,
    MissingTimeout,
    MissingCancellationPolicy,
    MissingOutputBounds,
    MissingOutputCapturePolicy,
    MissingEvidencePublicationPolicy,
    UnsupportedInteractiveStdin,
    UnsupportedPty,
    UnsupportedBackgroundProcess,
    Custom(String),
}

/// Timeout policy for supervised local processes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandTimeoutPolicy {
    RequiredFinite,
    Unsupported,
    Custom(String),
}

/// Cancellation policy for supervised local processes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandCancellationPolicy {
    Cooperative,
    KillTree,
    Unsupported,
    Custom(String),
}

/// Point where timeout measurement starts for a supervised process.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandTimeoutStartPolicy {
    BeforeSpawnAttempt,
    AfterSpawnSuccess,
    Unsupported,
    Custom(String),
}

/// How cleanup failures must be surfaced.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandCleanupFailurePolicy {
    EmitCleanupFailedEvent,
    Unsupported,
    Custom(String),
}

/// Output bound policy for supervised local processes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandOutputBoundPolicy {
    Truncate,
    Terminate,
    StopCapture,
    Unsupported,
    Custom(String),
}

/// Sandbox enforcement posture for supervised local processes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandSandboxEnforcement {
    Enforced,
    AdvisoryOnly,
    Unsupported,
    Custom(String),
}

/// Readiness plan for a future local process supervisor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandProcessSupervisionReadiness {
    pub command_request_id: CommandRequestId,
    pub invocation: Option<CommandInvocation>,
    pub status: CommandProcessSupervisionReadinessStatus,
    pub surfaces: Vec<CommandProcessSupervisionSurface>,
    pub blockers: Vec<CommandProcessSupervisionBlocker>,
    pub timeout_policy: Option<CommandTimeoutPolicy>,
    pub cancellation_policy: Option<CommandCancellationPolicy>,
    pub output_bound_policy: Option<CommandOutputBoundPolicy>,
    pub sandbox_enforcement: Option<CommandSandboxEnforcement>,
    pub summary: Option<String>,
}

/// Timeout, cancellation, cleanup, and retry contract for future process spawn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandProcessInterruptionContract {
    pub timeout_policy: CommandTimeoutPolicy,
    pub timeout_start_policy: CommandTimeoutStartPolicy,
    pub cancellation_policy: CommandCancellationPolicy,
    pub cleanup_failure_policy: CommandCleanupFailurePolicy,
    pub finite_timeout_required: bool,
    pub terminal_event_required: bool,
    pub retry_classification_policy_aware: bool,
    pub summary: Option<String>,
}

impl CommandProcessSupervisionReadiness {
    /// Returns true when the plan is ready and no blockers remain.
    pub fn may_spawn(&self) -> bool {
        self.status == CommandProcessSupervisionReadinessStatus::Ready && self.blockers.is_empty()
    }
}

impl CommandProcessInterruptionContract {
    /// Returns true when timeout and cancellation rules are ready for spawn.
    pub fn is_ready_for_spawn_contract(&self) -> bool {
        self.timeout_policy == CommandTimeoutPolicy::RequiredFinite
            && matches!(
                self.timeout_start_policy,
                CommandTimeoutStartPolicy::BeforeSpawnAttempt
                    | CommandTimeoutStartPolicy::AfterSpawnSuccess
            )
            && !matches!(
                self.cancellation_policy,
                CommandCancellationPolicy::Unsupported
            )
            && self.cleanup_failure_policy == CommandCleanupFailurePolicy::EmitCleanupFailedEvent
            && self.finite_timeout_required
            && self.terminal_event_required
            && self.retry_classification_policy_aware
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use super::*;
    use crate::{
        CommandEnvironmentPolicy, CommandOutputRetention, CommandRequestId, CommandSandboxProfile,
    };

    fn invocation() -> CommandInvocation {
        CommandInvocation {
            command_request_id: CommandRequestId("command:request:supervise".to_owned()),
            executable: "rg".to_owned(),
            argv: vec!["TODO".to_owned()],
            working_directory: PathBuf::from("."),
            timeout: Duration::from_secs(5),
            stdout_limit_bytes: 16 * 1024,
            stderr_limit_bytes: 16 * 1024,
            environment_policy: CommandEnvironmentPolicy::MinimalInheritedSafe,
            sandbox: CommandSandboxProfile::NoFilesystemWrite,
            output_retention: CommandOutputRetention::SummaryOnly,
        }
    }

    #[test]
    fn process_supervision_readiness_requires_no_blockers_before_spawn() {
        let readiness = CommandProcessSupervisionReadiness {
            command_request_id: CommandRequestId("command:request:blocked".to_owned()),
            invocation: Some(invocation()),
            status: CommandProcessSupervisionReadinessStatus::Blocked,
            surfaces: vec![CommandProcessSupervisionSurface::SandboxEnforcement],
            blockers: vec![CommandProcessSupervisionBlocker::SandboxNotEnforced],
            timeout_policy: Some(CommandTimeoutPolicy::RequiredFinite),
            cancellation_policy: Some(CommandCancellationPolicy::Cooperative),
            output_bound_policy: Some(CommandOutputBoundPolicy::Truncate),
            sandbox_enforcement: Some(CommandSandboxEnforcement::AdvisoryOnly),
            summary: Some("sandbox label is not enforcement".to_owned()),
        };

        assert!(!readiness.may_spawn());
        assert!(
            readiness
                .blockers
                .contains(&CommandProcessSupervisionBlocker::SandboxNotEnforced)
        );
    }

    #[test]
    fn process_supervision_readiness_can_name_ready_spawn_without_spawning() {
        let readiness = CommandProcessSupervisionReadiness {
            command_request_id: CommandRequestId("command:request:ready".to_owned()),
            invocation: Some(invocation()),
            status: CommandProcessSupervisionReadinessStatus::Ready,
            surfaces: vec![
                CommandProcessSupervisionSurface::StructuredInvocation,
                CommandProcessSupervisionSurface::Timeout,
                CommandProcessSupervisionSurface::Cancellation,
                CommandProcessSupervisionSurface::OutputBounding,
            ],
            blockers: Vec::new(),
            timeout_policy: Some(CommandTimeoutPolicy::RequiredFinite),
            cancellation_policy: Some(CommandCancellationPolicy::Cooperative),
            output_bound_policy: Some(CommandOutputBoundPolicy::Truncate),
            sandbox_enforcement: Some(CommandSandboxEnforcement::Enforced),
            summary: Some("ready for future supervisor handoff".to_owned()),
        };

        assert!(readiness.may_spawn());
    }

    #[test]
    fn interruption_contract_requires_timeout_cleanup_and_retry_rules() {
        let incomplete = CommandProcessInterruptionContract {
            timeout_policy: CommandTimeoutPolicy::RequiredFinite,
            timeout_start_policy: CommandTimeoutStartPolicy::Unsupported,
            cancellation_policy: CommandCancellationPolicy::Cooperative,
            cleanup_failure_policy: CommandCleanupFailurePolicy::EmitCleanupFailedEvent,
            finite_timeout_required: true,
            terminal_event_required: true,
            retry_classification_policy_aware: true,
            summary: Some("timeout start is not defined".to_owned()),
        };
        let ready = CommandProcessInterruptionContract {
            timeout_policy: CommandTimeoutPolicy::RequiredFinite,
            timeout_start_policy: CommandTimeoutStartPolicy::BeforeSpawnAttempt,
            cancellation_policy: CommandCancellationPolicy::Cooperative,
            cleanup_failure_policy: CommandCleanupFailurePolicy::EmitCleanupFailedEvent,
            finite_timeout_required: true,
            terminal_event_required: true,
            retry_classification_policy_aware: true,
            summary: Some("ready interruption contract".to_owned()),
        };

        assert!(!incomplete.is_ready_for_spawn_contract());
        assert!(ready.is_ready_for_spawn_contract());
    }
}
