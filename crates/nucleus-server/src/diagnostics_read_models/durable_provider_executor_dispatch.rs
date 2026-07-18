use serde::{Deserialize, Serialize};

use crate::{
    DurableProviderExecutorDispatchAdmissionRecord, DurableProviderExecutorDispatchAdmissionStatus,
    DurableProviderExecutorDispatchOutcomeLinkageRecord,
    DurableProviderExecutorDispatchOutcomeLinkageStatus,
    DurableProviderExecutorDispatchSelectionRecord, DurableProviderExecutorDispatchSelectionStatus,
};

/// Client-safe diagnostics for durable provider executor dispatch state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DurableProviderExecutorDispatchDiagnosticsDto {
    pub selections: Vec<DurableProviderExecutorDispatchSelectionDiagnosticDto>,
    pub admissions: Vec<DurableProviderExecutorDispatchAdmissionDiagnosticDto>,
    pub linkages: Vec<DurableProviderExecutorDispatchOutcomeLinkageDiagnosticDto>,
    #[ts(as = "u32")]
    pub record_count: usize,
    pub client_can_execute_provider_write: bool,
    pub client_can_mutate_tasks: bool,
    pub provider_material_exposed: bool,
}

/// One dispatch selection visible to diagnostics clients.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DurableProviderExecutorDispatchSelectionDiagnosticDto {
    pub selection_id: String,
    pub command_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub status: String,
    pub blockers: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub latest_status_state: Option<String>,
    pub provider_write_selected: bool,
    pub provider_material_exposed: bool,
    pub task_mutation_permitted: bool,
    pub next_action: String,
}

/// One dispatch admission visible to diagnostics clients.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DurableProviderExecutorDispatchAdmissionDiagnosticDto {
    pub admission_id: String,
    pub selection_id: String,
    pub command_id: String,
    pub dispatch_attempt_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub status: String,
    pub blockers: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub provider_write_executed: bool,
    pub provider_material_exposed: bool,
    pub task_mutation_permitted: bool,
    pub next_action: String,
}

/// One dispatch outcome linkage visible to diagnostics clients.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DurableProviderExecutorDispatchOutcomeLinkageDiagnosticDto {
    pub linkage_id: String,
    pub admission_id: String,
    pub selection_id: String,
    pub command_id: String,
    pub dispatch_attempt_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub live_executor_outcome_id: String,
    pub runtime_receipt_id: String,
    pub status: String,
    pub blockers: Vec<String>,
    pub durable_status_id: String,
    pub durable_status_state: String,
    pub evidence_refs: Vec<String>,
    pub provider_completion_recorded: bool,
    pub provider_material_exposed: bool,
    pub task_mutation_permitted: bool,
    pub next_action: String,
}

pub fn durable_provider_executor_dispatch_diagnostics(
    selections: &[DurableProviderExecutorDispatchSelectionRecord],
    admissions: &[DurableProviderExecutorDispatchAdmissionRecord],
    linkages: &[DurableProviderExecutorDispatchOutcomeLinkageRecord],
) -> DurableProviderExecutorDispatchDiagnosticsDto {
    DurableProviderExecutorDispatchDiagnosticsDto {
        selections: selections
            .iter()
            .map(DurableProviderExecutorDispatchSelectionDiagnosticDto::from)
            .collect(),
        admissions: admissions
            .iter()
            .map(DurableProviderExecutorDispatchAdmissionDiagnosticDto::from)
            .collect(),
        linkages: linkages
            .iter()
            .map(DurableProviderExecutorDispatchOutcomeLinkageDiagnosticDto::from)
            .collect(),
        record_count: selections.len() + admissions.len() + linkages.len(),
        client_can_execute_provider_write: false,
        client_can_mutate_tasks: false,
        provider_material_exposed: false,
    }
}

impl From<&DurableProviderExecutorDispatchSelectionRecord>
    for DurableProviderExecutorDispatchSelectionDiagnosticDto
{
    fn from(record: &DurableProviderExecutorDispatchSelectionRecord) -> Self {
        Self {
            selection_id: record.selection_id.0.clone(),
            command_id: record.command_id.clone(),
            provider_instance_id: record.provider_instance_id.clone(),
            runtime_session_ref: record.runtime_session_ref.clone(),
            write_attempt_id: record.write_attempt_id.clone(),
            idempotency_key: record.idempotency_key.clone(),
            status: selection_status(&record.status),
            blockers: debug_labels(&record.blockers),
            evidence_refs: record.evidence_refs.clone(),
            latest_status_state: record
                .latest_status_state
                .as_ref()
                .map(|state| format!("{state:?}")),
            provider_write_selected: record.provider_write_selected,
            provider_material_exposed: record.raw_provider_material_retained
                || record.raw_callback_material_retained,
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: selection_next_action(&record.status),
        }
    }
}

impl From<&DurableProviderExecutorDispatchAdmissionRecord>
    for DurableProviderExecutorDispatchAdmissionDiagnosticDto
{
    fn from(record: &DurableProviderExecutorDispatchAdmissionRecord) -> Self {
        Self {
            admission_id: record.admission_id.0.clone(),
            selection_id: record.selection_id.clone(),
            command_id: record.command_id.clone(),
            dispatch_attempt_id: record.dispatch_attempt_id.clone(),
            provider_instance_id: record.provider_instance_id.clone(),
            runtime_session_ref: record.runtime_session_ref.clone(),
            write_attempt_id: record.write_attempt_id.clone(),
            idempotency_key: record.idempotency_key.clone(),
            status: admission_status(&record.status),
            blockers: debug_labels(&record.blockers),
            evidence_refs: record.evidence_refs.clone(),
            provider_write_executed: record.provider_write_executed,
            provider_material_exposed: record.raw_provider_material_retained
                || record.raw_callback_material_retained,
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: admission_next_action(&record.status),
        }
    }
}

impl From<&DurableProviderExecutorDispatchOutcomeLinkageRecord>
    for DurableProviderExecutorDispatchOutcomeLinkageDiagnosticDto
{
    fn from(record: &DurableProviderExecutorDispatchOutcomeLinkageRecord) -> Self {
        Self {
            linkage_id: record.linkage_id.0.clone(),
            admission_id: record.admission_id.clone(),
            selection_id: record.selection_id.clone(),
            command_id: record.command_id.clone(),
            dispatch_attempt_id: record.dispatch_attempt_id.clone(),
            provider_instance_id: record.provider_instance_id.clone(),
            runtime_session_ref: record.runtime_session_ref.clone(),
            write_attempt_id: record.write_attempt_id.clone(),
            live_executor_outcome_id: record.live_executor_outcome_id.clone(),
            runtime_receipt_id: record.runtime_receipt_id.clone(),
            status: linkage_status(&record.status),
            blockers: debug_labels(&record.blockers),
            durable_status_id: record.durable_status.status_id.0.clone(),
            durable_status_state: format!("{:?}", record.durable_status.state),
            evidence_refs: record.evidence_refs.clone(),
            provider_completion_recorded: record.provider_completion_recorded,
            provider_material_exposed: record.raw_provider_material_retained
                || record.raw_callback_material_retained,
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: linkage_next_action(&record.status),
        }
    }
}

fn selection_status(status: &DurableProviderExecutorDispatchSelectionStatus) -> String {
    match status {
        DurableProviderExecutorDispatchSelectionStatus::SelectedForDispatchAdmission => "selected",
        DurableProviderExecutorDispatchSelectionStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn admission_status(status: &DurableProviderExecutorDispatchAdmissionStatus) -> String {
    match status {
        DurableProviderExecutorDispatchAdmissionStatus::AcceptedForDispatch => "accepted",
        DurableProviderExecutorDispatchAdmissionStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn linkage_status(status: &DurableProviderExecutorDispatchOutcomeLinkageStatus) -> String {
    match status {
        DurableProviderExecutorDispatchOutcomeLinkageStatus::Linked => "linked",
        DurableProviderExecutorDispatchOutcomeLinkageStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn selection_next_action(status: &DurableProviderExecutorDispatchSelectionStatus) -> String {
    match status {
        DurableProviderExecutorDispatchSelectionStatus::SelectedForDispatchAdmission => {
            "review_dispatch_admission"
        }
        DurableProviderExecutorDispatchSelectionStatus::Blocked => "repair_dispatch_selection",
    }
    .to_owned()
}

fn admission_next_action(status: &DurableProviderExecutorDispatchAdmissionStatus) -> String {
    match status {
        DurableProviderExecutorDispatchAdmissionStatus::AcceptedForDispatch => {
            "wait_for_dispatch_outcome"
        }
        DurableProviderExecutorDispatchAdmissionStatus::Blocked => "repair_dispatch_admission",
    }
    .to_owned()
}

fn linkage_next_action(status: &DurableProviderExecutorDispatchOutcomeLinkageStatus) -> String {
    match status {
        DurableProviderExecutorDispatchOutcomeLinkageStatus::Linked => "inspect_durable_status",
        DurableProviderExecutorDispatchOutcomeLinkageStatus::Blocked => {
            "repair_dispatch_outcome_linkage"
        }
    }
    .to_owned()
}

fn debug_labels<T: std::fmt::Debug>(values: &[T]) -> Vec<String> {
    values.iter().map(|value| format!("{value:?}")).collect()
}
