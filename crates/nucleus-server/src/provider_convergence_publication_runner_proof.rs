//! Stopped runner proof records for Convergence-like publication requests.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergencePublicationRequestPersistenceRecord, ConvergencePublicationRequestPersistenceSet,
    ConvergencePublicationRequestPersistenceStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergencePublicationRunnerProofInput {
    pub persisted_requests: ConvergencePublicationRequestPersistenceSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergencePublicationRunnerProofSet {
    pub proof_set_id: String,
    pub proofs: Vec<ConvergencePublicationRunnerProofRecord>,
    pub skipped_persisted_request_ids: Vec<String>,
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
pub struct ConvergencePublicationRunnerProofRecord {
    pub proof_id: String,
    pub persisted_request_id: String,
    pub request_id: String,
    pub idempotency_key: String,
    pub descriptor_id: String,
    pub preflight_id: String,
    pub admission_id: String,
    pub persisted_projection_id: String,
    pub projection_id: String,
    pub task_ids: Vec<String>,
    pub repo_ids: Vec<String>,
    pub operator_refs: Vec<String>,
    pub snapshot_stage_refs: Vec<String>,
    pub publish_stage_refs: Vec<String>,
    pub publication_review_stage_refs: Vec<String>,
    pub status: ConvergencePublicationRunnerProofStatus,
    pub blockers: Vec<ConvergencePublicationRunnerProofBlocker>,
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
pub enum ConvergencePublicationRunnerProofStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergencePublicationRunnerProofBlocker {
    RequestPersistenceNotReady,
    DuplicateRequest,
}

pub fn convergence_publication_runner_proof(
    input: ConvergencePublicationRunnerProofInput,
) -> ConvergencePublicationRunnerProofSet {
    let mut proofs = input
        .persisted_requests
        .records
        .into_iter()
        .map(proof_record)
        .collect::<Vec<_>>();
    proofs.sort_by(|left, right| left.proof_id.cmp(&right.proof_id));

    ConvergencePublicationRunnerProofSet {
        proof_set_id: "convergence-publication-runner-proof".to_owned(),
        skipped_persisted_request_ids: proofs
            .iter()
            .filter(|proof| proof.status != ConvergencePublicationRunnerProofStatus::Ready)
            .map(|proof| proof.persisted_request_id.clone())
            .collect(),
        proofs,
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

fn proof_record(
    record: ConvergencePublicationRequestPersistenceRecord,
) -> ConvergencePublicationRunnerProofRecord {
    let blockers = blockers(&record);
    let status = if blockers.is_empty() {
        ConvergencePublicationRunnerProofStatus::Ready
    } else {
        ConvergencePublicationRunnerProofStatus::Blocked
    };

    ConvergencePublicationRunnerProofRecord {
        proof_id: format!(
            "convergence-publication-runner-proof:{}",
            record.persisted_request_id
        ),
        persisted_request_id: record.persisted_request_id,
        request_id: record.request_id,
        idempotency_key: record.idempotency_key,
        descriptor_id: record.descriptor_id,
        preflight_id: record.preflight_id,
        admission_id: record.admission_id,
        persisted_projection_id: record.persisted_projection_id,
        projection_id: record.projection_id,
        task_ids: record.task_ids,
        repo_ids: record.repo_ids,
        operator_refs: record.operator_refs,
        snapshot_stage_refs: record.snapshot_stage_refs,
        publish_stage_refs: record.publish_stage_refs,
        publication_review_stage_refs: record.publication_review_stage_refs,
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
    record: &ConvergencePublicationRequestPersistenceRecord,
) -> Vec<ConvergencePublicationRunnerProofBlocker> {
    let mut blockers = Vec::new();
    if record.status != ConvergencePublicationRequestPersistenceStatus::Persisted {
        blockers.push(ConvergencePublicationRunnerProofBlocker::RequestPersistenceNotReady);
    }
    if record.duplicate_idempotency_detected {
        blockers.push(ConvergencePublicationRunnerProofBlocker::DuplicateRequest);
    }
    blockers
}

#[cfg(test)]
#[path = "provider_convergence_publication_runner_proof/tests.rs"]
mod tests;
