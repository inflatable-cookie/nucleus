//! Local read-only command runner skeleton.
//!
//! This boundary validates command policy and structured invocation metadata,
//! then emits sanitized evidence. It does not spawn processes yet.

use nucleus_command_policy::{
    evaluate_read_only_invocation, CommandApprovalPolicy, CommandAuthorityArea,
    CommandEnvironmentPolicy, CommandEvidence, CommandEvidenceId, CommandExecutionRequest,
    CommandExecutionStatus, CommandInvocation, CommandOutputRetention, CommandPolicyBlocker,
    CommandRisk, CommandSandboxProfile, CommandScope,
};

/// Server-owned local read-only command runner skeleton.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalReadOnlyCommandRunner {
    pub default_retention: CommandOutputRetention,
}

/// Policy or invocation rejection before process execution exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalReadOnlyCommandRunnerRejection {
    UnsupportedAuthorityArea,
    UnsupportedScope,
    UnsupportedRisk,
    UnsupportedApproval,
    UnsupportedSandbox,
    UnsupportedEnvironmentPolicy,
    EmptyExecutable,
    ShellPassthrough,
    InterpreterEscape,
    OpaqueInterpreterProgram,
    DestructiveExecutable,
    IndirectExecution,
    MutatingFlag,
    InvalidArgument,
    InvalidWorkingDirectory,
    MissingTimeout,
    UnboundedOutput,
}

impl Default for LocalReadOnlyCommandRunner {
    fn default() -> Self {
        Self {
            default_retention: CommandOutputRetention::SummaryOnly,
        }
    }
}

impl LocalReadOnlyCommandRunner {
    /// Validate a local read-only command request and return sanitized evidence.
    ///
    /// `Queued` means the request has passed the skeleton gates. It is not proof
    /// that a process ran.
    pub fn evaluate(
        &self,
        request: &CommandExecutionRequest,
        invocation: &CommandInvocation,
    ) -> CommandEvidence {
        let rejections = self.rejections(request, invocation);
        if rejections.is_empty() {
            self.evidence(
                request,
                CommandExecutionStatus::Queued,
                format!(
                    "local read-only command accepted for runner queue: executable={}, argv_count={}",
                    invocation.executable,
                    invocation.argv.len()
                ),
            )
        } else {
            self.evidence(
                request,
                CommandExecutionStatus::BlockedByPolicy,
                format!(
                    "local read-only command blocked before execution: {}",
                    summarize_rejections(&rejections)
                ),
            )
        }
    }

    /// Return all policy and invocation blockers without executing the command.
    pub fn rejections(
        &self,
        request: &CommandExecutionRequest,
        invocation: &CommandInvocation,
    ) -> Vec<LocalReadOnlyCommandRunnerRejection> {
        let mut rejections = Vec::new();

        if !matches!(
            request.authority_area,
            CommandAuthorityArea::Validation
                | CommandAuthorityArea::Steward
                | CommandAuthorityArea::UserTerminal
                | CommandAuthorityArea::Custom(_)
        ) {
            rejections.push(LocalReadOnlyCommandRunnerRejection::UnsupportedAuthorityArea);
        }

        if request.scope != CommandScope::ReadOnlyInspection {
            rejections.push(LocalReadOnlyCommandRunnerRejection::UnsupportedScope);
        }

        if request.risk != CommandRisk::Low {
            rejections.push(LocalReadOnlyCommandRunnerRejection::UnsupportedRisk);
        }

        if request.approval != CommandApprovalPolicy::AutoAllowed {
            rejections.push(LocalReadOnlyCommandRunnerRejection::UnsupportedApproval);
        }

        if !matches!(
            request.sandbox,
            CommandSandboxProfile::NoFilesystemWrite | CommandSandboxProfile::ProjectRestricted
        ) {
            rejections.push(LocalReadOnlyCommandRunnerRejection::UnsupportedSandbox);
        }

        if matches!(
            invocation.environment_policy,
            CommandEnvironmentPolicy::Custom(_)
        ) {
            rejections.push(LocalReadOnlyCommandRunnerRejection::UnsupportedEnvironmentPolicy);
        }

        if invocation.executable.trim().is_empty() {
            rejections.push(LocalReadOnlyCommandRunnerRejection::EmptyExecutable);
        }

        for blocker in evaluate_read_only_invocation(invocation).blockers() {
            rejections.push(match blocker {
                CommandPolicyBlocker::ShellPassthrough { .. } => {
                    LocalReadOnlyCommandRunnerRejection::ShellPassthrough
                }
                CommandPolicyBlocker::InterpreterInlineCode { .. } => {
                    LocalReadOnlyCommandRunnerRejection::InterpreterEscape
                }
                CommandPolicyBlocker::InterpreterOpaqueProgram { .. } => {
                    LocalReadOnlyCommandRunnerRejection::OpaqueInterpreterProgram
                }
                CommandPolicyBlocker::DestructiveExecutable { .. } => {
                    LocalReadOnlyCommandRunnerRejection::DestructiveExecutable
                }
                CommandPolicyBlocker::IndirectExecution { .. } => {
                    LocalReadOnlyCommandRunnerRejection::IndirectExecution
                }
                CommandPolicyBlocker::MutatingFlag { .. } => {
                    LocalReadOnlyCommandRunnerRejection::MutatingFlag
                }
            });
        }

        if !invocation.has_structured_executable() || !invocation.has_structured_argv() {
            rejections.push(LocalReadOnlyCommandRunnerRejection::InvalidArgument);
        }

        if !invocation.working_directory.is_dir() {
            rejections.push(LocalReadOnlyCommandRunnerRejection::InvalidWorkingDirectory);
        }

        if !invocation.has_required_timeout() {
            rejections.push(LocalReadOnlyCommandRunnerRejection::MissingTimeout);
        }

        if !invocation.has_bounded_output() {
            rejections.push(LocalReadOnlyCommandRunnerRejection::UnboundedOutput);
        }

        rejections
    }

    fn evidence(
        &self,
        request: &CommandExecutionRequest,
        status: CommandExecutionStatus,
        summary: String,
    ) -> CommandEvidence {
        CommandEvidence {
            id: CommandEvidenceId(format!("{}:evidence", request.id.0)),
            request_id: request.id.clone(),
            status,
            exit_status: None,
            retention: self.default_retention.clone(),
            summary: Some(summary),
            stdout_artifact_ref: None,
            stderr_artifact_ref: None,
        }
    }
}

fn summarize_rejections(rejections: &[LocalReadOnlyCommandRunnerRejection]) -> String {
    rejections
        .iter()
        .map(rejection_label)
        .collect::<Vec<_>>()
        .join(", ")
}

fn rejection_label(rejection: &LocalReadOnlyCommandRunnerRejection) -> &'static str {
    match rejection {
        LocalReadOnlyCommandRunnerRejection::UnsupportedAuthorityArea => {
            "unsupported authority area"
        }
        LocalReadOnlyCommandRunnerRejection::UnsupportedScope => "unsupported scope",
        LocalReadOnlyCommandRunnerRejection::UnsupportedRisk => "unsupported risk",
        LocalReadOnlyCommandRunnerRejection::UnsupportedApproval => "unsupported approval",
        LocalReadOnlyCommandRunnerRejection::UnsupportedSandbox => "unsupported sandbox",
        LocalReadOnlyCommandRunnerRejection::UnsupportedEnvironmentPolicy => {
            "unsupported environment policy"
        }
        LocalReadOnlyCommandRunnerRejection::EmptyExecutable => "empty executable",
        LocalReadOnlyCommandRunnerRejection::ShellPassthrough => "shell passthrough",
        LocalReadOnlyCommandRunnerRejection::InterpreterEscape => "interpreter inline code",
        LocalReadOnlyCommandRunnerRejection::OpaqueInterpreterProgram => {
            "opaque interpreter program"
        }
        LocalReadOnlyCommandRunnerRejection::DestructiveExecutable => "destructive executable",
        LocalReadOnlyCommandRunnerRejection::IndirectExecution => "indirect execution",
        LocalReadOnlyCommandRunnerRejection::MutatingFlag => "mutating flag",
        LocalReadOnlyCommandRunnerRejection::InvalidArgument => "invalid argument",
        LocalReadOnlyCommandRunnerRejection::InvalidWorkingDirectory => "invalid working directory",
        LocalReadOnlyCommandRunnerRejection::MissingTimeout => "missing timeout",
        LocalReadOnlyCommandRunnerRejection::UnboundedOutput => "unbounded output",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use nucleus_command_policy::{
        CommandEnvironmentPolicy, CommandInvocation, CommandPolicyId, CommandRequestId,
    };

    fn read_only_request() -> CommandExecutionRequest {
        CommandExecutionRequest {
            id: CommandRequestId("command:request:readonly".to_owned()),
            policy_id: Some(CommandPolicyId("command:policy:readonly".to_owned())),
            authority_area: CommandAuthorityArea::Validation,
            scope: CommandScope::ReadOnlyInspection,
            risk: CommandRisk::Low,
            sandbox: CommandSandboxProfile::NoFilesystemWrite,
            approval: CommandApprovalPolicy::AutoAllowed,
            command_display: Some("rg TODO".to_owned()),
            working_directory_hint: None,
        }
    }

    fn invocation() -> CommandInvocation {
        CommandInvocation {
            command_request_id: CommandRequestId("command:request:readonly".to_owned()),
            executable: "rg".to_owned(),
            argv: vec!["TODO".to_owned()],
            working_directory: std::env::current_dir().expect("current dir"),
            timeout: Duration::from_secs(5),
            stdout_limit_bytes: 32 * 1024,
            stderr_limit_bytes: 32 * 1024,
            environment_policy: CommandEnvironmentPolicy::MinimalInheritedSafe,
            sandbox: CommandSandboxProfile::NoFilesystemWrite,
            output_retention: CommandOutputRetention::SummaryOnly,
        }
    }

    #[test]
    fn local_read_only_runner_accepts_contract_subset_without_execution() {
        let runner = LocalReadOnlyCommandRunner::default();
        let evidence = runner.evaluate(&read_only_request(), &invocation());

        assert_eq!(evidence.status, CommandExecutionStatus::Queued);
        assert_eq!(evidence.retention, CommandOutputRetention::SummaryOnly);
        assert_eq!(evidence.exit_status, None);
        assert_eq!(evidence.stdout_artifact_ref, None);
        assert_eq!(evidence.stderr_artifact_ref, None);
        assert!(evidence
            .summary
            .expect("summary")
            .contains("accepted for runner queue"));
    }

    #[test]
    fn local_read_only_runner_blocks_unsupported_scope_before_execution() {
        let runner = LocalReadOnlyCommandRunner::default();
        let mut request = read_only_request();
        request.scope = CommandScope::SourceCodeWrite;

        let evidence = runner.evaluate(&request, &invocation());

        assert_eq!(evidence.status, CommandExecutionStatus::BlockedByPolicy);
        assert!(evidence
            .summary
            .expect("summary")
            .contains("unsupported scope"));
    }

    #[test]
    fn local_read_only_runner_rejects_shell_passthrough() {
        let runner = LocalReadOnlyCommandRunner::default();
        let mut invocation = invocation();
        invocation.executable = "/bin/sh".to_owned();
        invocation.argv = vec!["-c".to_owned(), "rg TODO".to_owned()];

        let rejections = runner.rejections(&read_only_request(), &invocation);

        assert!(rejections.contains(&LocalReadOnlyCommandRunnerRejection::ShellPassthrough));
    }

    #[test]
    fn local_read_only_runner_requires_timeout_and_bounded_output() {
        let runner = LocalReadOnlyCommandRunner::default();
        let mut invocation = invocation();
        invocation.timeout = Duration::ZERO;
        invocation.stdout_limit_bytes = 0;

        let rejections = runner.rejections(&read_only_request(), &invocation);

        assert!(rejections.contains(&LocalReadOnlyCommandRunnerRejection::MissingTimeout));
        assert!(rejections.contains(&LocalReadOnlyCommandRunnerRejection::UnboundedOutput));
    }
}
