//! Replay records for stopped Convergence local snap runner adapter decisions.

use crate::provider_no_effects::ConvergenceSnapNoAuthority;
use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceLocalSnapStoppedRunnerCommandAdapterRecord,
    ConvergenceLocalSnapStoppedRunnerCommandAdapterSet,
    ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergenceLocalSnapRunnerReplayRecordsInput {
    pub adapter: ConvergenceLocalSnapStoppedRunnerCommandAdapterSet,
    pub existing_replay_record_ids: Vec<String>,
    pub raw_material_present: bool,
    pub command_effect_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapRunnerReplayRecordSet {
    pub replay_set_id: String,
    pub records: Vec<ConvergenceLocalSnapRunnerReplayRecord>,
    pub duplicate_replay_record_ids: Vec<String>,
    pub blocked_replay_record_ids: Vec<String>,
    pub unsupported_replay_record_ids: Vec<String>,
    #[serde(flatten)]
    pub no_effects: ConvergenceSnapNoAuthority,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapRunnerReplayRecord {
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
    pub effect_families: Vec<ConvergenceLocalSnapRunnerReplayEffectFamily>,
    pub status: ConvergenceLocalSnapRunnerReplayStatus,
    pub blockers: Vec<ConvergenceLocalSnapRunnerReplayBlocker>,
    pub duplicate_replay_detected: bool,
    #[serde(flatten)]
    pub no_effects: ConvergenceSnapNoAuthority,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapRunnerReplayEffectFamily {
    CommandSpawn,
    LocalSnapCreation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapRunnerReplayStatus {
    Replayed,
    DuplicateNoop,
    Blocked,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapRunnerReplayBlocker {
    AdapterRecordNotRunnable,
    DuplicateReplayRecord,
    CommandEffectRequested,
    RawMaterialPresent,
}

pub fn convergence_local_snap_runner_replay_records(
    input: ConvergenceLocalSnapRunnerReplayRecordsInput,
) -> ConvergenceLocalSnapRunnerReplayRecordSet {
    let existing_replay_record_ids = input.existing_replay_record_ids;
    let mut records = input
        .adapter
        .records
        .into_iter()
        .map(|record| {
            replay_record(
                record,
                &existing_replay_record_ids,
                input.raw_material_present,
                input.command_effect_requested,
            )
        })
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.replay_record_id.cmp(&right.replay_record_id));

    ConvergenceLocalSnapRunnerReplayRecordSet {
        replay_set_id: "convergence-local-snap-runner-replay-records".to_owned(),
        duplicate_replay_record_ids: records
            .iter()
            .filter(|record| record.duplicate_replay_detected)
            .map(|record| record.replay_record_id.clone())
            .collect(),
        blocked_replay_record_ids: records
            .iter()
            .filter(|record| record.status == ConvergenceLocalSnapRunnerReplayStatus::Blocked)
            .map(|record| record.replay_record_id.clone())
            .collect(),
        unsupported_replay_record_ids: records
            .iter()
            .filter(|record| record.status == ConvergenceLocalSnapRunnerReplayStatus::Unsupported)
            .map(|record| record.replay_record_id.clone())
            .collect(),
        records,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}

fn replay_record(
    adapter: ConvergenceLocalSnapStoppedRunnerCommandAdapterRecord,
    existing_replay_record_ids: &[String],
    raw_material_present: bool,
    command_effect_requested: bool,
) -> ConvergenceLocalSnapRunnerReplayRecord {
    let replay_record_id = format!(
        "convergence-local-snap-runner-replay:{}",
        adapter.adapter_record_id
    );
    let duplicate_replay_detected = existing_replay_record_ids.contains(&replay_record_id);
    let blockers = blockers(
        &adapter,
        duplicate_replay_detected,
        raw_material_present,
        command_effect_requested,
    );
    let status = status(&adapter, duplicate_replay_detected, &blockers);

    ConvergenceLocalSnapRunnerReplayRecord {
        replay_record_id,
        adapter_record_id: adapter.adapter_record_id,
        persisted_evidence_id: adapter.persisted_evidence_id,
        evidence_id: adapter.evidence_id,
        proof_id: adapter.proof_id,
        persisted_request_id: adapter.persisted_request_id,
        stopped_request_id: adapter.stopped_request_id,
        idempotency_key: adapter.idempotency_key,
        descriptor_id: adapter.descriptor_id,
        admission_id: adapter.admission_id,
        source_replay_record_id: adapter.replay_record_id,
        task_ids: adapter.task_ids,
        repo_ids: adapter.repo_ids,
        source_authority_ref: adapter.source_authority_ref,
        execution_authority_ref: adapter.execution_authority_ref,
        inspected_ref_count: adapter.inspected_ref_count,
        effect_families: local_snap_effect_families(),
        status,
        blockers,
        duplicate_replay_detected,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}

fn status(
    adapter: &ConvergenceLocalSnapStoppedRunnerCommandAdapterRecord,
    duplicate_replay_detected: bool,
    blockers: &[ConvergenceLocalSnapRunnerReplayBlocker],
) -> ConvergenceLocalSnapRunnerReplayStatus {
    if duplicate_replay_detected {
        ConvergenceLocalSnapRunnerReplayStatus::DuplicateNoop
    } else if adapter.status == ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Unsupported {
        ConvergenceLocalSnapRunnerReplayStatus::Unsupported
    } else if !blockers.is_empty() {
        ConvergenceLocalSnapRunnerReplayStatus::Blocked
    } else {
        ConvergenceLocalSnapRunnerReplayStatus::Replayed
    }
}

fn blockers(
    adapter: &ConvergenceLocalSnapStoppedRunnerCommandAdapterRecord,
    duplicate_replay_detected: bool,
    raw_material_present: bool,
    command_effect_requested: bool,
) -> Vec<ConvergenceLocalSnapRunnerReplayBlocker> {
    let mut blockers = Vec::new();
    if duplicate_replay_detected {
        blockers.push(ConvergenceLocalSnapRunnerReplayBlocker::DuplicateReplayRecord);
    }
    if adapter.status != ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Runnable
        && adapter.status != ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Unsupported
    {
        blockers.push(ConvergenceLocalSnapRunnerReplayBlocker::AdapterRecordNotRunnable);
    }
    if command_effect_requested {
        blockers.push(ConvergenceLocalSnapRunnerReplayBlocker::CommandEffectRequested);
    }
    if raw_material_present {
        blockers.push(ConvergenceLocalSnapRunnerReplayBlocker::RawMaterialPresent);
    }
    blockers
}

fn local_snap_effect_families() -> Vec<ConvergenceLocalSnapRunnerReplayEffectFamily> {
    vec![
        ConvergenceLocalSnapRunnerReplayEffectFamily::CommandSpawn,
        ConvergenceLocalSnapRunnerReplayEffectFamily::LocalSnapCreation,
    ]
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_runner_replay_records/tests.rs"]
mod tests;
