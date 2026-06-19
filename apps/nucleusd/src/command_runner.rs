use std::env;
use std::path::{Path, PathBuf};
use std::time::Duration;

use nucleus_command_policy::{
    CommandApprovalPolicy, CommandAuthorityArea, CommandEnvironmentPolicy, CommandExecutionRequest,
    CommandInvocation, CommandOutputRetention, CommandPolicyId, CommandRequestId, CommandRisk,
    CommandSandboxProfile, CommandScope,
};
use nucleus_core::RevisionId;
use nucleus_local_store::{RevisionExpectation, SqliteBackend};
use nucleus_projects::ProjectId;
use nucleus_server::{
    read_only_spawn_store_error, run_server_read_only_spawn, write_command_evidence, EngineHostId,
    LocalControlRequestHandler, LocalReadOnlyCommandRunner, LocalReadOnlySpawnSmokeInput,
    ReadOnlyCommand, ServerCommand, ServerCommandId, ServerControlRequest, ServerControlRequestId,
    ServerControlRequestKind, ServerControlResponseBody, ServerEventSequence,
};

use crate::cli::{CliReadOnlyCommand, CommandRunnerCommand};
use crate::labels::{command_status_label, retention_label};

mod codex_smoke;

pub(crate) fn print_command_runner(
    handler: &mut LocalControlRequestHandler<SqliteBackend>,
    state_path: &PathBuf,
    command_runner: CommandRunnerCommand,
) -> Result<(), String> {
    match command_runner {
        CommandRunnerCommand::Smoke => print_command_runner_smoke(handler),
        CommandRunnerCommand::ReadOnlySpawnSmoke => {
            print_read_only_spawn_smoke(handler, state_path)
        }
        CommandRunnerCommand::CodexTurnStartRealWriteSmoke(command) => {
            codex_smoke::print_codex_turn_start_real_write_smoke(command)
        }
        CommandRunnerCommand::ReadOnly(command) => print_read_only_command(handler, command),
    }
}

fn print_command_runner_smoke(
    handler: &mut LocalControlRequestHandler<SqliteBackend>,
) -> Result<(), String> {
    let runner = LocalReadOnlyCommandRunner::default();
    let working_directory =
        env::current_dir().map_err(|error| format!("failed to read current dir: {error}"))?;
    let request = CommandExecutionRequest {
        id: CommandRequestId("command:request:nucleusd-smoke".to_owned()),
        policy_id: Some(CommandPolicyId(
            "command:policy:local-readonly-smoke".to_owned(),
        )),
        authority_area: CommandAuthorityArea::Validation,
        scope: CommandScope::ReadOnlyInspection,
        risk: CommandRisk::Low,
        sandbox: CommandSandboxProfile::NoFilesystemWrite,
        approval: CommandApprovalPolicy::AutoAllowed,
        command_display: Some("nucleusd fixed read-only runner smoke".to_owned()),
        working_directory_hint: Some(working_directory.display().to_string()),
    };
    let invocation = CommandInvocation {
        command_request_id: request.id.clone(),
        executable: "nucleusd-smoke".to_owned(),
        argv: Vec::new(),
        working_directory,
        timeout: Duration::from_secs(5),
        stdout_limit_bytes: 16 * 1024,
        stderr_limit_bytes: 16 * 1024,
        environment_policy: CommandEnvironmentPolicy::MinimalInheritedSafe,
        sandbox: CommandSandboxProfile::NoFilesystemWrite,
        output_retention: CommandOutputRetention::SummaryOnly,
    };
    let evidence = runner.evaluate(&request, &invocation);
    write_command_evidence(
        handler.state(),
        &evidence,
        RevisionId("rev:nucleusd-command-runner-smoke:1".to_owned()),
        RevisionExpectation::Any,
    )
    .map_err(|error| format!("failed to persist command evidence: {error:?}"))?;

    println!("command_runner=local_read_only");
    println!("request_id={}", evidence.request_id.0);
    println!("evidence_id={}", evidence.id.0);
    println!("status={}", command_status_label(&evidence.status));
    println!("retention={}", retention_label(&evidence.retention));
    println!("exit_status=none");
    println!("stdout_artifact_ref=none");
    println!("stderr_artifact_ref=none");
    println!("raw_output=not_retained");
    if let Some(summary) = evidence.summary {
        println!("summary={summary}");
    }

    Ok(())
}

fn print_read_only_spawn_smoke(
    handler: &mut LocalControlRequestHandler<SqliteBackend>,
    state_path: &PathBuf,
) -> Result<(), String> {
    let working_directory =
        env::current_dir().map_err(|error| format!("failed to read current dir: {error}"))?;
    let input =
        nucleus_server::build_local_read_only_spawn_smoke_input(LocalReadOnlySpawnSmokeInput {
            project_id: ProjectId("project:nucleus-local".to_owned()),
            execution_host_id: EngineHostId("host:local".to_owned()),
            working_directory,
            artifact_store_root: artifact_store_root(state_path),
            first_sequence: ServerEventSequence(500),
            evidence_revision_id: RevisionId("rev:nucleusd-read-only-spawn-smoke:1".to_owned()),
            evidence_revision: RevisionExpectation::Any,
        })
        .map_err(|error| format!("failed to build read-only spawn smoke input: {error:?}"))?;
    let result =
        run_server_read_only_spawn(handler.state(), input).map_err(read_only_spawn_store_error)?;
    let evidence = result.spawn.evidence;

    println!("command_runner=local_read_only_spawn");
    println!("request_id={}", evidence.request_id.0);
    println!("evidence_id={}", evidence.id.0);
    println!("evidence_record_id={}", result.evidence_record.id.0);
    println!("status={}", command_status_label(&evidence.status));
    println!("retention={}", retention_label(&evidence.retention));
    match evidence.exit_status {
        Some(status) => println!("exit_status={status}"),
        None => println!("exit_status=none"),
    }
    println!("events={}", result.spawn.events.len());
    println!(
        "stdout_captured_bytes={}",
        result.spawn.output.stdout_captured_bytes
    );
    println!("stdout_truncated={}", result.spawn.output.stdout_truncated);
    println!("stdout_artifact_ref=none");
    println!("stderr_artifact_ref=none");
    println!("raw_output=not_retained");
    if let Some(summary) = evidence.summary {
        println!("summary={summary}");
    }

    Ok(())
}

fn artifact_store_root(state_path: &Path) -> PathBuf {
    state_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("artifacts")
}

fn print_read_only_command(
    handler: &mut LocalControlRequestHandler<SqliteBackend>,
    command: CliReadOnlyCommand,
) -> Result<(), String> {
    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:nucleusd:read-only-command".to_owned()),
        client_id: nucleus_server::ClientId("client:nucleusd".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:nucleusd:read-only".to_owned()),
            client_id: nucleus_server::ClientId("client:nucleusd".to_owned()),
            kind: nucleus_server::commands::ServerCommandKind::ReadOnlyCommand(ReadOnlyCommand {
                project_id: ProjectId("project:nucleus-local".to_owned()),
                execution_host_id: EngineHostId("host:local".to_owned()),
                executable: command.executable,
                argv: command.argv,
                working_directory: command.working_directory,
                timeout_ms: command.timeout_ms,
                stdout_limit_bytes: command.stdout_limit_bytes,
                stderr_limit_bytes: command.stderr_limit_bytes,
                command_display: Some("nucleusd structured read-only command".to_owned()),
            }),
        }),
    });

    match response.body {
        ServerControlResponseBody::ReadOnlyCommand(result) => {
            println!("command_runner=local_read_only_control");
            println!("command_id={}", result.command_id.0);
            println!("request_id={}", result.command_request_id.0);
            println!("evidence_id={}", result.evidence_id.0);
            println!("status={}", command_status_label(&result.status));
            println!("retention={}", retention_label(&result.retention));
            match result.exit_status {
                Some(status) => println!("exit_status={status}"),
                None => println!("exit_status=none"),
            }
            println!("events={}", result.events);
            println!("stdout_captured_bytes={}", result.stdout_captured_bytes);
            println!("stderr_captured_bytes={}", result.stderr_captured_bytes);
            println!("stdout_truncated={}", result.stdout_truncated);
            println!("stderr_truncated={}", result.stderr_truncated);
            println!("raw_output=not_retained");
            if let Some(rejection) = result.rejection {
                println!("rejection={rejection:?}");
            }
            if let Some(summary) = result.summary {
                println!("summary={summary}");
            }
            Ok(())
        }
        ServerControlResponseBody::Error(error) => {
            Err(format!("read-only command failed: {error:?}"))
        }
        body => Err(format!(
            "read-only command returned unexpected response: {body:?}"
        )),
    }
}

#[cfg(test)]
mod tests;
