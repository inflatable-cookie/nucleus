//! Pure read-only command policy evaluation.
//!
//! This module classifies a structured invocation and returns an execution
//! decision with explicit blockers. It does not spawn processes, inspect the
//! filesystem, or enforce sandboxes; enforcement belongs to the host spawn
//! boundary.

use crate::invocation::CommandInvocation;

/// Decision for a read-only command invocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandPolicyDecision {
    Allowed,
    RequiresApproval(Vec<CommandPolicyBlocker>),
    Denied(Vec<CommandPolicyBlocker>),
}

/// Reason a command invocation cannot run under read-only policy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandPolicyBlocker {
    /// Executable is a shell entrypoint; arbitrary shell text defeats policy.
    ShellPassthrough { executable: String },
    /// Interpreter invoked with an inline-code flag (`python -c`, `node -e`).
    InterpreterInlineCode { executable: String, flag: String },
    /// Interpreter invoked with a script or stdin program; content is opaque.
    InterpreterOpaqueProgram { executable: String },
    /// Executable mutates filesystem or process state by its nature.
    DestructiveExecutable { executable: String },
    /// Executable runs further commands sourced from arguments or traversal
    /// (`xargs`, `find -exec`).
    IndirectExecution { executable: String },
    /// Known in-place mutation flag on an otherwise read-only tool
    /// (`sed -i`).
    MutatingFlag { executable: String, flag: String },
}

impl CommandPolicyDecision {
    /// Returns true when execution may proceed without operator involvement.
    pub fn is_allowed(&self) -> bool {
        matches!(self, CommandPolicyDecision::Allowed)
    }

    /// Blockers carried by this decision, empty when allowed.
    pub fn blockers(&self) -> &[CommandPolicyBlocker] {
        match self {
            CommandPolicyDecision::Allowed => &[],
            CommandPolicyDecision::RequiresApproval(blockers)
            | CommandPolicyDecision::Denied(blockers) => blockers,
        }
    }
}

/// Evaluate a structured invocation against read-only execution policy.
///
/// Environment wrappers (`env`, `nohup`, `nice`, `timeout`, `stdbuf`) are
/// unwrapped so the wrapped command is what gets classified.
pub fn evaluate_read_only_invocation(invocation: &CommandInvocation) -> CommandPolicyDecision {
    let (executable, argv) = unwrap_wrappers(&invocation.executable, &invocation.argv);
    classify(&executable, &argv)
}

fn classify(executable: &str, argv: &[String]) -> CommandPolicyDecision {
    let name = basename(executable);
    let mut deny = Vec::new();
    let mut approval = Vec::new();

    if is_shell(&name) {
        deny.push(CommandPolicyBlocker::ShellPassthrough {
            executable: executable.to_owned(),
        });
    } else if is_interpreter(&name) {
        match inline_code_flag(&name, argv) {
            Some(flag) => deny.push(CommandPolicyBlocker::InterpreterInlineCode {
                executable: executable.to_owned(),
                flag,
            }),
            None => approval.push(CommandPolicyBlocker::InterpreterOpaqueProgram {
                executable: executable.to_owned(),
            }),
        }
    } else if is_destructive(&name) {
        deny.push(CommandPolicyBlocker::DestructiveExecutable {
            executable: executable.to_owned(),
        });
    } else if is_indirect_executor(&name, argv) {
        deny.push(CommandPolicyBlocker::IndirectExecution {
            executable: executable.to_owned(),
        });
    } else if let Some(flag) = mutating_flag(&name, argv) {
        deny.push(CommandPolicyBlocker::MutatingFlag {
            executable: executable.to_owned(),
            flag,
        });
    }

    if !deny.is_empty() {
        CommandPolicyDecision::Denied(deny)
    } else if !approval.is_empty() {
        CommandPolicyDecision::RequiresApproval(approval)
    } else {
        CommandPolicyDecision::Allowed
    }
}

/// Strip leading environment wrappers and return the effective command.
fn unwrap_wrappers(executable: &str, argv: &[String]) -> (String, Vec<String>) {
    let mut executable = executable.to_owned();
    let mut argv = argv.to_vec();

    loop {
        let name = basename(&executable);
        let consumed = match name.as_str() {
            "env" => consume_env(&argv),
            "nohup" | "stdbuf" | "nice" | "timeout" => consume_flagged_wrapper(&name, &argv),
            _ => None,
        };

        match consumed {
            Some(rest) if !rest.is_empty() => {
                executable = rest[0].clone();
                argv = rest[1..].to_vec();
            }
            // Wrapper with nothing to run: classify the wrapper itself.
            _ => return (executable, argv),
        }
    }
}

/// Skip `env` flags and VAR=value assignments; return the wrapped command.
fn consume_env(argv: &[String]) -> Option<Vec<String>> {
    let mut index = 0;
    while index < argv.len() {
        let argument = &argv[index];
        if argument == "--" {
            index += 1;
            break;
        }
        if argument == "-u" || argument == "--unset" {
            index += 2;
            continue;
        }
        if argument.starts_with('-') || argument.contains('=') {
            index += 1;
            continue;
        }
        break;
    }
    Some(argv[index..].to_vec())
}

/// Skip wrapper flags plus any positional the wrapper itself consumes.
fn consume_flagged_wrapper(name: &str, argv: &[String]) -> Option<Vec<String>> {
    let mut index = 0;
    while index < argv.len() && (argv[index].starts_with('-') || argv[index] == "--") {
        let argument = &argv[index];
        if argument == "--" {
            index += 1;
            break;
        }
        // `nice -n 10`, `stdbuf -o L` style value flags.
        if matches!(argument.as_str(), "-n" | "-o" | "-e" | "-i" | "-k" | "-s") {
            index += 2;
            continue;
        }
        index += 1;
    }
    // `timeout` consumes a duration positional before the command.
    if name == "timeout" && index < argv.len() && !argv[index].is_empty() {
        let duration_like = argv[index]
            .chars()
            .all(|character| character.is_ascii_digit() || matches!(character, '.' | 's' | 'm' | 'h' | 'd'));
        if duration_like {
            index += 1;
        }
    }
    Some(argv[index..].to_vec())
}

fn basename(executable: &str) -> String {
    let name = executable
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(executable)
        .to_ascii_lowercase();
    name.strip_suffix(".exe").map(str::to_owned).unwrap_or(name)
}

fn is_shell(name: &str) -> bool {
    matches!(
        name,
        "sh" | "bash"
            | "zsh"
            | "fish"
            | "dash"
            | "ash"
            | "ksh"
            | "csh"
            | "tcsh"
            | "cmd"
            | "powershell"
            | "pwsh"
            | "busybox"
            | "toybox"
    )
}

fn is_interpreter(name: &str) -> bool {
    name.starts_with("python")
        || name.starts_with("ruby")
        || name.starts_with("php")
        || name.starts_with("lua")
        || matches!(
            name,
            "node" | "nodejs" | "deno" | "bun" | "perl" | "osascript" | "rscript" | "julia" | "elixir" | "erl"
        )
}

fn inline_code_flag(name: &str, argv: &[String]) -> Option<String> {
    let inline_flags: &[&str] = if name.starts_with("python") {
        &["-c", "-m"]
    } else if name == "node" || name == "nodejs" || name == "bun" {
        &["-e", "--eval", "-p", "--print"]
    } else if name == "deno" {
        &["eval"]
    } else if name == "perl" {
        &["-e", "-E"]
    } else if name.starts_with("ruby") {
        &["-e"]
    } else if name.starts_with("php") {
        &["-r"]
    } else if name.starts_with("lua") {
        &["-e"]
    } else if name == "osascript" {
        &["-e"]
    } else if name == "rscript" || name == "julia" {
        &["-e"]
    } else if name == "elixir" || name == "erl" {
        &["-e", "-eval"]
    } else {
        &[]
    };

    argv.iter()
        .find(|argument| inline_flags.contains(&argument.as_str()))
        .cloned()
}

fn is_destructive(name: &str) -> bool {
    matches!(
        name,
        "rm" | "rmdir"
            | "unlink"
            | "dd"
            | "shred"
            | "truncate"
            | "mv"
            | "cp"
            | "install"
            | "ln"
            | "chmod"
            | "chown"
            | "chgrp"
            | "chflags"
            | "kill"
            | "killall"
            | "pkill"
            | "launchctl"
            | "diskutil"
            | "mount"
            | "umount"
    ) || name.starts_with("mkfs")
}

fn is_indirect_executor(name: &str, argv: &[String]) -> bool {
    match name {
        "xargs" | "parallel" => true,
        "find" | "fd" => argv.iter().any(|argument| {
            matches!(
                argument.as_str(),
                "-exec" | "-execdir" | "-ok" | "-okdir" | "-delete" | "-x" | "--exec"
            )
        }),
        _ => false,
    }
}

fn mutating_flag(name: &str, argv: &[String]) -> Option<String> {
    match name {
        "sed" | "gsed" => argv
            .iter()
            .find(|argument| *argument == "-i" || argument.starts_with("-i") && argument.len() > 2 || argument.starts_with("--in-place"))
            .cloned(),
        "gawk" | "awk" => argv
            .iter()
            .find(|argument| argument.starts_with("-i"))
            .cloned(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use super::*;
    use crate::evidence::CommandOutputRetention;
    use crate::ids::CommandRequestId;
    use crate::invocation::CommandEnvironmentPolicy;
    use crate::policy::CommandSandboxProfile;

    fn invocation(executable: &str, argv: &[&str]) -> CommandInvocation {
        CommandInvocation {
            command_request_id: CommandRequestId("command:request:evaluate".to_owned()),
            executable: executable.to_owned(),
            argv: argv.iter().map(|argument| argument.to_string()).collect(),
            working_directory: PathBuf::from("."),
            timeout: Duration::from_secs(5),
            stdout_limit_bytes: 16 * 1024,
            stderr_limit_bytes: 16 * 1024,
            environment_policy: CommandEnvironmentPolicy::MinimalInheritedSafe,
            sandbox: CommandSandboxProfile::NoFilesystemWrite,
            output_retention: CommandOutputRetention::SummaryOnly,
        }
    }

    fn decision(executable: &str, argv: &[&str]) -> CommandPolicyDecision {
        evaluate_read_only_invocation(&invocation(executable, argv))
    }

    #[test]
    fn plain_read_only_tools_are_allowed() {
        assert!(decision("rg", &["TODO"]).is_allowed());
        assert!(decision("ls", &["-la"]).is_allowed());
        assert!(decision("git", &["status"]).is_allowed());
        assert!(decision("cat", &["README.md"]).is_allowed());
    }

    #[test]
    fn shells_are_denied_including_uncommon_ones() {
        for shell in ["sh", "/bin/bash", "dash", "ksh", "busybox", "C:\\Windows\\cmd.exe"] {
            let decision = decision(shell, &["-c", "true"]);
            assert!(
                matches!(decision, CommandPolicyDecision::Denied(_)),
                "expected {shell} denied"
            );
        }
    }

    #[test]
    fn interpreter_inline_code_is_denied() {
        for (interpreter, flag) in [
            ("python3", "-c"),
            ("node", "-e"),
            ("perl", "-e"),
            ("ruby", "-e"),
            ("osascript", "-e"),
        ] {
            let decision = decision(interpreter, &[flag, "code"]);
            assert!(
                matches!(decision, CommandPolicyDecision::Denied(_)),
                "expected {interpreter} {flag} denied"
            );
        }
    }

    #[test]
    fn interpreter_script_execution_requires_approval() {
        let decision = decision("python3", &["script.py"]);
        assert!(matches!(decision, CommandPolicyDecision::RequiresApproval(_)));
    }

    #[test]
    fn env_wrapped_shell_is_denied() {
        let decision = decision("env", &["-i", "PATH=/bin", "sh", "-c", "true"]);
        assert!(matches!(
            decision.blockers(),
            [CommandPolicyBlocker::ShellPassthrough { .. }]
        ));
    }

    #[test]
    fn nested_wrappers_are_unwrapped() {
        let decision = decision("nohup", &["nice", "-n", "10", "python3", "-c", "code"]);
        assert!(matches!(
            decision.blockers(),
            [CommandPolicyBlocker::InterpreterInlineCode { .. }]
        ));
    }

    #[test]
    fn timeout_wrapper_duration_is_skipped() {
        let decision = decision("timeout", &["30s", "rm", "-rf", "/tmp/x"]);
        assert!(matches!(
            decision.blockers(),
            [CommandPolicyBlocker::DestructiveExecutable { .. }]
        ));
    }

    #[test]
    fn destructive_executables_are_denied() {
        for tool in ["rm", "dd", "mv", "chmod", "mkfs.ext4", "shred"] {
            let decision = decision(tool, &["target"]);
            assert!(
                matches!(decision, CommandPolicyDecision::Denied(_)),
                "expected {tool} denied"
            );
        }
    }

    #[test]
    fn indirect_execution_is_denied() {
        assert!(matches!(
            decision("xargs", &["rm"]),
            CommandPolicyDecision::Denied(_)
        ));
        assert!(matches!(
            decision("find", &[".", "-name", "*.tmp", "-delete"]),
            CommandPolicyDecision::Denied(_)
        ));
        assert!(decision("find", &[".", "-name", "*.rs"]).is_allowed());
    }

    #[test]
    fn sed_in_place_is_denied_but_plain_sed_allowed() {
        assert!(matches!(
            decision("sed", &["-i", "", "s/a/b/", "file"]),
            CommandPolicyDecision::Denied(_)
        ));
        assert!(decision("sed", &["-n", "1,10p", "file"]).is_allowed());
    }

    #[test]
    fn bare_wrapper_without_command_is_allowed_as_inert() {
        assert!(decision("env", &[]).is_allowed());
    }
}
