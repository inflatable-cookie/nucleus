use serde::{Deserialize, Serialize};

use crate::{
    DurableDispatchExecutorHandoffRecord, DurableDispatchInvocationPreflightRecord,
    DurableDispatchInvocationRequestRecord, DurableDispatchOutcomePersistenceRecord,
    DurableProviderExecutorCommandRecord, DurableProviderExecutorCommandStatus,
    DurableProviderExecutorDispatchAdmissionRecord,
    DurableProviderExecutorDispatchOutcomeLinkageRecord,
    DurableProviderExecutorDispatchSelectionRecord, DurableProviderExecutorState,
    DurableProviderExecutorStatusBlocker, DurableProviderExecutorStatusRecord,
};

use super::durable_provider_executor_dispatch::{
    durable_provider_executor_dispatch_diagnostics, DurableProviderExecutorDispatchDiagnosticsDto,
};
use super::durable_provider_executor_invocation::{
    durable_provider_executor_invocation_diagnostics,
    DurableProviderExecutorInvocationDiagnosticsDto,
};
use super::helpers::{source_status, source_summary};

/// Client-safe diagnostics for durable provider executor command state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DurableProviderExecutorDiagnosticsDto {
    pub commands: Vec<DurableProviderExecutorCommandDiagnosticDto>,
    pub statuses: Vec<DurableProviderExecutorStatusDiagnosticDto>,
    pub dispatch: DurableProviderExecutorDispatchDiagnosticsDto,
    pub invocation: DurableProviderExecutorInvocationDiagnosticsDto,
    pub client_can_execute_provider_write: bool,
    pub client_can_mutate_tasks: bool,
    pub client_can_accept_review: bool,
    pub client_can_answer_callbacks: bool,
    pub client_can_interrupt_provider: bool,
    pub client_can_resume_provider: bool,
    pub client_can_promote_replacement_thread: bool,
    pub client_can_mutate_scm: bool,
    pub provider_material_exposed: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

/// One durable executor command visible to diagnostics clients.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DurableProviderExecutorCommandDiagnosticDto {
    pub command_id: String,
    pub lane: String,
    pub lane_admission_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub method: String,
    pub status: String,
    pub blockers: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub operator_confirmation_ref: Option<String>,
    pub provider_write_executed: bool,
    pub provider_material_exposed: bool,
    pub task_mutation_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub next_action: String,
}

/// One durable executor status visible to diagnostics clients.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DurableProviderExecutorStatusDiagnosticDto {
    pub status_id: String,
    pub command_id: String,
    pub lane_admission_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub state: String,
    pub blockers: Vec<String>,
    pub live_executor_outcome_id: Option<String>,
    pub runtime_receipt_id: Option<String>,
    pub evidence_refs: Vec<String>,
    pub provider_write_recorded: bool,
    pub provider_completion_recorded: bool,
    pub provider_material_exposed: bool,
    pub task_mutation_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub next_action: String,
}

pub fn durable_provider_executor_diagnostics(
    commands: &[DurableProviderExecutorCommandRecord],
    statuses: &[DurableProviderExecutorStatusRecord],
    selections: &[DurableProviderExecutorDispatchSelectionRecord],
    admissions: &[DurableProviderExecutorDispatchAdmissionRecord],
    linkages: &[DurableProviderExecutorDispatchOutcomeLinkageRecord],
    preflights: &[DurableDispatchInvocationPreflightRecord],
    requests: &[DurableDispatchInvocationRequestRecord],
    handoffs: &[DurableDispatchExecutorHandoffRecord],
    persistences: &[DurableDispatchOutcomePersistenceRecord],
) -> DurableProviderExecutorDiagnosticsDto {
    let command_dtos = commands
        .iter()
        .map(DurableProviderExecutorCommandDiagnosticDto::from)
        .collect::<Vec<_>>();
    let status_dtos = statuses
        .iter()
        .map(DurableProviderExecutorStatusDiagnosticDto::from)
        .collect::<Vec<_>>();
    let dispatch = durable_provider_executor_dispatch_diagnostics(selections, admissions, linkages);
    let invocation = durable_provider_executor_invocation_diagnostics(
        preflights,
        requests,
        handoffs,
        persistences,
    );
    let count =
        command_dtos.len() + status_dtos.len() + dispatch.record_count + invocation.record_count;

    DurableProviderExecutorDiagnosticsDto {
        commands: command_dtos,
        statuses: status_dtos,
        dispatch,
        invocation,
        client_can_execute_provider_write: false,
        client_can_mutate_tasks: false,
        client_can_accept_review: false,
        client_can_answer_callbacks: false,
        client_can_interrupt_provider: false,
        client_can_resume_provider: false,
        client_can_promote_replacement_thread: false,
        client_can_mutate_scm: false,
        provider_material_exposed: false,
        source_status: source_status(count),
        source_summary: Some(source_summary(
            count,
            "Durable provider executor diagnostics have no records yet",
            "Durable provider executor diagnostics loaded from sanitized refs",
        )),
    }
}

impl From<&DurableProviderExecutorCommandRecord> for DurableProviderExecutorCommandDiagnosticDto {
    fn from(record: &DurableProviderExecutorCommandRecord) -> Self {
        Self {
            command_id: record.command_id.0.clone(),
            lane: format!("{:?}", record.lane),
            lane_admission_id: record.lane_admission_id.clone(),
            provider_instance_id: record.provider_instance_id.clone(),
            runtime_session_ref: record.runtime_session_ref.clone(),
            write_attempt_id: record.write_attempt_id.clone(),
            idempotency_key: record.idempotency_key.clone(),
            method: format!("{:?}", record.method),
            status: command_status(&record.status),
            blockers: record
                .blockers
                .iter()
                .map(|blocker| format!("{blocker:?}"))
                .collect(),
            evidence_refs: record.evidence_refs.clone(),
            operator_confirmation_ref: record.operator_confirmation_ref.clone(),
            provider_write_executed: record.provider_write_executed,
            provider_material_exposed: record.raw_provider_material_retained
                || record.raw_callback_material_retained,
            task_mutation_permitted: record.task_mutation_permitted,
            review_acceptance_permitted: record.review_acceptance_permitted,
            next_action: command_next_action(&record.status),
        }
    }
}

impl From<&DurableProviderExecutorStatusRecord> for DurableProviderExecutorStatusDiagnosticDto {
    fn from(record: &DurableProviderExecutorStatusRecord) -> Self {
        Self {
            status_id: record.status_id.0.clone(),
            command_id: record.command_id.clone(),
            lane_admission_id: record.lane_admission_id.clone(),
            provider_instance_id: record.provider_instance_id.clone(),
            runtime_session_ref: record.runtime_session_ref.clone(),
            write_attempt_id: record.write_attempt_id.clone(),
            idempotency_key: record.idempotency_key.clone(),
            state: state_label(&record.state),
            blockers: record
                .blockers
                .iter()
                .map(|blocker| format!("{blocker:?}"))
                .collect(),
            live_executor_outcome_id: record.live_executor_outcome_id.clone(),
            runtime_receipt_id: record.runtime_receipt_id.clone(),
            evidence_refs: record.evidence_refs.clone(),
            provider_write_recorded: record.provider_write_recorded,
            provider_completion_recorded: record.provider_completion_recorded,
            provider_material_exposed: record.raw_provider_material_retained
                || record.raw_callback_material_retained,
            task_mutation_permitted: record.task_mutation_permitted,
            review_acceptance_permitted: record.review_acceptance_permitted,
            next_action: status_next_action(&record.state, &record.blockers),
        }
    }
}

fn command_status(status: &DurableProviderExecutorCommandStatus) -> String {
    match status {
        DurableProviderExecutorCommandStatus::AcceptedForPersistence => "accepted",
        DurableProviderExecutorCommandStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn command_next_action(status: &DurableProviderExecutorCommandStatus) -> String {
    match status {
        DurableProviderExecutorCommandStatus::AcceptedForPersistence => {
            "wait_for_durable_executor_status"
        }
        DurableProviderExecutorCommandStatus::Blocked => "repair_durable_executor_command",
    }
    .to_owned()
}

fn state_label(state: &DurableProviderExecutorState) -> String {
    match state {
        DurableProviderExecutorState::Queued => "queued",
        DurableProviderExecutorState::Running => "running",
        DurableProviderExecutorState::Completed => "completed",
        DurableProviderExecutorState::Failed(_) => "failed",
        DurableProviderExecutorState::Blocked(_) => "blocked",
        DurableProviderExecutorState::TimedOut => "timed_out",
        DurableProviderExecutorState::CleanupRequired(_) => "cleanup_required",
        DurableProviderExecutorState::Invalid => "invalid",
    }
    .to_owned()
}

fn status_next_action(
    state: &DurableProviderExecutorState,
    blockers: &[DurableProviderExecutorStatusBlocker],
) -> String {
    if !blockers.is_empty() || matches!(state, DurableProviderExecutorState::Invalid) {
        return "repair_durable_executor_status".to_owned();
    }

    match state {
        DurableProviderExecutorState::Queued => "wait_for_executor_dispatch",
        DurableProviderExecutorState::Running => "watch_executor_progress",
        DurableProviderExecutorState::Completed => "inspect_executor_receipt",
        DurableProviderExecutorState::Failed(_) => "inspect_executor_failure",
        DurableProviderExecutorState::Blocked(_) => "inspect_executor_blocker",
        DurableProviderExecutorState::TimedOut => "inspect_executor_timeout",
        DurableProviderExecutorState::CleanupRequired(_) => "inspect_executor_cleanup_requirement",
        DurableProviderExecutorState::Invalid => "repair_durable_executor_status",
    }
    .to_owned()
}
