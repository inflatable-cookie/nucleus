//! Sanitized evidence for stopped Convergence local snap runner proofs.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceLocalSnapRunnerProofRecord, ConvergenceLocalSnapRunnerProofSet,
    ConvergenceLocalSnapRunnerProofStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergenceLocalSnapRunnerEvidenceInput {
    pub proofs: ConvergenceLocalSnapRunnerProofSet,
    pub inspected_ref_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapRunnerEvidenceSet {
    pub evidence_set_id: String,
    pub evidence: Vec<ConvergenceLocalSnapRunnerEvidenceRecord>,
    pub skipped_proof_ids: Vec<String>,
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
pub struct ConvergenceLocalSnapRunnerEvidenceRecord {
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
    pub status: ConvergenceLocalSnapRunnerEvidenceStatus,
    pub blockers: Vec<ConvergenceLocalSnapRunnerEvidenceBlocker>,
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
pub enum ConvergenceLocalSnapRunnerEvidenceStatus {
    Reviewable,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapRunnerEvidenceBlocker {
    ProofNotReady,
    NoRefsInspected,
    MissingLocalSnapDescriptor,
}

pub fn convergence_local_snap_runner_evidence(
    input: ConvergenceLocalSnapRunnerEvidenceInput,
) -> ConvergenceLocalSnapRunnerEvidenceSet {
    let inspected_ref_count = input.inspected_ref_count;
    let mut evidence = input
        .proofs
        .proofs
        .into_iter()
        .map(|proof| evidence_record(inspected_ref_count, proof))
        .collect::<Vec<_>>();
    evidence.sort_by(|left, right| left.evidence_id.cmp(&right.evidence_id));

    ConvergenceLocalSnapRunnerEvidenceSet {
        evidence_set_id: "convergence-local-snap-runner-evidence".to_owned(),
        skipped_proof_ids: evidence
            .iter()
            .filter(|record| record.status != ConvergenceLocalSnapRunnerEvidenceStatus::Reviewable)
            .map(|record| record.proof_id.clone())
            .collect(),
        evidence,
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

fn evidence_record(
    inspected_ref_count: usize,
    proof: ConvergenceLocalSnapRunnerProofRecord,
) -> ConvergenceLocalSnapRunnerEvidenceRecord {
    let blockers = blockers(inspected_ref_count, &proof);
    let status = if blockers.is_empty() {
        ConvergenceLocalSnapRunnerEvidenceStatus::Reviewable
    } else {
        ConvergenceLocalSnapRunnerEvidenceStatus::Blocked
    };

    ConvergenceLocalSnapRunnerEvidenceRecord {
        evidence_id: format!("convergence-local-snap-runner-evidence:{}", proof.proof_id),
        proof_id: proof.proof_id,
        persisted_request_id: proof.persisted_request_id,
        stopped_request_id: proof.stopped_request_id,
        idempotency_key: proof.idempotency_key,
        descriptor_id: proof.descriptor_id,
        admission_id: proof.admission_id,
        replay_record_id: proof.replay_record_id,
        task_ids: proof.task_ids,
        repo_ids: proof.repo_ids,
        source_authority_ref: proof.source_authority_ref,
        execution_authority_ref: proof.execution_authority_ref,
        inspected_ref_count,
        local_snap_descriptor_present: proof.local_snap_descriptor_ref.is_some(),
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
    inspected_ref_count: usize,
    proof: &ConvergenceLocalSnapRunnerProofRecord,
) -> Vec<ConvergenceLocalSnapRunnerEvidenceBlocker> {
    let mut blockers = Vec::new();
    if proof.status != ConvergenceLocalSnapRunnerProofStatus::Ready {
        blockers.push(ConvergenceLocalSnapRunnerEvidenceBlocker::ProofNotReady);
    }
    if inspected_ref_count == 0 {
        blockers.push(ConvergenceLocalSnapRunnerEvidenceBlocker::NoRefsInspected);
    }
    if proof.local_snap_descriptor_ref.is_none() {
        blockers.push(ConvergenceLocalSnapRunnerEvidenceBlocker::MissingLocalSnapDescriptor);
    }
    blockers
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_runner_evidence/tests.rs"]
mod tests;
