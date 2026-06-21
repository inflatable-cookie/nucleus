//! Stopped runner proof records for Convergence local snap requests.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceLocalSnapRequestPersistenceRecord, ConvergenceLocalSnapRequestPersistenceSet,
    ConvergenceLocalSnapRequestPersistenceStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergenceLocalSnapRunnerProofInput {
    pub persisted_requests: ConvergenceLocalSnapRequestPersistenceSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapRunnerProofSet {
    pub proof_set_id: String,
    pub proofs: Vec<ConvergenceLocalSnapRunnerProofRecord>,
    pub skipped_persisted_request_ids: Vec<String>,
    pub command_spawned: bool,
    pub local_snap_creation_executed: bool,
    pub object_upload_executed: bool,
    pub publication_executed: bool,
    pub lane_sync_executed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapRunnerProofRecord {
    pub proof_id: String,
    pub persisted_request_id: String,
    pub stopped_request_id: String,
    pub idempotency_key: String,
    pub descriptor_id: String,
    pub admission_id: String,
    pub replay_record_id: String,
    pub adapter_record_id: String,
    pub persisted_evidence_id: String,
    pub evidence_id: String,
    pub source_proof_id: String,
    pub source_persisted_request_id: String,
    pub source_request_id: String,
    pub task_ids: Vec<String>,
    pub repo_ids: Vec<String>,
    pub source_authority_ref: String,
    pub execution_authority_ref: String,
    pub local_snap_descriptor_ref: Option<String>,
    pub status: ConvergenceLocalSnapRunnerProofStatus,
    pub blockers: Vec<ConvergenceLocalSnapRunnerProofBlocker>,
    pub command_spawned: bool,
    pub local_snap_creation_executed: bool,
    pub object_upload_executed: bool,
    pub publication_executed: bool,
    pub lane_sync_executed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapRunnerProofStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapRunnerProofBlocker {
    RequestPersistenceNotReady,
    DuplicateRequest,
}

pub fn convergence_local_snap_runner_proof(
    input: ConvergenceLocalSnapRunnerProofInput,
) -> ConvergenceLocalSnapRunnerProofSet {
    let mut proofs = input
        .persisted_requests
        .records
        .into_iter()
        .map(proof_record)
        .collect::<Vec<_>>();
    proofs.sort_by(|left, right| left.proof_id.cmp(&right.proof_id));

    ConvergenceLocalSnapRunnerProofSet {
        proof_set_id: "convergence-local-snap-runner-proof".to_owned(),
        skipped_persisted_request_ids: proofs
            .iter()
            .filter(|proof| proof.status != ConvergenceLocalSnapRunnerProofStatus::Ready)
            .map(|proof| proof.persisted_request_id.clone())
            .collect(),
        proofs,
        command_spawned: false,
        local_snap_creation_executed: false,
        object_upload_executed: false,
        publication_executed: false,
        lane_sync_executed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}

fn proof_record(
    record: ConvergenceLocalSnapRequestPersistenceRecord,
) -> ConvergenceLocalSnapRunnerProofRecord {
    let blockers = blockers(&record);
    let status = if blockers.is_empty() {
        ConvergenceLocalSnapRunnerProofStatus::Ready
    } else {
        ConvergenceLocalSnapRunnerProofStatus::Blocked
    };

    ConvergenceLocalSnapRunnerProofRecord {
        proof_id: format!(
            "convergence-local-snap-runner-proof:{}",
            record.persisted_request_id
        ),
        persisted_request_id: record.persisted_request_id,
        stopped_request_id: record.stopped_request_id,
        idempotency_key: record.idempotency_key,
        descriptor_id: record.descriptor_id,
        admission_id: record.admission_id,
        replay_record_id: record.replay_record_id,
        adapter_record_id: record.adapter_record_id,
        persisted_evidence_id: record.persisted_evidence_id,
        evidence_id: record.evidence_id,
        source_proof_id: record.proof_id,
        source_persisted_request_id: record.source_persisted_request_id,
        source_request_id: record.source_request_id,
        task_ids: record.task_ids,
        repo_ids: record.repo_ids,
        source_authority_ref: record.source_authority_ref,
        execution_authority_ref: record.execution_authority_ref,
        local_snap_descriptor_ref: record.local_snap_descriptor_ref,
        status,
        blockers,
        command_spawned: false,
        local_snap_creation_executed: false,
        object_upload_executed: false,
        publication_executed: false,
        lane_sync_executed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}

fn blockers(
    record: &ConvergenceLocalSnapRequestPersistenceRecord,
) -> Vec<ConvergenceLocalSnapRunnerProofBlocker> {
    let mut blockers = Vec::new();
    if record.status != ConvergenceLocalSnapRequestPersistenceStatus::Persisted {
        blockers.push(ConvergenceLocalSnapRunnerProofBlocker::RequestPersistenceNotReady);
    }
    if record.duplicate_idempotency_detected {
        blockers.push(ConvergenceLocalSnapRunnerProofBlocker::DuplicateRequest);
    }
    blockers
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_runner_proof/tests.rs"]
mod tests;
