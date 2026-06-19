//! Codex live spawn smoke runner.
//!
//! This module adapts the Codex smoke request to the existing bounded local
//! spawn boundary. It does not send provider turns, answer callbacks, retain
//! raw streams, or persist evidence.

use std::path::PathBuf;

use nucleus_command_policy::{
    CommandApprovalPolicy, CommandAuthorityArea, CommandEnvironmentPolicy, CommandExecutionRequest,
    CommandExecutionStatus, CommandInvocation, CommandOutputRetention, CommandPolicyId,
    CommandRequestId, CommandRisk, CommandSandboxProfile, CommandScope,
};
use nucleus_projects::ProjectId;

use crate::host_authority::EngineHostId;
use crate::host_spawn_readiness::HostSpawnReadinessGate;
use crate::local_read_only_spawn::{
    run_local_read_only_spawn, LocalReadOnlySpawnError, LocalReadOnlySpawnInput,
    LocalReadOnlySpawnOutcome, LocalReadOnlySpawnResult,
};
use crate::runtime_effect_events::ServerEventSequence;

use super::live_spawn_smoke_request::CodexAppServerLiveSpawnSmokeRequest;

/// Input needed to execute one bounded Codex live spawn smoke request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerLiveSpawnSmokeRunnerInput {
    pub project_id: ProjectId,
    pub execution_host_id: EngineHostId,
    pub working_directory: PathBuf,
    pub host_gate: HostSpawnReadinessGate,
    pub first_sequence: ServerEventSequence,
    pub request: CodexAppServerLiveSpawnSmokeRequest,
}

/// Result of one smoke runner invocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerLiveSpawnSmokeRunnerResult {
    pub request_id: String,
    pub outcome: CodexAppServerLiveSpawnSmokeOutcome,
    pub spawn: LocalReadOnlySpawnResult,
}

/// Codex-specific smoke outcome vocabulary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerLiveSpawnSmokeOutcome {
    Accepted,
    Blocked,
    Failed,
    TimedOut,
    CleanupRequired,
}

/// Run one bounded Codex live spawn smoke request through local process
/// primitives.
pub fn run_codex_live_spawn_smoke(
    input: CodexAppServerLiveSpawnSmokeRunnerInput,
) -> CodexAppServerLiveSpawnSmokeRunnerResult {
    let request_id = input.request.request_id().0.clone();
    let spawn = run_local_read_only_spawn(LocalReadOnlySpawnInput {
        project_id: input.project_id,
        execution_host_id: input.execution_host_id,
        request: command_request(&input.request),
        invocation: command_invocation(&input.request, input.working_directory),
        host_gate: input.host_gate,
        first_sequence: input.first_sequence,
    });
    let outcome = smoke_outcome(&spawn);

    CodexAppServerLiveSpawnSmokeRunnerResult {
        request_id,
        outcome,
        spawn,
    }
}

fn command_request(request: &CodexAppServerLiveSpawnSmokeRequest) -> CommandExecutionRequest {
    CommandExecutionRequest {
        id: command_request_id(request),
        policy_id: Some(CommandPolicyId(
            "command:policy:codex-live-spawn-smoke".to_owned(),
        )),
        authority_area: CommandAuthorityArea::Validation,
        scope: CommandScope::ReadOnlyInspection,
        risk: CommandRisk::Low,
        sandbox: CommandSandboxProfile::NoFilesystemWrite,
        approval: CommandApprovalPolicy::AutoAllowed,
        command_display: Some(format!(
            "{} {}",
            request.binary_command(),
            request.argv().join(" ")
        )),
        working_directory_hint: None,
    }
}

fn command_invocation(
    request: &CodexAppServerLiveSpawnSmokeRequest,
    working_directory: PathBuf,
) -> CommandInvocation {
    let limits = request.limits();
    CommandInvocation {
        command_request_id: command_request_id(request),
        executable: request.binary_command().to_owned(),
        argv: request.argv().to_vec(),
        working_directory,
        timeout: limits.timeout,
        stdout_limit_bytes: limits.stdout_limit_bytes,
        stderr_limit_bytes: limits.stderr_limit_bytes,
        environment_policy: CommandEnvironmentPolicy::MinimalInheritedSafe,
        sandbox: CommandSandboxProfile::NoFilesystemWrite,
        output_retention: CommandOutputRetention::SummaryOnly,
    }
}

fn command_request_id(request: &CodexAppServerLiveSpawnSmokeRequest) -> CommandRequestId {
    CommandRequestId(format!("command:request:{}", request.request_id().0))
}

fn smoke_outcome(spawn: &LocalReadOnlySpawnResult) -> CodexAppServerLiveSpawnSmokeOutcome {
    match &spawn.outcome {
        LocalReadOnlySpawnOutcome::Blocked => CodexAppServerLiveSpawnSmokeOutcome::Blocked,
        LocalReadOnlySpawnOutcome::SpawnFailed(LocalReadOnlySpawnError::KillFailed(_)) => {
            CodexAppServerLiveSpawnSmokeOutcome::CleanupRequired
        }
        LocalReadOnlySpawnOutcome::SpawnFailed(_) => CodexAppServerLiveSpawnSmokeOutcome::Failed,
        LocalReadOnlySpawnOutcome::Finished => match spawn.evidence.status {
            CommandExecutionStatus::TimedOut => CodexAppServerLiveSpawnSmokeOutcome::TimedOut,
            CommandExecutionStatus::Succeeded => CodexAppServerLiveSpawnSmokeOutcome::Accepted,
            CommandExecutionStatus::BlockedByPolicy => CodexAppServerLiveSpawnSmokeOutcome::Blocked,
            _ => CodexAppServerLiveSpawnSmokeOutcome::Failed,
        },
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::codex_supervision::{
        admit_codex_spawn_intent, codex_live_spawn_smoke_request,
        codex_runtime_instance_from_supervision_request, CodexAppServerBinary,
        CodexAppServerLiveSpawnSmokeCleanupPolicy, CodexAppServerLiveSpawnSmokeLimits,
        CodexAppServerPayloadRetentionPolicy, CodexAppServerRuntimeInstanceState,
        CodexAppServerSchemaEvidenceRef, CodexAppServerSupervisionLimits,
        CodexAppServerSupervisionReadiness, CodexAppServerSupervisionReadinessStatus,
        CodexAppServerSupervisionRequest,
    };
    use crate::host_spawn_readiness::{HostSpawnReadinessBlocker, HostSpawnReadinessStatus};
    use nucleus_agent_protocol::{
        AdapterIdentity, AuthenticationPreflight, ProviderDriverKind, TransportFamily,
        VersionDiscovery,
    };

    fn host() -> EngineHostId {
        EngineHostId("host:local".to_owned())
    }

    fn project() -> ProjectId {
        ProjectId("project:codex-smoke".to_owned())
    }

    fn runtime(binary_command: &str) -> crate::CodexAppServerRuntimeInstanceRecord {
        codex_runtime_instance_from_supervision_request(
            &CodexAppServerSupervisionRequest {
                project_id: project(),
                execution_host_id: host(),
                adapter: AdapterIdentity {
                    adapter_id: "codex-app-server".to_owned(),
                    provider_driver_kind: ProviderDriverKind::Codex,
                    provider_instance_id: "codex:local-default".to_owned(),
                    provider_name: "OpenAI Codex".to_owned(),
                    harness_name: "Codex app-server".to_owned(),
                    transport_family: TransportFamily::StructuredAppServerRuntime,
                    version_discovery: VersionDiscovery::Command("codex --version".to_owned()),
                    authentication_preflight: AuthenticationPreflight::Command(
                        "codex doctor --json".to_owned(),
                    ),
                },
                binary: CodexAppServerBinary {
                    command: binary_command.to_owned(),
                    version_label: Some("codex-cli 0.140.0".to_owned()),
                    available: true,
                },
                schema_evidence: CodexAppServerSchemaEvidenceRef {
                    evidence_ref: "evidence:codex-schema".to_owned(),
                    codex_version: "codex-cli 0.140.0".to_owned(),
                    generated_json_schema: true,
                    generated_ts_bindings: true,
                },
                supervision_limits: CodexAppServerSupervisionLimits {
                    max_sessions: 1,
                    allow_raw_provider_payload_storage: false,
                    allow_live_spawn: true,
                },
            },
            CodexAppServerRuntimeInstanceState::ReadyForSpawn,
        )
    }

    fn smoke_request(binary_command: &str) -> CodexAppServerLiveSpawnSmokeRequest {
        let runtime = runtime(binary_command);
        let admission = admit_codex_spawn_intent(
            &runtime,
            &CodexAppServerSupervisionReadiness {
                request: CodexAppServerSupervisionRequest {
                    project_id: project(),
                    execution_host_id: host(),
                    adapter: runtime.adapter.clone(),
                    binary: runtime.binary.clone(),
                    schema_evidence: CodexAppServerSchemaEvidenceRef {
                        evidence_ref: "evidence:codex-schema".to_owned(),
                        codex_version: "codex-cli 0.140.0".to_owned(),
                        generated_json_schema: true,
                        generated_ts_bindings: true,
                    },
                    supervision_limits: CodexAppServerSupervisionLimits {
                        max_sessions: 1,
                        allow_raw_provider_payload_storage: false,
                        allow_live_spawn: true,
                    },
                },
                status: CodexAppServerSupervisionReadinessStatus::Ready,
                blockers: Vec::new(),
            },
        );

        codex_live_spawn_smoke_request(
            &runtime,
            &admission,
            CodexAppServerLiveSpawnSmokeLimits {
                timeout: Duration::from_secs(2),
                stdout_limit_bytes: 16,
                stderr_limit_bytes: 16,
                cleanup_policy:
                    CodexAppServerLiveSpawnSmokeCleanupPolicy::TerminateAfterStartupProbe,
                payload_retention: CodexAppServerPayloadRetentionPolicy::MetadataOnly,
            },
        )
        .expect("smoke request")
    }

    fn ready_gate() -> HostSpawnReadinessGate {
        HostSpawnReadinessGate {
            project_id: project(),
            execution_host_id: host(),
            status: HostSpawnReadinessStatus::Ready,
            blockers: Vec::new(),
            summary: Some("ready smoke gate".to_owned()),
        }
    }

    fn runner_input(
        request: CodexAppServerLiveSpawnSmokeRequest,
        host_gate: HostSpawnReadinessGate,
    ) -> CodexAppServerLiveSpawnSmokeRunnerInput {
        CodexAppServerLiveSpawnSmokeRunnerInput {
            project_id: project(),
            execution_host_id: host(),
            working_directory: std::env::current_dir().expect("current dir"),
            host_gate,
            first_sequence: ServerEventSequence(900),
            request,
        }
    }

    #[test]
    fn live_spawn_smoke_runner_uses_bounded_local_spawn_primitives() {
        let result =
            run_codex_live_spawn_smoke(runner_input(smoke_request("printf"), ready_gate()));

        assert_eq!(
            result.outcome,
            CodexAppServerLiveSpawnSmokeOutcome::Accepted
        );
        assert_eq!(
            result.spawn.evidence.status,
            CommandExecutionStatus::Succeeded
        );
        assert_eq!(result.spawn.output.stdout_captured_bytes, 10);
        assert!(!result
            .spawn
            .evidence
            .summary
            .as_deref()
            .unwrap_or_default()
            .contains("app-server"));
    }

    #[test]
    fn live_spawn_smoke_runner_reports_blocked_gate_without_process_attempt() {
        let mut gate = ready_gate();
        gate.status = HostSpawnReadinessStatus::Blocked;
        gate.blockers = vec![HostSpawnReadinessBlocker::Custom(
            "process control unavailable".to_owned(),
        )];

        let result = run_codex_live_spawn_smoke(runner_input(smoke_request("printf"), gate));

        assert_eq!(result.outcome, CodexAppServerLiveSpawnSmokeOutcome::Blocked);
        assert_eq!(
            result.spawn.evidence.status,
            CommandExecutionStatus::BlockedByPolicy
        );
        assert!(result.spawn.events.is_empty());
    }

    #[test]
    fn live_spawn_smoke_runner_reports_spawn_failure_safely() {
        let result = run_codex_live_spawn_smoke(runner_input(
            smoke_request("definitely-missing-nucleus-binary"),
            ready_gate(),
        ));

        assert_eq!(result.outcome, CodexAppServerLiveSpawnSmokeOutcome::Failed);
        assert_eq!(result.spawn.evidence.status, CommandExecutionStatus::Failed);
        assert_eq!(result.spawn.output.stdout_captured_bytes, 0);
    }
}
