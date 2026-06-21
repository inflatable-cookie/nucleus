//! Sanitized evidence for stopped Convergence-like publication runner proofs.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergencePublicationRunnerProofRecord, ConvergencePublicationRunnerProofSet,
    ConvergencePublicationRunnerProofStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergencePublicationRunnerEvidenceInput {
    pub proofs: ConvergencePublicationRunnerProofSet,
    pub inspected_stage_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergencePublicationRunnerEvidenceSet {
    pub evidence_set_id: String,
    pub evidence: Vec<ConvergencePublicationRunnerEvidenceRecord>,
    pub skipped_proof_ids: Vec<String>,
    pub runner_invoked: bool,
    pub provider_handoff_created: bool,
    pub snapshot_creation_executed: bool,
    pub publish_executed: bool,
    pub publication_review_executed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergencePublicationRunnerEvidenceRecord {
    pub evidence_id: String,
    pub proof_id: String,
    pub persisted_request_id: String,
    pub request_id: String,
    pub idempotency_key: String,
    pub task_ids: Vec<String>,
    pub repo_ids: Vec<String>,
    pub snapshot_stage_count: usize,
    pub publish_stage_count: usize,
    pub publication_review_stage_count: usize,
    pub inspected_stage_count: usize,
    pub status: ConvergencePublicationRunnerEvidenceStatus,
    pub blockers: Vec<ConvergencePublicationRunnerEvidenceBlocker>,
    pub runner_invoked: bool,
    pub provider_handoff_created: bool,
    pub snapshot_creation_executed: bool,
    pub publish_executed: bool,
    pub publication_review_executed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergencePublicationRunnerEvidenceStatus {
    Reviewable,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergencePublicationRunnerEvidenceBlocker {
    ProofNotReady,
    NoStagesInspected,
}

pub fn convergence_publication_runner_evidence(
    input: ConvergencePublicationRunnerEvidenceInput,
) -> ConvergencePublicationRunnerEvidenceSet {
    let inspected_stage_count = input.inspected_stage_count;
    let mut evidence = input
        .proofs
        .proofs
        .into_iter()
        .map(|proof| evidence_record(inspected_stage_count, proof))
        .collect::<Vec<_>>();
    evidence.sort_by(|left, right| left.evidence_id.cmp(&right.evidence_id));

    ConvergencePublicationRunnerEvidenceSet {
        evidence_set_id: "convergence-publication-runner-evidence".to_owned(),
        skipped_proof_ids: evidence
            .iter()
            .filter(|record| {
                record.status != ConvergencePublicationRunnerEvidenceStatus::Reviewable
            })
            .map(|record| record.proof_id.clone())
            .collect(),
        evidence,
        runner_invoked: false,
        provider_handoff_created: false,
        snapshot_creation_executed: false,
        publish_executed: false,
        publication_review_executed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}

fn evidence_record(
    inspected_stage_count: usize,
    proof: ConvergencePublicationRunnerProofRecord,
) -> ConvergencePublicationRunnerEvidenceRecord {
    let blockers = blockers(inspected_stage_count, &proof);
    let status = if blockers.is_empty() {
        ConvergencePublicationRunnerEvidenceStatus::Reviewable
    } else {
        ConvergencePublicationRunnerEvidenceStatus::Blocked
    };

    ConvergencePublicationRunnerEvidenceRecord {
        evidence_id: format!("convergence-publication-runner-evidence:{}", proof.proof_id),
        proof_id: proof.proof_id,
        persisted_request_id: proof.persisted_request_id,
        request_id: proof.request_id,
        idempotency_key: proof.idempotency_key,
        task_ids: proof.task_ids,
        repo_ids: proof.repo_ids,
        snapshot_stage_count: proof.snapshot_stage_refs.len(),
        publish_stage_count: proof.publish_stage_refs.len(),
        publication_review_stage_count: proof.publication_review_stage_refs.len(),
        inspected_stage_count,
        status,
        blockers,
        runner_invoked: false,
        provider_handoff_created: false,
        snapshot_creation_executed: false,
        publish_executed: false,
        publication_review_executed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}

fn blockers(
    inspected_stage_count: usize,
    proof: &ConvergencePublicationRunnerProofRecord,
) -> Vec<ConvergencePublicationRunnerEvidenceBlocker> {
    let mut blockers = Vec::new();
    if proof.status != ConvergencePublicationRunnerProofStatus::Ready {
        blockers.push(ConvergencePublicationRunnerEvidenceBlocker::ProofNotReady);
    }
    if inspected_stage_count == 0 {
        blockers.push(ConvergencePublicationRunnerEvidenceBlocker::NoStagesInspected);
    }
    blockers
}

#[cfg(test)]
#[path = "provider_convergence_publication_runner_evidence/tests.rs"]
mod tests;
