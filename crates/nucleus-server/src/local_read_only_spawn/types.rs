use nucleus_command_policy::{CommandEvidence, CommandExecutionRequest, CommandInvocation};
use nucleus_projects::ProjectId;

use crate::host_authority::EngineHostId;
use crate::host_spawn_readiness::{HostSpawnReadinessBlocker, HostSpawnReadinessGate};
use crate::local_command_runner::LocalReadOnlyCommandRunnerRejection;
use crate::process_supervision_events::ProcessSupervisionServerEvent;
use crate::runtime_effect_events::ServerEventSequence;

/// Inputs for one bounded read-only spawn attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalReadOnlySpawnInput {
    pub project_id: ProjectId,
    pub execution_host_id: EngineHostId,
    pub request: CommandExecutionRequest,
    pub invocation: CommandInvocation,
    pub host_gate: HostSpawnReadinessGate,
    pub first_sequence: ServerEventSequence,
}

/// Result of a read-only spawn boundary call.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalReadOnlySpawnResult {
    pub outcome: LocalReadOnlySpawnOutcome,
    pub evidence: CommandEvidence,
    pub events: Vec<ProcessSupervisionServerEvent>,
    pub output: LocalReadOnlySpawnOutputSummary,
    pub rejection: Option<LocalReadOnlySpawnRejection>,
}

/// High-level spawn outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalReadOnlySpawnOutcome {
    Blocked,
    Finished,
    SpawnFailed(LocalReadOnlySpawnError),
}

/// Rejection before any process spawn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalReadOnlySpawnRejection {
    HostReadinessBlocked(Vec<HostSpawnReadinessBlocker>),
    RunnerRejected(Vec<LocalReadOnlyCommandRunnerRejection>),
}

/// Sanitized output counts only. Raw bytes are intentionally absent.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct LocalReadOnlySpawnOutputSummary {
    pub stdout_captured_bytes: usize,
    pub stderr_captured_bytes: usize,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

/// Failure after readiness allowed an execution attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalReadOnlySpawnError {
    SpawnFailed(String),
    WaitFailed(String),
    KillFailed(String),
    SandboxUnavailable(String),
    OutputPipeUnavailable(String),
    OutputReadFailed(String),
    OutputReaderPanicked,
}

impl LocalReadOnlySpawnResult {
    pub(crate) fn blocked(
        evidence: CommandEvidence,
        rejection: LocalReadOnlySpawnRejection,
    ) -> Self {
        Self {
            outcome: LocalReadOnlySpawnOutcome::Blocked,
            evidence,
            events: Vec::new(),
            output: LocalReadOnlySpawnOutputSummary::default(),
            rejection: Some(rejection),
        }
    }

    pub(crate) fn completed(
        outcome: LocalReadOnlySpawnOutcome,
        evidence: CommandEvidence,
        events: Vec<ProcessSupervisionServerEvent>,
        output: LocalReadOnlySpawnOutputSummary,
    ) -> Self {
        Self {
            outcome,
            evidence,
            events,
            output,
            rejection: None,
        }
    }
}
