//! Stopped process-spawn requests for Convergence local snap commands.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceLocalSnapExecutionPreflightRecord, ConvergenceLocalSnapExecutionPreflightSet,
    ConvergenceLocalSnapExecutionPreflightStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergenceLocalSnapSpawnRequestInput {
    pub preflight: ConvergenceLocalSnapExecutionPreflightSet,
    pub existing_spawn_request_ids: Vec<String>,
    pub raw_material_present: bool,
    pub command_effect_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapSpawnRequestSet {
    pub request_set_id: String,
    pub records: Vec<ConvergenceLocalSnapSpawnRequestRecord>,
    pub ready_spawn_request_ids: Vec<String>,
    pub blocked_spawn_request_ids: Vec<String>,
    pub duplicate_spawn_request_ids: Vec<String>,
    pub unsupported_spawn_request_ids: Vec<String>,
    pub command_spawn_permitted: bool,
    pub local_snap_creation_permitted: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapSpawnRequestRecord {
    pub spawn_request_id: String,
    pub preflight_record_id: String,
    pub replay_record_id: String,
    pub adapter_record_id: String,
    pub persisted_evidence_id: String,
    pub evidence_id: String,
    pub proof_id: String,
    pub persisted_request_id: String,
    pub stopped_request_id: String,
    pub idempotency_key: String,
    pub descriptor_id: String,
    pub admission_id: String,
    pub source_replay_record_id: String,
    pub task_ids: Vec<String>,
    pub repo_ids: Vec<String>,
    pub source_authority_ref: String,
    pub execution_authority_ref: String,
    pub inspected_ref_count: usize,
    pub status: ConvergenceLocalSnapSpawnRequestStatus,
    pub blockers: Vec<ConvergenceLocalSnapSpawnRequestBlocker>,
    pub duplicate_spawn_request_detected: bool,
    pub command_spawn_permitted: bool,
    pub local_snap_creation_permitted: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapSpawnRequestStatus {
    Ready,
    Blocked,
    DuplicateNoop,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapSpawnRequestBlocker {
    PreflightNotReady,
    DuplicatePreflight,
    DuplicateSpawnRequest,
    CommandEffectRequested,
    RawMaterialPresent,
}

pub fn convergence_local_snap_spawn_request(
    input: ConvergenceLocalSnapSpawnRequestInput,
) -> ConvergenceLocalSnapSpawnRequestSet {
    let existing_spawn_request_ids = input.existing_spawn_request_ids;
    let mut records = input
        .preflight
        .records
        .into_iter()
        .map(|record| {
            spawn_request_record(
                record,
                &existing_spawn_request_ids,
                input.raw_material_present,
                input.command_effect_requested,
            )
        })
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.spawn_request_id.cmp(&right.spawn_request_id));

    ConvergenceLocalSnapSpawnRequestSet {
        request_set_id: "convergence-local-snap-spawn-request".to_owned(),
        ready_spawn_request_ids: records
            .iter()
            .filter(|record| record.status == ConvergenceLocalSnapSpawnRequestStatus::Ready)
            .map(|record| record.spawn_request_id.clone())
            .collect(),
        blocked_spawn_request_ids: records
            .iter()
            .filter(|record| record.status == ConvergenceLocalSnapSpawnRequestStatus::Blocked)
            .map(|record| record.spawn_request_id.clone())
            .collect(),
        duplicate_spawn_request_ids: records
            .iter()
            .filter(|record| record.status == ConvergenceLocalSnapSpawnRequestStatus::DuplicateNoop)
            .map(|record| record.spawn_request_id.clone())
            .collect(),
        unsupported_spawn_request_ids: records
            .iter()
            .filter(|record| record.status == ConvergenceLocalSnapSpawnRequestStatus::Unsupported)
            .map(|record| record.spawn_request_id.clone())
            .collect(),
        records,
        command_spawn_permitted: false,
        local_snap_creation_permitted: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}

fn spawn_request_record(
    preflight: ConvergenceLocalSnapExecutionPreflightRecord,
    existing_spawn_request_ids: &[String],
    raw_material_present: bool,
    command_effect_requested: bool,
) -> ConvergenceLocalSnapSpawnRequestRecord {
    let spawn_request_id = format!(
        "convergence-local-snap-spawn-request:{}",
        preflight.preflight_record_id
    );
    let duplicate_spawn_request_detected = existing_spawn_request_ids.contains(&spawn_request_id);
    let blockers = blockers(
        &preflight,
        duplicate_spawn_request_detected,
        raw_material_present,
        command_effect_requested,
    );
    let status = status(&preflight, duplicate_spawn_request_detected, &blockers);

    ConvergenceLocalSnapSpawnRequestRecord {
        spawn_request_id,
        preflight_record_id: preflight.preflight_record_id,
        replay_record_id: preflight.replay_record_id,
        adapter_record_id: preflight.adapter_record_id,
        persisted_evidence_id: preflight.persisted_evidence_id,
        evidence_id: preflight.evidence_id,
        proof_id: preflight.proof_id,
        persisted_request_id: preflight.persisted_request_id,
        stopped_request_id: preflight.stopped_request_id,
        idempotency_key: preflight.idempotency_key,
        descriptor_id: preflight.descriptor_id,
        admission_id: preflight.admission_id,
        source_replay_record_id: preflight.source_replay_record_id,
        task_ids: preflight.task_ids,
        repo_ids: preflight.repo_ids,
        source_authority_ref: preflight.source_authority_ref,
        execution_authority_ref: preflight.execution_authority_ref,
        inspected_ref_count: preflight.inspected_ref_count,
        status,
        blockers,
        duplicate_spawn_request_detected,
        command_spawn_permitted: false,
        local_snap_creation_permitted: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}

fn status(
    preflight: &ConvergenceLocalSnapExecutionPreflightRecord,
    duplicate_spawn_request_detected: bool,
    blockers: &[ConvergenceLocalSnapSpawnRequestBlocker],
) -> ConvergenceLocalSnapSpawnRequestStatus {
    if duplicate_spawn_request_detected
        || preflight.status == ConvergenceLocalSnapExecutionPreflightStatus::DuplicateNoop
    {
        ConvergenceLocalSnapSpawnRequestStatus::DuplicateNoop
    } else if preflight.status == ConvergenceLocalSnapExecutionPreflightStatus::Unsupported {
        ConvergenceLocalSnapSpawnRequestStatus::Unsupported
    } else if !blockers.is_empty() {
        ConvergenceLocalSnapSpawnRequestStatus::Blocked
    } else {
        ConvergenceLocalSnapSpawnRequestStatus::Ready
    }
}

fn blockers(
    preflight: &ConvergenceLocalSnapExecutionPreflightRecord,
    duplicate_spawn_request_detected: bool,
    raw_material_present: bool,
    command_effect_requested: bool,
) -> Vec<ConvergenceLocalSnapSpawnRequestBlocker> {
    let mut blockers = Vec::new();
    if duplicate_spawn_request_detected {
        blockers.push(ConvergenceLocalSnapSpawnRequestBlocker::DuplicateSpawnRequest);
    }
    if preflight.status == ConvergenceLocalSnapExecutionPreflightStatus::DuplicateNoop {
        blockers.push(ConvergenceLocalSnapSpawnRequestBlocker::DuplicatePreflight);
    }
    if preflight.status != ConvergenceLocalSnapExecutionPreflightStatus::Ready
        && preflight.status != ConvergenceLocalSnapExecutionPreflightStatus::Unsupported
        && preflight.status != ConvergenceLocalSnapExecutionPreflightStatus::DuplicateNoop
    {
        blockers.push(ConvergenceLocalSnapSpawnRequestBlocker::PreflightNotReady);
    }
    if command_effect_requested {
        blockers.push(ConvergenceLocalSnapSpawnRequestBlocker::CommandEffectRequested);
    }
    if raw_material_present {
        blockers.push(ConvergenceLocalSnapSpawnRequestBlocker::RawMaterialPresent);
    }
    blockers
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_spawn_request/tests.rs"]
mod tests;
