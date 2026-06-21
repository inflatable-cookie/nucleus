//! Stopped local snap admission records for Convergence runner replay.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceRunnerReplayEffectFamily, ConvergenceRunnerReplayRecord,
    ConvergenceRunnerReplayRecordSet, ConvergenceRunnerReplayStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergenceLocalSnapAdmissionInput {
    pub replay: ConvergenceRunnerReplayRecordSet,
    pub existing_admission_ids: Vec<String>,
    pub source_authority_ready: bool,
    pub execution_authority_ready: bool,
    pub workspace_ready: bool,
    pub backend_effect_requested: bool,
    pub raw_material_present: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapAdmissionSet {
    pub admission_set_id: String,
    pub records: Vec<ConvergenceLocalSnapAdmissionRecord>,
    pub duplicate_admission_ids: Vec<String>,
    pub blocked_admission_ids: Vec<String>,
    pub unsupported_admission_ids: Vec<String>,
    pub local_snap_creation_admitted: bool,
    pub local_snap_creation_executed: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub bundle_permitted: bool,
    pub approval_permitted: bool,
    pub promotion_permitted: bool,
    pub release_permitted: bool,
    pub resolution_publication_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapAdmissionRecord {
    pub admission_id: String,
    pub replay_record_id: String,
    pub adapter_record_id: String,
    pub persisted_evidence_id: String,
    pub evidence_id: String,
    pub proof_id: String,
    pub persisted_request_id: String,
    pub request_id: String,
    pub idempotency_key: String,
    pub task_ids: Vec<String>,
    pub repo_ids: Vec<String>,
    pub status: ConvergenceLocalSnapAdmissionStatus,
    pub blockers: Vec<ConvergenceLocalSnapAdmissionBlocker>,
    pub duplicate_admission_detected: bool,
    pub local_snap_creation_admitted: bool,
    pub local_snap_creation_executed: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub bundle_permitted: bool,
    pub approval_permitted: bool,
    pub promotion_permitted: bool,
    pub release_permitted: bool,
    pub resolution_publication_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapAdmissionStatus {
    Admitted,
    DuplicateNoop,
    Blocked,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapAdmissionBlocker {
    ReplayNotReady,
    DuplicateAdmission,
    MissingSourceAuthority,
    MissingExecutionAuthority,
    WorkspaceNotReady,
    MissingLocalSnapEffectFamily,
    BackendEffectRequested,
    RawMaterialPresent,
}

pub fn convergence_local_snap_admission(
    input: ConvergenceLocalSnapAdmissionInput,
) -> ConvergenceLocalSnapAdmissionSet {
    let existing_admission_ids = input.existing_admission_ids;
    let mut records = input
        .replay
        .records
        .into_iter()
        .map(|record| {
            admission_record(
                record,
                &existing_admission_ids,
                input.source_authority_ready,
                input.execution_authority_ready,
                input.workspace_ready,
                input.backend_effect_requested,
                input.raw_material_present,
            )
        })
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.admission_id.cmp(&right.admission_id));

    ConvergenceLocalSnapAdmissionSet {
        admission_set_id: "convergence-local-snap-admission".to_owned(),
        duplicate_admission_ids: records
            .iter()
            .filter(|record| record.duplicate_admission_detected)
            .map(|record| record.admission_id.clone())
            .collect(),
        blocked_admission_ids: records
            .iter()
            .filter(|record| record.status == ConvergenceLocalSnapAdmissionStatus::Blocked)
            .map(|record| record.admission_id.clone())
            .collect(),
        unsupported_admission_ids: records
            .iter()
            .filter(|record| record.status == ConvergenceLocalSnapAdmissionStatus::Unsupported)
            .map(|record| record.admission_id.clone())
            .collect(),
        local_snap_creation_admitted: records
            .iter()
            .any(|record| record.local_snap_creation_admitted),
        records,
        local_snap_creation_executed: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        bundle_permitted: false,
        approval_permitted: false,
        promotion_permitted: false,
        release_permitted: false,
        resolution_publication_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}

fn admission_record(
    replay: ConvergenceRunnerReplayRecord,
    existing_admission_ids: &[String],
    source_authority_ready: bool,
    execution_authority_ready: bool,
    workspace_ready: bool,
    backend_effect_requested: bool,
    raw_material_present: bool,
) -> ConvergenceLocalSnapAdmissionRecord {
    let admission_id = format!(
        "convergence-local-snap-admission:{}",
        replay.replay_record_id
    );
    let duplicate_admission_detected = existing_admission_ids.contains(&admission_id);
    let blockers = blockers(
        &replay,
        duplicate_admission_detected,
        source_authority_ready,
        execution_authority_ready,
        workspace_ready,
        backend_effect_requested,
        raw_material_present,
    );
    let status = status(&replay, duplicate_admission_detected, &blockers);
    let local_snap_creation_admitted = status == ConvergenceLocalSnapAdmissionStatus::Admitted;

    ConvergenceLocalSnapAdmissionRecord {
        admission_id,
        replay_record_id: replay.replay_record_id,
        adapter_record_id: replay.adapter_record_id,
        persisted_evidence_id: replay.persisted_evidence_id,
        evidence_id: replay.evidence_id,
        proof_id: replay.proof_id,
        persisted_request_id: replay.persisted_request_id,
        request_id: replay.request_id,
        idempotency_key: replay.idempotency_key,
        task_ids: replay.task_ids,
        repo_ids: replay.repo_ids,
        status,
        blockers,
        duplicate_admission_detected,
        local_snap_creation_admitted,
        local_snap_creation_executed: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        bundle_permitted: false,
        approval_permitted: false,
        promotion_permitted: false,
        release_permitted: false,
        resolution_publication_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}

fn status(
    replay: &ConvergenceRunnerReplayRecord,
    duplicate_admission_detected: bool,
    blockers: &[ConvergenceLocalSnapAdmissionBlocker],
) -> ConvergenceLocalSnapAdmissionStatus {
    if duplicate_admission_detected {
        ConvergenceLocalSnapAdmissionStatus::DuplicateNoop
    } else if replay.status == ConvergenceRunnerReplayStatus::Unsupported {
        ConvergenceLocalSnapAdmissionStatus::Unsupported
    } else if !blockers.is_empty() {
        ConvergenceLocalSnapAdmissionStatus::Blocked
    } else {
        ConvergenceLocalSnapAdmissionStatus::Admitted
    }
}

fn blockers(
    replay: &ConvergenceRunnerReplayRecord,
    duplicate_admission_detected: bool,
    source_authority_ready: bool,
    execution_authority_ready: bool,
    workspace_ready: bool,
    backend_effect_requested: bool,
    raw_material_present: bool,
) -> Vec<ConvergenceLocalSnapAdmissionBlocker> {
    let mut blockers = Vec::new();
    if duplicate_admission_detected {
        blockers.push(ConvergenceLocalSnapAdmissionBlocker::DuplicateAdmission);
    }
    if replay.status != ConvergenceRunnerReplayStatus::Replayed
        && replay.status != ConvergenceRunnerReplayStatus::Unsupported
    {
        blockers.push(ConvergenceLocalSnapAdmissionBlocker::ReplayNotReady);
    }
    if !source_authority_ready {
        blockers.push(ConvergenceLocalSnapAdmissionBlocker::MissingSourceAuthority);
    }
    if !execution_authority_ready {
        blockers.push(ConvergenceLocalSnapAdmissionBlocker::MissingExecutionAuthority);
    }
    if !workspace_ready {
        blockers.push(ConvergenceLocalSnapAdmissionBlocker::WorkspaceNotReady);
    }
    if !replay
        .effect_families
        .contains(&ConvergenceRunnerReplayEffectFamily::LocalSnapCreation)
    {
        blockers.push(ConvergenceLocalSnapAdmissionBlocker::MissingLocalSnapEffectFamily);
    }
    if backend_effect_requested {
        blockers.push(ConvergenceLocalSnapAdmissionBlocker::BackendEffectRequested);
    }
    if raw_material_present {
        blockers.push(ConvergenceLocalSnapAdmissionBlocker::RawMaterialPresent);
    }
    blockers
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_admission/tests.rs"]
mod tests;
