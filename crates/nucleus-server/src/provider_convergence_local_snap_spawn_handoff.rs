//! Stopped process-runner handoff for Convergence local snap commands.

use crate::provider_no_effects::ConvergenceSnapNoAuthority;
use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceLocalSnapSpawnRequestRecord, ConvergenceLocalSnapSpawnRequestSet,
    ConvergenceLocalSnapSpawnRequestStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergenceLocalSnapSpawnHandoffInput {
    pub request: ConvergenceLocalSnapSpawnRequestSet,
    pub existing_handoff_ids: Vec<String>,
    pub raw_material_present: bool,
    pub runner_effect_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapSpawnHandoffSet {
    pub handoff_set_id: String,
    pub records: Vec<ConvergenceLocalSnapSpawnHandoffRecord>,
    pub ready_handoff_ids: Vec<String>,
    pub blocked_handoff_ids: Vec<String>,
    pub duplicate_handoff_ids: Vec<String>,
    pub unsupported_handoff_ids: Vec<String>,
    pub process_runner_invocation_permitted: bool,
    #[serde(flatten)]
    pub no_effects: ConvergenceSnapNoAuthority,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapSpawnHandoffRecord {
    pub handoff_id: String,
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
    pub status: ConvergenceLocalSnapSpawnHandoffStatus,
    pub blockers: Vec<ConvergenceLocalSnapSpawnHandoffBlocker>,
    pub duplicate_handoff_detected: bool,
    pub process_runner_invocation_permitted: bool,
    #[serde(flatten)]
    pub no_effects: ConvergenceSnapNoAuthority,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapSpawnHandoffStatus {
    Ready,
    Blocked,
    DuplicateNoop,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapSpawnHandoffBlocker {
    SpawnRequestNotReady,
    DuplicateSpawnRequest,
    DuplicateHandoff,
    RunnerEffectRequested,
    RawMaterialPresent,
}

pub fn convergence_local_snap_spawn_handoff(
    input: ConvergenceLocalSnapSpawnHandoffInput,
) -> ConvergenceLocalSnapSpawnHandoffSet {
    let existing_handoff_ids = input.existing_handoff_ids;
    let mut records = input
        .request
        .records
        .into_iter()
        .map(|record| {
            handoff_record(
                record,
                &existing_handoff_ids,
                input.raw_material_present,
                input.runner_effect_requested,
            )
        })
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.handoff_id.cmp(&right.handoff_id));

    ConvergenceLocalSnapSpawnHandoffSet {
        handoff_set_id: "convergence-local-snap-spawn-handoff".to_owned(),
        ready_handoff_ids: records
            .iter()
            .filter(|record| record.status == ConvergenceLocalSnapSpawnHandoffStatus::Ready)
            .map(|record| record.handoff_id.clone())
            .collect(),
        blocked_handoff_ids: records
            .iter()
            .filter(|record| record.status == ConvergenceLocalSnapSpawnHandoffStatus::Blocked)
            .map(|record| record.handoff_id.clone())
            .collect(),
        duplicate_handoff_ids: records
            .iter()
            .filter(|record| record.status == ConvergenceLocalSnapSpawnHandoffStatus::DuplicateNoop)
            .map(|record| record.handoff_id.clone())
            .collect(),
        unsupported_handoff_ids: records
            .iter()
            .filter(|record| record.status == ConvergenceLocalSnapSpawnHandoffStatus::Unsupported)
            .map(|record| record.handoff_id.clone())
            .collect(),
        records,
        process_runner_invocation_permitted: false,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}

fn handoff_record(
    request: ConvergenceLocalSnapSpawnRequestRecord,
    existing_handoff_ids: &[String],
    raw_material_present: bool,
    runner_effect_requested: bool,
) -> ConvergenceLocalSnapSpawnHandoffRecord {
    let handoff_id = format!(
        "convergence-local-snap-spawn-handoff:{}",
        request.spawn_request_id
    );
    let duplicate_handoff_detected = existing_handoff_ids.contains(&handoff_id);
    let blockers = blockers(
        &request,
        duplicate_handoff_detected,
        raw_material_present,
        runner_effect_requested,
    );
    let status = status(&request, duplicate_handoff_detected, &blockers);

    ConvergenceLocalSnapSpawnHandoffRecord {
        handoff_id,
        spawn_request_id: request.spawn_request_id,
        preflight_record_id: request.preflight_record_id,
        replay_record_id: request.replay_record_id,
        adapter_record_id: request.adapter_record_id,
        persisted_evidence_id: request.persisted_evidence_id,
        evidence_id: request.evidence_id,
        proof_id: request.proof_id,
        persisted_request_id: request.persisted_request_id,
        stopped_request_id: request.stopped_request_id,
        idempotency_key: request.idempotency_key,
        descriptor_id: request.descriptor_id,
        admission_id: request.admission_id,
        source_replay_record_id: request.source_replay_record_id,
        task_ids: request.task_ids,
        repo_ids: request.repo_ids,
        source_authority_ref: request.source_authority_ref,
        execution_authority_ref: request.execution_authority_ref,
        inspected_ref_count: request.inspected_ref_count,
        status,
        blockers,
        duplicate_handoff_detected,
        process_runner_invocation_permitted: false,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}

fn status(
    request: &ConvergenceLocalSnapSpawnRequestRecord,
    duplicate_handoff_detected: bool,
    blockers: &[ConvergenceLocalSnapSpawnHandoffBlocker],
) -> ConvergenceLocalSnapSpawnHandoffStatus {
    if duplicate_handoff_detected
        || request.status == ConvergenceLocalSnapSpawnRequestStatus::DuplicateNoop
    {
        ConvergenceLocalSnapSpawnHandoffStatus::DuplicateNoop
    } else if request.status == ConvergenceLocalSnapSpawnRequestStatus::Unsupported {
        ConvergenceLocalSnapSpawnHandoffStatus::Unsupported
    } else if !blockers.is_empty() {
        ConvergenceLocalSnapSpawnHandoffStatus::Blocked
    } else {
        ConvergenceLocalSnapSpawnHandoffStatus::Ready
    }
}

fn blockers(
    request: &ConvergenceLocalSnapSpawnRequestRecord,
    duplicate_handoff_detected: bool,
    raw_material_present: bool,
    runner_effect_requested: bool,
) -> Vec<ConvergenceLocalSnapSpawnHandoffBlocker> {
    let mut blockers = Vec::new();
    if duplicate_handoff_detected {
        blockers.push(ConvergenceLocalSnapSpawnHandoffBlocker::DuplicateHandoff);
    }
    if request.status == ConvergenceLocalSnapSpawnRequestStatus::DuplicateNoop {
        blockers.push(ConvergenceLocalSnapSpawnHandoffBlocker::DuplicateSpawnRequest);
    }
    if request.status != ConvergenceLocalSnapSpawnRequestStatus::Ready
        && request.status != ConvergenceLocalSnapSpawnRequestStatus::Unsupported
        && request.status != ConvergenceLocalSnapSpawnRequestStatus::DuplicateNoop
    {
        blockers.push(ConvergenceLocalSnapSpawnHandoffBlocker::SpawnRequestNotReady);
    }
    if runner_effect_requested {
        blockers.push(ConvergenceLocalSnapSpawnHandoffBlocker::RunnerEffectRequested);
    }
    if raw_material_present {
        blockers.push(ConvergenceLocalSnapSpawnHandoffBlocker::RawMaterialPresent);
    }
    blockers
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_spawn_handoff/tests.rs"]
mod tests;
