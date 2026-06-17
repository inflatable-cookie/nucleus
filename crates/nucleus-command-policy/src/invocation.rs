//! Structured command invocation records.
//!
//! These records describe a possible local invocation. They do not spawn
//! processes, parse shell strings, validate filesystem paths, construct
//! environments, or enforce sandboxes.

use std::path::PathBuf;
use std::time::Duration;

use crate::evidence::CommandOutputRetention;
use crate::ids::CommandRequestId;
use crate::policy::CommandSandboxProfile;

/// Structured command invocation metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandInvocation {
    pub command_request_id: CommandRequestId,
    pub executable: String,
    pub argv: Vec<String>,
    pub working_directory: PathBuf,
    pub timeout: Duration,
    pub stdout_limit_bytes: usize,
    pub stderr_limit_bytes: usize,
    pub environment_policy: CommandEnvironmentPolicy,
    pub sandbox: CommandSandboxProfile,
    pub output_retention: CommandOutputRetention,
}

/// Environment construction policy for a command invocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandEnvironmentPolicy {
    MinimalInheritedSafe,
    Empty,
    AllowlistedKeys(Vec<String>),
    Custom(String),
}

impl CommandInvocation {
    /// Returns true when invocation output has explicit byte bounds.
    pub fn has_bounded_output(&self) -> bool {
        self.stdout_limit_bytes > 0 && self.stderr_limit_bytes > 0
    }

    /// Returns true when the invocation has a finite non-zero timeout.
    pub fn has_required_timeout(&self) -> bool {
        !self.timeout.is_zero()
    }

    /// Returns true when the executable is a structured token, not shell text.
    pub fn has_structured_executable(&self) -> bool {
        let executable = self.executable.trim();
        !executable.is_empty()
            && !executable.contains('\0')
            && !executable.chars().any(char::is_whitespace)
    }

    /// Returns true when argv contains no NUL bytes.
    pub fn has_structured_argv(&self) -> bool {
        self.argv.iter().all(|argument| !argument.contains('\0'))
    }

    /// Returns true when the executable is a known shell entrypoint.
    pub fn is_shell_passthrough(&self) -> bool {
        let name = self
            .executable
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(&self.executable)
            .to_ascii_lowercase();

        matches!(
            name.as_str(),
            "sh" | "bash" | "zsh" | "fish" | "cmd" | "cmd.exe" | "powershell" | "pwsh"
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invocation() -> CommandInvocation {
        CommandInvocation {
            command_request_id: CommandRequestId("command:request:invoke".to_owned()),
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
    fn invocation_records_keep_executable_and_argv_structured() {
        let invocation = invocation();

        assert!(invocation.has_structured_executable());
        assert!(invocation.has_structured_argv());
        assert!(invocation.has_required_timeout());
        assert!(invocation.has_bounded_output());
        assert!(!invocation.is_shell_passthrough());
    }

    #[test]
    fn invocation_records_reject_shell_like_executables() {
        let mut invocation = invocation();
        invocation.executable = "/bin/sh".to_owned();

        assert!(invocation.is_shell_passthrough());
    }
}
