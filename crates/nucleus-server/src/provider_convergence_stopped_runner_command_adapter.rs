//! Stopped command-adapter records for Convergence publication runner evidence.

use crate::provider_no_effects::{ConvergenceRunnerNoAuthority};
use serde::{Deserialize, Serialize};

use crate::{
    ConvergencePublicationRunnerEvidencePersistenceRecord,
    ConvergencePublicationRunnerEvidencePersistenceSet,
    ConvergencePublicationRunnerEvidencePersistenceStatus,
    ConvergencePublicationRunnerEvidenceStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergenceStoppedRunnerCommandAdapterInput {
    pub persistence: ConvergencePublicationRunnerEvidencePersistenceSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceStoppedRunnerCommandAdapterSet {
    pub adapter_set_id: String,
    pub records: Vec<ConvergenceStoppedRunnerCommandAdapterRecord>,
    pub skipped_persisted_evidence_ids: Vec<String>,
    #[serde(flatten)]
    pub no_effects: ConvergenceRunnerNoAuthority,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceStoppedRunnerCommandAdapterRecord {
    pub adapter_record_id: String,
    pub persisted_evidence_id: String,
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
    pub adapter_kind: ConvergenceStoppedRunnerCommandAdapterKind,
    pub command_shape: ConvergenceStoppedRunnerCommandShape,
    pub status: ConvergenceStoppedRunnerCommandAdapterStatus,
    pub blockers: Vec<ConvergenceStoppedRunnerCommandAdapterBlocker>,
    #[serde(flatten)]
    pub no_effects: ConvergenceRunnerNoAuthority,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceStoppedRunnerCommandAdapterKind {
    StoppedProof,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceStoppedRunnerCommandShape {
    SnapshotPublishReview,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceStoppedRunnerCommandAdapterStatus {
    Runnable,
    Blocked,
    DuplicateNoop,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceStoppedRunnerCommandAdapterBlocker {
    EvidencePersistenceNotReady,
    DuplicateEvidence,
    MissingSnapshotStage,
    MissingPublishStage,
    MissingPublicationReviewStage,
    EvidenceNotReviewable,
}

pub fn convergence_stopped_runner_command_adapter(
    input: ConvergenceStoppedRunnerCommandAdapterInput,
) -> ConvergenceStoppedRunnerCommandAdapterSet {
    let mut records = input
        .persistence
        .records
        .into_iter()
        .map(adapter_record)
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.adapter_record_id.cmp(&right.adapter_record_id));

    ConvergenceStoppedRunnerCommandAdapterSet {
        adapter_set_id: "convergence-stopped-runner-command-adapter".to_owned(),
        skipped_persisted_evidence_ids: records
            .iter()
            .filter(|record| {
                record.status != ConvergenceStoppedRunnerCommandAdapterStatus::Runnable
            })
            .map(|record| record.persisted_evidence_id.clone())
            .collect(),
        records,
        no_effects: ConvergenceRunnerNoAuthority::none(),
    }
}

fn adapter_record(
    evidence: ConvergencePublicationRunnerEvidencePersistenceRecord,
) -> ConvergenceStoppedRunnerCommandAdapterRecord {
    let blockers = adapter_blockers(&evidence);
    let status = adapter_status(&evidence, &blockers);

    ConvergenceStoppedRunnerCommandAdapterRecord {
        adapter_record_id: format!(
            "convergence-stopped-runner-command:{}",
            evidence.persisted_evidence_id
        ),
        persisted_evidence_id: evidence.persisted_evidence_id,
        evidence_id: evidence.evidence_id,
        proof_id: evidence.proof_id,
        persisted_request_id: evidence.persisted_request_id,
        request_id: evidence.request_id,
        idempotency_key: evidence.idempotency_key,
        task_ids: evidence.task_ids,
        repo_ids: evidence.repo_ids,
        snapshot_stage_count: evidence.snapshot_stage_count,
        publish_stage_count: evidence.publish_stage_count,
        publication_review_stage_count: evidence.publication_review_stage_count,
        inspected_stage_count: evidence.inspected_stage_count,
        adapter_kind: ConvergenceStoppedRunnerCommandAdapterKind::StoppedProof,
        command_shape: ConvergenceStoppedRunnerCommandShape::SnapshotPublishReview,
        status,
        blockers,
        no_effects: ConvergenceRunnerNoAuthority::none(),
    }
}

fn adapter_status(
    evidence: &ConvergencePublicationRunnerEvidencePersistenceRecord,
    blockers: &[ConvergenceStoppedRunnerCommandAdapterBlocker],
) -> ConvergenceStoppedRunnerCommandAdapterStatus {
    if evidence.status == ConvergencePublicationRunnerEvidencePersistenceStatus::DuplicateNoop {
        ConvergenceStoppedRunnerCommandAdapterStatus::DuplicateNoop
    } else if !blockers.is_empty() {
        ConvergenceStoppedRunnerCommandAdapterStatus::Blocked
    } else {
        ConvergenceStoppedRunnerCommandAdapterStatus::Runnable
    }
}

fn adapter_blockers(
    evidence: &ConvergencePublicationRunnerEvidencePersistenceRecord,
) -> Vec<ConvergenceStoppedRunnerCommandAdapterBlocker> {
    let mut blockers = Vec::new();
    if evidence.status == ConvergencePublicationRunnerEvidencePersistenceStatus::DuplicateNoop {
        blockers.push(ConvergenceStoppedRunnerCommandAdapterBlocker::DuplicateEvidence);
        return blockers;
    }
    if evidence.status != ConvergencePublicationRunnerEvidencePersistenceStatus::Persisted {
        blockers.push(ConvergenceStoppedRunnerCommandAdapterBlocker::EvidencePersistenceNotReady);
    }
    if evidence.evidence_status != ConvergencePublicationRunnerEvidenceStatus::Reviewable {
        blockers.push(ConvergenceStoppedRunnerCommandAdapterBlocker::EvidenceNotReviewable);
    }
    if evidence.snapshot_stage_count == 0 {
        blockers.push(ConvergenceStoppedRunnerCommandAdapterBlocker::MissingSnapshotStage);
    }
    if evidence.publish_stage_count == 0 {
        blockers.push(ConvergenceStoppedRunnerCommandAdapterBlocker::MissingPublishStage);
    }
    if evidence.publication_review_stage_count == 0 {
        blockers.push(ConvergenceStoppedRunnerCommandAdapterBlocker::MissingPublicationReviewStage);
    }
    blockers
}

#[cfg(test)]
#[path = "provider_convergence_stopped_runner_command_adapter/tests.rs"]
mod tests;
