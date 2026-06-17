use nucleus_command_policy::{
    CommandEvidence, CommandEvidenceId, CommandExecutionRequest, CommandExecutionStatus,
    CommandOutputRetention, CommandProcessSupervisionEventId, CommandProcessSupervisionEventKind,
    CommandProcessSupervisionEventPayload, CommandProcessSupervisionStatus,
    CommandProcessTerminalStatus,
};

use super::types::LocalReadOnlySpawnInput;
use crate::ids::ServerEventId;
use crate::local_command_runner::LocalReadOnlyCommandRunnerRejection;
use crate::process_supervision_events::ProcessSupervisionServerEvent;
use crate::runtime_effect_events::ServerEventSequence;

pub(super) fn command_evidence(
    request: &CommandExecutionRequest,
    status: CommandExecutionStatus,
    exit_status: Option<i32>,
    summary: String,
) -> CommandEvidence {
    CommandEvidence {
        id: CommandEvidenceId(format!("{}:spawn:evidence", request.id.0)),
        request_id: request.id.clone(),
        status,
        exit_status,
        retention: CommandOutputRetention::SummaryOnly,
        summary: Some(summary),
        stdout_artifact_ref: None,
        stderr_artifact_ref: None,
    }
}

pub(super) fn supervision_event(
    input: &LocalReadOnlySpawnInput,
    offset: u64,
    kind: CommandProcessSupervisionEventKind,
    status: CommandProcessSupervisionStatus,
    terminal_status: Option<CommandProcessTerminalStatus>,
    summary: Option<String>,
) -> ProcessSupervisionServerEvent {
    ProcessSupervisionServerEvent {
        id: ServerEventId(format!("{}:spawn:event:{offset}", input.request.id.0)),
        sequence: ServerEventSequence(input.first_sequence.0 + offset),
        occurred_at: None,
        project_id: input.project_id.clone(),
        execution_host_id: input.execution_host_id.clone(),
        payload: CommandProcessSupervisionEventPayload {
            id: CommandProcessSupervisionEventId(format!(
                "{}:spawn:supervision:{offset}",
                input.request.id.0
            )),
            command_request_id: input.request.id.clone(),
            kind,
            status,
            terminal_status,
            evidence_ref: None,
            policy_decision_ref: None,
            retry_ref: None,
            summary: summary.clone(),
        },
        summary,
    }
}

pub(super) fn summarize_runner_rejections(
    rejections: &[LocalReadOnlyCommandRunnerRejection],
) -> String {
    rejections
        .iter()
        .map(|rejection| format!("{rejection:?}"))
        .collect::<Vec<_>>()
        .join(", ")
}
