//! Persistence records for sanitized Convergence local snap runner evidence.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceLocalSnapRunnerEvidenceRecord, ConvergenceLocalSnapRunnerEvidenceSet,
    ConvergenceLocalSnapRunnerEvidenceStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergenceLocalSnapRunnerEvidencePersistenceInput {
    pub evidence: ConvergenceLocalSnapRunnerEvidenceSet,
    pub existing_evidence_ids: Vec<String>,
    pub raw_material_present: bool,
    pub command_spawn_requested: bool,
    pub local_snap_creation_requested: bool,
    pub object_upload_requested: bool,
    pub publication_requested: bool,
    pub lane_sync_requested: bool,
    pub provider_write_requested: bool,
    pub task_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapRunnerEvidencePersistenceSet {
    pub persistence_set_id: String,
    pub records: Vec<ConvergenceLocalSnapRunnerEvidencePersistenceRecord>,
    pub duplicate_evidence_ids: Vec<String>,
    pub blocked_evidence_ids: Vec<String>,
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
pub struct ConvergenceLocalSnapRunnerEvidencePersistenceRecord {
    pub persisted_evidence_id: String,
    pub evidence_id: String,
    pub proof_id: String,
    pub persisted_request_id: String,
    pub stopped_request_id: String,
    pub idempotency_key: String,
    pub descriptor_id: String,
    pub admission_id: String,
    pub replay_record_id: String,
    pub task_ids: Vec<String>,
    pub repo_ids: Vec<String>,
    pub source_authority_ref: String,
    pub execution_authority_ref: String,
    pub inspected_ref_count: usize,
    pub local_snap_descriptor_present: bool,
    pub evidence_status: ConvergenceLocalSnapRunnerEvidenceStatus,
    pub status: ConvergenceLocalSnapRunnerEvidencePersistenceStatus,
    pub blockers: Vec<ConvergenceLocalSnapRunnerEvidencePersistenceBlocker>,
    pub duplicate_evidence_detected: bool,
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
pub enum ConvergenceLocalSnapRunnerEvidencePersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapRunnerEvidencePersistenceBlocker {
    EvidenceNotReviewable,
    RawMaterialPresent,
    CommandSpawnRequested,
    LocalSnapCreationRequested,
    ObjectUploadRequested,
    PublicationRequested,
    LaneSyncRequested,
    ProviderWriteRequested,
    TaskMutationRequested,
}

pub fn convergence_local_snap_runner_evidence_persistence(
    input: ConvergenceLocalSnapRunnerEvidencePersistenceInput,
) -> ConvergenceLocalSnapRunnerEvidencePersistenceSet {
    let existing_evidence_ids = input.existing_evidence_ids;
    let flags = PersistenceFlags {
        raw_material_present: input.raw_material_present,
        command_spawn_requested: input.command_spawn_requested,
        local_snap_creation_requested: input.local_snap_creation_requested,
        object_upload_requested: input.object_upload_requested,
        publication_requested: input.publication_requested,
        lane_sync_requested: input.lane_sync_requested,
        provider_write_requested: input.provider_write_requested,
        task_mutation_requested: input.task_mutation_requested,
    };
    let mut records = input
        .evidence
        .evidence
        .into_iter()
        .map(|record| persistence_record(&flags, &existing_evidence_ids, record))
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.persisted_evidence_id.cmp(&right.persisted_evidence_id));

    ConvergenceLocalSnapRunnerEvidencePersistenceSet {
        persistence_set_id: "convergence-local-snap-runner-evidence-persistence".to_owned(),
        duplicate_evidence_ids: records
            .iter()
            .filter(|record| record.duplicate_evidence_detected)
            .map(|record| record.evidence_id.clone())
            .collect(),
        blocked_evidence_ids: records
            .iter()
            .filter(|record| {
                record.status == ConvergenceLocalSnapRunnerEvidencePersistenceStatus::Blocked
            })
            .map(|record| record.evidence_id.clone())
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

fn persistence_record(
    flags: &PersistenceFlags,
    existing_evidence_ids: &[String],
    evidence: ConvergenceLocalSnapRunnerEvidenceRecord,
) -> ConvergenceLocalSnapRunnerEvidencePersistenceRecord {
    let persisted_evidence_id = format!(
        "convergence-local-snap-runner-evidence:{}",
        evidence.evidence_id
    );
    let duplicate_evidence_detected = existing_evidence_ids.contains(&persisted_evidence_id);
    let blockers = if duplicate_evidence_detected {
        Vec::new()
    } else {
        blockers(flags, &evidence)
    };
    let status = if duplicate_evidence_detected {
        ConvergenceLocalSnapRunnerEvidencePersistenceStatus::DuplicateNoop
    } else if blockers.is_empty() {
        ConvergenceLocalSnapRunnerEvidencePersistenceStatus::Persisted
    } else {
        ConvergenceLocalSnapRunnerEvidencePersistenceStatus::Blocked
    };

    ConvergenceLocalSnapRunnerEvidencePersistenceRecord {
        persisted_evidence_id,
        evidence_id: evidence.evidence_id,
        proof_id: evidence.proof_id,
        persisted_request_id: evidence.persisted_request_id,
        stopped_request_id: evidence.stopped_request_id,
        idempotency_key: evidence.idempotency_key,
        descriptor_id: evidence.descriptor_id,
        admission_id: evidence.admission_id,
        replay_record_id: evidence.replay_record_id,
        task_ids: evidence.task_ids,
        repo_ids: evidence.repo_ids,
        source_authority_ref: evidence.source_authority_ref,
        execution_authority_ref: evidence.execution_authority_ref,
        inspected_ref_count: evidence.inspected_ref_count,
        local_snap_descriptor_present: evidence.local_snap_descriptor_present,
        evidence_status: evidence.status,
        status,
        blockers,
        duplicate_evidence_detected,
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

fn blockers(
    flags: &PersistenceFlags,
    evidence: &ConvergenceLocalSnapRunnerEvidenceRecord,
) -> Vec<ConvergenceLocalSnapRunnerEvidencePersistenceBlocker> {
    let mut blockers = Vec::new();
    if evidence.status != ConvergenceLocalSnapRunnerEvidenceStatus::Reviewable {
        blockers.push(ConvergenceLocalSnapRunnerEvidencePersistenceBlocker::EvidenceNotReviewable);
    }
    if flags.raw_material_present || evidence.raw_output_retained {
        blockers.push(ConvergenceLocalSnapRunnerEvidencePersistenceBlocker::RawMaterialPresent);
    }
    if flags.command_spawn_requested || evidence.command_spawned {
        blockers.push(ConvergenceLocalSnapRunnerEvidencePersistenceBlocker::CommandSpawnRequested);
    }
    if flags.local_snap_creation_requested || evidence.local_snap_creation_executed {
        blockers
            .push(ConvergenceLocalSnapRunnerEvidencePersistenceBlocker::LocalSnapCreationRequested);
    }
    if flags.object_upload_requested || evidence.object_upload_executed {
        blockers.push(ConvergenceLocalSnapRunnerEvidencePersistenceBlocker::ObjectUploadRequested);
    }
    if flags.publication_requested || evidence.publication_executed {
        blockers.push(ConvergenceLocalSnapRunnerEvidencePersistenceBlocker::PublicationRequested);
    }
    if flags.lane_sync_requested || evidence.lane_sync_executed {
        blockers.push(ConvergenceLocalSnapRunnerEvidencePersistenceBlocker::LaneSyncRequested);
    }
    if flags.provider_write_requested || evidence.provider_write_executed {
        blockers.push(ConvergenceLocalSnapRunnerEvidencePersistenceBlocker::ProviderWriteRequested);
    }
    if flags.task_mutation_requested || evidence.task_mutation_executed {
        blockers.push(ConvergenceLocalSnapRunnerEvidencePersistenceBlocker::TaskMutationRequested);
    }
    blockers
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PersistenceFlags {
    raw_material_present: bool,
    command_spawn_requested: bool,
    local_snap_creation_requested: bool,
    object_upload_requested: bool,
    publication_requested: bool,
    lane_sync_requested: bool,
    provider_write_requested: bool,
    task_mutation_requested: bool,
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_runner_evidence_persistence/tests.rs"]
mod tests;
