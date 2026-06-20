use serde::{Deserialize, Serialize};

use crate::{
    DurableDispatchExecutorHandoffRecord, DurableDispatchExecutorHandoffStatus,
    DurableDispatchInvocationPreflightRecord, DurableDispatchInvocationPreflightStatus,
    DurableDispatchInvocationRequestRecord, DurableDispatchInvocationRequestStatus,
    DurableDispatchOutcomePersistenceRecord, DurableDispatchOutcomePersistenceStatus,
};

/// Client-safe diagnostics for durable dispatch invocation state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableProviderExecutorInvocationDiagnosticsDto {
    pub preflights: Vec<DurableInvocationPreflightDiagnosticDto>,
    pub requests: Vec<DurableInvocationRequestDiagnosticDto>,
    pub handoffs: Vec<DurableExecutorHandoffDiagnosticDto>,
    pub persistences: Vec<DurableOutcomePersistenceDiagnosticDto>,
    pub record_count: usize,
    pub client_can_invoke_executor: bool,
    pub client_can_execute_provider_write: bool,
    pub client_can_mutate_tasks: bool,
    pub provider_material_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableInvocationPreflightDiagnosticDto {
    pub preflight_id: String,
    pub command_id: String,
    pub dispatch_attempt_id: String,
    pub write_attempt_id: String,
    pub status: String,
    pub blockers: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub next_action: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableInvocationRequestDiagnosticDto {
    pub request_id: String,
    pub preflight_id: String,
    pub command_id: String,
    pub dispatch_attempt_id: String,
    pub write_attempt_id: String,
    pub status: String,
    pub blockers: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub next_action: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableExecutorHandoffDiagnosticDto {
    pub handoff_id: String,
    pub request_id: String,
    pub command_id: String,
    pub dispatch_attempt_id: String,
    pub write_attempt_id: String,
    pub status: String,
    pub blockers: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub provider_write_executed: bool,
    pub provider_material_exposed: bool,
    pub task_mutation_permitted: bool,
    pub next_action: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableOutcomePersistenceDiagnosticDto {
    pub persistence_id: String,
    pub handoff_id: String,
    pub command_id: String,
    pub dispatch_attempt_id: String,
    pub write_attempt_id: String,
    pub live_executor_outcome_id: String,
    pub runtime_receipt_id: String,
    pub status: String,
    pub blockers: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub provider_write_executed: bool,
    pub provider_material_exposed: bool,
    pub task_mutation_permitted: bool,
    pub next_action: String,
}

pub fn durable_provider_executor_invocation_diagnostics(
    preflights: &[DurableDispatchInvocationPreflightRecord],
    requests: &[DurableDispatchInvocationRequestRecord],
    handoffs: &[DurableDispatchExecutorHandoffRecord],
    persistences: &[DurableDispatchOutcomePersistenceRecord],
) -> DurableProviderExecutorInvocationDiagnosticsDto {
    DurableProviderExecutorInvocationDiagnosticsDto {
        preflights: preflights
            .iter()
            .map(DurableInvocationPreflightDiagnosticDto::from)
            .collect(),
        requests: requests
            .iter()
            .map(DurableInvocationRequestDiagnosticDto::from)
            .collect(),
        handoffs: handoffs
            .iter()
            .map(DurableExecutorHandoffDiagnosticDto::from)
            .collect(),
        persistences: persistences
            .iter()
            .map(DurableOutcomePersistenceDiagnosticDto::from)
            .collect(),
        record_count: preflights.len() + requests.len() + handoffs.len() + persistences.len(),
        client_can_invoke_executor: false,
        client_can_execute_provider_write: false,
        client_can_mutate_tasks: false,
        provider_material_exposed: false,
    }
}

impl From<&DurableDispatchInvocationPreflightRecord> for DurableInvocationPreflightDiagnosticDto {
    fn from(record: &DurableDispatchInvocationPreflightRecord) -> Self {
        Self {
            preflight_id: record.preflight_id.0.clone(),
            command_id: record.command_id.clone(),
            dispatch_attempt_id: record.dispatch_attempt_id.clone(),
            write_attempt_id: record.write_attempt_id.clone(),
            status: preflight_status(&record.status),
            blockers: debug_labels(&record.blockers),
            evidence_refs: record.evidence_refs.clone(),
            next_action: preflight_next_action(&record.status),
        }
    }
}

impl From<&DurableDispatchInvocationRequestRecord> for DurableInvocationRequestDiagnosticDto {
    fn from(record: &DurableDispatchInvocationRequestRecord) -> Self {
        Self {
            request_id: record.request_id.0.clone(),
            preflight_id: record.preflight_id.clone(),
            command_id: record.command_id.clone(),
            dispatch_attempt_id: record.dispatch_attempt_id.clone(),
            write_attempt_id: record.write_attempt_id.clone(),
            status: request_status(&record.status),
            blockers: debug_labels(&record.blockers),
            evidence_refs: record.evidence_refs.clone(),
            next_action: request_next_action(&record.status),
        }
    }
}

impl From<&DurableDispatchExecutorHandoffRecord> for DurableExecutorHandoffDiagnosticDto {
    fn from(record: &DurableDispatchExecutorHandoffRecord) -> Self {
        Self {
            handoff_id: record.handoff_id.0.clone(),
            request_id: record.request_id.clone(),
            command_id: record.command_id.clone(),
            dispatch_attempt_id: record.dispatch_attempt_id.clone(),
            write_attempt_id: record.write_attempt_id.clone(),
            status: handoff_status(&record.status),
            blockers: debug_labels(&record.blockers),
            evidence_refs: record.evidence_refs.clone(),
            provider_write_executed: record.provider_write_executed,
            provider_material_exposed: record.raw_payload_retained || record.raw_stream_retained,
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: handoff_next_action(&record.status),
        }
    }
}

impl From<&DurableDispatchOutcomePersistenceRecord> for DurableOutcomePersistenceDiagnosticDto {
    fn from(record: &DurableDispatchOutcomePersistenceRecord) -> Self {
        Self {
            persistence_id: record.persistence_id.0.clone(),
            handoff_id: record.handoff_id.clone(),
            command_id: record.command_id.clone(),
            dispatch_attempt_id: record.dispatch_attempt_id.clone(),
            write_attempt_id: record.write_attempt_id.clone(),
            live_executor_outcome_id: record.live_executor_outcome_id.clone(),
            runtime_receipt_id: record.runtime_receipt_id.clone(),
            status: persistence_status(&record.status),
            blockers: debug_labels(&record.blockers),
            evidence_refs: record.evidence_refs.clone(),
            provider_write_executed: record.provider_write_executed,
            provider_material_exposed: record.raw_payload_persisted || record.raw_stream_persisted,
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: persistence_next_action(&record.status),
        }
    }
}

fn preflight_status(status: &DurableDispatchInvocationPreflightStatus) -> String {
    match status {
        DurableDispatchInvocationPreflightStatus::AcceptedForInvocationRequest => "accepted",
        DurableDispatchInvocationPreflightStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn request_status(status: &DurableDispatchInvocationRequestStatus) -> String {
    match status {
        DurableDispatchInvocationRequestStatus::AcceptedForExecutorHandoff => "accepted",
        DurableDispatchInvocationRequestStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn handoff_status(status: &DurableDispatchExecutorHandoffStatus) -> String {
    match status {
        DurableDispatchExecutorHandoffStatus::ReadyForLiveExecutorBoundary => "ready",
        DurableDispatchExecutorHandoffStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn persistence_status(status: &DurableDispatchOutcomePersistenceStatus) -> String {
    match status {
        DurableDispatchOutcomePersistenceStatus::Reconciled => "reconciled",
        DurableDispatchOutcomePersistenceStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn preflight_next_action(status: &DurableDispatchInvocationPreflightStatus) -> String {
    match status {
        DurableDispatchInvocationPreflightStatus::AcceptedForInvocationRequest => {
            "build_invocation_request"
        }
        DurableDispatchInvocationPreflightStatus::Blocked => "repair_invocation_preflight",
    }
    .to_owned()
}

fn request_next_action(status: &DurableDispatchInvocationRequestStatus) -> String {
    match status {
        DurableDispatchInvocationRequestStatus::AcceptedForExecutorHandoff => {
            "build_executor_handoff"
        }
        DurableDispatchInvocationRequestStatus::Blocked => "repair_invocation_request",
    }
    .to_owned()
}

fn handoff_next_action(status: &DurableDispatchExecutorHandoffStatus) -> String {
    match status {
        DurableDispatchExecutorHandoffStatus::ReadyForLiveExecutorBoundary => {
            "wait_for_live_executor_outcome"
        }
        DurableDispatchExecutorHandoffStatus::Blocked => "repair_executor_handoff",
    }
    .to_owned()
}

fn persistence_next_action(status: &DurableDispatchOutcomePersistenceStatus) -> String {
    match status {
        DurableDispatchOutcomePersistenceStatus::Reconciled => "inspect_durable_status",
        DurableDispatchOutcomePersistenceStatus::Blocked => "repair_outcome_persistence",
    }
    .to_owned()
}

fn debug_labels<T: std::fmt::Debug>(values: &[T]) -> Vec<String> {
    values.iter().map(|value| format!("{value:?}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durable_dispatch_invocation_diagnostics_are_read_only_when_empty() {
        let diagnostics = durable_provider_executor_invocation_diagnostics(&[], &[], &[], &[]);

        assert_eq!(diagnostics.record_count, 0);
        assert!(!diagnostics.client_can_invoke_executor);
        assert!(!diagnostics.client_can_execute_provider_write);
        assert!(!diagnostics.client_can_mutate_tasks);
        assert!(!diagnostics.provider_material_exposed);
    }
}
