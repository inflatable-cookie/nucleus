//! Stopped execution preflight for Convergence local snap commands.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceLocalSnapRunnerReplayRecord, ConvergenceLocalSnapRunnerReplayRecordSet,
    ConvergenceLocalSnapRunnerReplayStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergenceLocalSnapExecutionPreflightInput {
    pub replay: ConvergenceLocalSnapRunnerReplayRecordSet,
    pub existing_preflight_record_ids: Vec<String>,
    pub operator_confirmed: bool,
    pub executable_ready: bool,
    pub workspace_ready: bool,
    pub raw_material_present: bool,
    pub command_effect_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapExecutionPreflightSet {
    pub preflight_set_id: String,
    pub records: Vec<ConvergenceLocalSnapExecutionPreflightRecord>,
    pub ready_preflight_record_ids: Vec<String>,
    pub blocked_preflight_record_ids: Vec<String>,
    pub duplicate_preflight_record_ids: Vec<String>,
    pub unsupported_preflight_record_ids: Vec<String>,
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
pub struct ConvergenceLocalSnapExecutionPreflightRecord {
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
    pub operator_confirmed: bool,
    pub executable_ready: bool,
    pub workspace_ready: bool,
    pub status: ConvergenceLocalSnapExecutionPreflightStatus,
    pub blockers: Vec<ConvergenceLocalSnapExecutionPreflightBlocker>,
    pub duplicate_preflight_detected: bool,
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
pub enum ConvergenceLocalSnapExecutionPreflightStatus {
    Ready,
    Blocked,
    DuplicateNoop,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapExecutionPreflightBlocker {
    ReplayRecordNotReplayed,
    DuplicatePreflightRecord,
    DuplicateReplayRecord,
    MissingOperatorConfirmation,
    ExecutableNotReady,
    WorkspaceNotReady,
    MissingSourceAuthority,
    MissingExecutionAuthority,
    CommandEffectRequested,
    RawMaterialPresent,
}

pub fn convergence_local_snap_execution_preflight(
    input: ConvergenceLocalSnapExecutionPreflightInput,
) -> ConvergenceLocalSnapExecutionPreflightSet {
    let existing_preflight_record_ids = input.existing_preflight_record_ids;
    let context = PreflightContext {
        operator_confirmed: input.operator_confirmed,
        executable_ready: input.executable_ready,
        workspace_ready: input.workspace_ready,
        raw_material_present: input.raw_material_present,
        command_effect_requested: input.command_effect_requested,
    };
    let mut records = input
        .replay
        .records
        .into_iter()
        .map(|record| preflight_record(record, &existing_preflight_record_ids, &context))
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.preflight_record_id.cmp(&right.preflight_record_id));

    ConvergenceLocalSnapExecutionPreflightSet {
        preflight_set_id: "convergence-local-snap-execution-preflight".to_owned(),
        ready_preflight_record_ids: records
            .iter()
            .filter(|record| record.status == ConvergenceLocalSnapExecutionPreflightStatus::Ready)
            .map(|record| record.preflight_record_id.clone())
            .collect(),
        blocked_preflight_record_ids: records
            .iter()
            .filter(|record| record.status == ConvergenceLocalSnapExecutionPreflightStatus::Blocked)
            .map(|record| record.preflight_record_id.clone())
            .collect(),
        duplicate_preflight_record_ids: records
            .iter()
            .filter(|record| {
                record.status == ConvergenceLocalSnapExecutionPreflightStatus::DuplicateNoop
            })
            .map(|record| record.preflight_record_id.clone())
            .collect(),
        unsupported_preflight_record_ids: records
            .iter()
            .filter(|record| {
                record.status == ConvergenceLocalSnapExecutionPreflightStatus::Unsupported
            })
            .map(|record| record.preflight_record_id.clone())
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

fn preflight_record(
    replay: ConvergenceLocalSnapRunnerReplayRecord,
    existing_preflight_record_ids: &[String],
    context: &PreflightContext,
) -> ConvergenceLocalSnapExecutionPreflightRecord {
    let preflight_record_id = format!(
        "convergence-local-snap-execution-preflight:{}",
        replay.replay_record_id
    );
    let duplicate_preflight_detected = existing_preflight_record_ids.contains(&preflight_record_id);
    let blockers = blockers(&replay, duplicate_preflight_detected, context);
    let status = status(&replay, duplicate_preflight_detected, &blockers);

    ConvergenceLocalSnapExecutionPreflightRecord {
        preflight_record_id,
        replay_record_id: replay.replay_record_id,
        adapter_record_id: replay.adapter_record_id,
        persisted_evidence_id: replay.persisted_evidence_id,
        evidence_id: replay.evidence_id,
        proof_id: replay.proof_id,
        persisted_request_id: replay.persisted_request_id,
        stopped_request_id: replay.stopped_request_id,
        idempotency_key: replay.idempotency_key,
        descriptor_id: replay.descriptor_id,
        admission_id: replay.admission_id,
        source_replay_record_id: replay.source_replay_record_id,
        task_ids: replay.task_ids,
        repo_ids: replay.repo_ids,
        source_authority_ref: replay.source_authority_ref,
        execution_authority_ref: replay.execution_authority_ref,
        inspected_ref_count: replay.inspected_ref_count,
        operator_confirmed: context.operator_confirmed,
        executable_ready: context.executable_ready,
        workspace_ready: context.workspace_ready,
        status,
        blockers,
        duplicate_preflight_detected,
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
    replay: &ConvergenceLocalSnapRunnerReplayRecord,
    duplicate_preflight_detected: bool,
    blockers: &[ConvergenceLocalSnapExecutionPreflightBlocker],
) -> ConvergenceLocalSnapExecutionPreflightStatus {
    if duplicate_preflight_detected
        || replay.status == ConvergenceLocalSnapRunnerReplayStatus::DuplicateNoop
    {
        ConvergenceLocalSnapExecutionPreflightStatus::DuplicateNoop
    } else if replay.status == ConvergenceLocalSnapRunnerReplayStatus::Unsupported {
        ConvergenceLocalSnapExecutionPreflightStatus::Unsupported
    } else if !blockers.is_empty() {
        ConvergenceLocalSnapExecutionPreflightStatus::Blocked
    } else {
        ConvergenceLocalSnapExecutionPreflightStatus::Ready
    }
}

fn blockers(
    replay: &ConvergenceLocalSnapRunnerReplayRecord,
    duplicate_preflight_detected: bool,
    context: &PreflightContext,
) -> Vec<ConvergenceLocalSnapExecutionPreflightBlocker> {
    let mut blockers = Vec::new();
    if duplicate_preflight_detected {
        blockers.push(ConvergenceLocalSnapExecutionPreflightBlocker::DuplicatePreflightRecord);
    }
    if replay.status == ConvergenceLocalSnapRunnerReplayStatus::DuplicateNoop {
        blockers.push(ConvergenceLocalSnapExecutionPreflightBlocker::DuplicateReplayRecord);
    }
    if replay.status != ConvergenceLocalSnapRunnerReplayStatus::Replayed
        && replay.status != ConvergenceLocalSnapRunnerReplayStatus::Unsupported
        && replay.status != ConvergenceLocalSnapRunnerReplayStatus::DuplicateNoop
    {
        blockers.push(ConvergenceLocalSnapExecutionPreflightBlocker::ReplayRecordNotReplayed);
    }
    if !context.operator_confirmed {
        blockers.push(ConvergenceLocalSnapExecutionPreflightBlocker::MissingOperatorConfirmation);
    }
    if !context.executable_ready {
        blockers.push(ConvergenceLocalSnapExecutionPreflightBlocker::ExecutableNotReady);
    }
    if !context.workspace_ready {
        blockers.push(ConvergenceLocalSnapExecutionPreflightBlocker::WorkspaceNotReady);
    }
    if replay.source_authority_ref.is_empty() {
        blockers.push(ConvergenceLocalSnapExecutionPreflightBlocker::MissingSourceAuthority);
    }
    if replay.execution_authority_ref.is_empty() {
        blockers.push(ConvergenceLocalSnapExecutionPreflightBlocker::MissingExecutionAuthority);
    }
    if context.command_effect_requested {
        blockers.push(ConvergenceLocalSnapExecutionPreflightBlocker::CommandEffectRequested);
    }
    if context.raw_material_present {
        blockers.push(ConvergenceLocalSnapExecutionPreflightBlocker::RawMaterialPresent);
    }
    blockers
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PreflightContext {
    operator_confirmed: bool,
    executable_ready: bool,
    workspace_ready: bool,
    raw_material_present: bool,
    command_effect_requested: bool,
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_execution_preflight/tests.rs"]
mod tests;
