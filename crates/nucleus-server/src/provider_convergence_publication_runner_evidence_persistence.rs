//! Persistence records for sanitized Convergence publication runner evidence.

use crate::provider_no_effects::ConvergenceRunnerNoAuthority;
use serde::{Deserialize, Serialize};

use crate::{
    ConvergencePublicationRunnerEvidenceRecord, ConvergencePublicationRunnerEvidenceSet,
    ConvergencePublicationRunnerEvidenceStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergencePublicationRunnerEvidencePersistenceInput {
    pub evidence: ConvergencePublicationRunnerEvidenceSet,
    pub existing_evidence_ids: Vec<String>,
    pub raw_material_present: bool,
    pub runner_invocation_requested: bool,
    pub provider_handoff_requested: bool,
    pub snapshot_creation_requested: bool,
    pub publish_requested: bool,
    pub publication_review_requested: bool,
    pub provider_write_requested: bool,
    pub task_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergencePublicationRunnerEvidencePersistenceSet {
    pub persistence_set_id: String,
    pub records: Vec<ConvergencePublicationRunnerEvidencePersistenceRecord>,
    pub duplicate_evidence_ids: Vec<String>,
    pub blocked_evidence_ids: Vec<String>,
    #[serde(flatten)]
    pub no_effects: ConvergenceRunnerNoAuthority,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergencePublicationRunnerEvidencePersistenceRecord {
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
    pub evidence_status: ConvergencePublicationRunnerEvidenceStatus,
    pub status: ConvergencePublicationRunnerEvidencePersistenceStatus,
    pub blockers: Vec<ConvergencePublicationRunnerEvidencePersistenceBlocker>,
    pub duplicate_evidence_detected: bool,
    #[serde(flatten)]
    pub no_effects: ConvergenceRunnerNoAuthority,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergencePublicationRunnerEvidencePersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergencePublicationRunnerEvidencePersistenceBlocker {
    EvidenceNotReviewable,
    RawMaterialPresent,
    RunnerInvocationRequested,
    ProviderHandoffRequested,
    SnapshotCreationRequested,
    PublishRequested,
    PublicationReviewRequested,
    ProviderWriteRequested,
    TaskMutationRequested,
}

pub fn convergence_publication_runner_evidence_persistence(
    input: ConvergencePublicationRunnerEvidencePersistenceInput,
) -> ConvergencePublicationRunnerEvidencePersistenceSet {
    let existing_evidence_ids = input.existing_evidence_ids.clone();
    let flags = PersistenceFlags {
        raw_material_present: input.raw_material_present,
        runner_invocation_requested: input.runner_invocation_requested,
        provider_handoff_requested: input.provider_handoff_requested,
        snapshot_creation_requested: input.snapshot_creation_requested,
        publish_requested: input.publish_requested,
        publication_review_requested: input.publication_review_requested,
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

    ConvergencePublicationRunnerEvidencePersistenceSet {
        persistence_set_id: "convergence-publication-runner-evidence-persistence".to_owned(),
        duplicate_evidence_ids: records
            .iter()
            .filter(|record| record.duplicate_evidence_detected)
            .map(|record| record.evidence_id.clone())
            .collect(),
        blocked_evidence_ids: records
            .iter()
            .filter(|record| {
                record.status == ConvergencePublicationRunnerEvidencePersistenceStatus::Blocked
            })
            .map(|record| record.evidence_id.clone())
            .collect(),
        records,
        no_effects: ConvergenceRunnerNoAuthority::none(),
    }
}

fn persistence_record(
    flags: &PersistenceFlags,
    existing_evidence_ids: &[String],
    evidence: ConvergencePublicationRunnerEvidenceRecord,
) -> ConvergencePublicationRunnerEvidencePersistenceRecord {
    let persisted_evidence_id = format!(
        "convergence-publication-runner-evidence:{}",
        evidence.evidence_id
    );
    let duplicate_evidence_detected = existing_evidence_ids.contains(&persisted_evidence_id);
    let blockers = if duplicate_evidence_detected {
        Vec::new()
    } else {
        blockers(flags, &evidence)
    };
    let status = if duplicate_evidence_detected {
        ConvergencePublicationRunnerEvidencePersistenceStatus::DuplicateNoop
    } else if blockers.is_empty() {
        ConvergencePublicationRunnerEvidencePersistenceStatus::Persisted
    } else {
        ConvergencePublicationRunnerEvidencePersistenceStatus::Blocked
    };

    ConvergencePublicationRunnerEvidencePersistenceRecord {
        persisted_evidence_id,
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
        evidence_status: evidence.status,
        status,
        blockers,
        duplicate_evidence_detected,
        no_effects: ConvergenceRunnerNoAuthority::none(),
    }
}

fn blockers(
    flags: &PersistenceFlags,
    evidence: &ConvergencePublicationRunnerEvidenceRecord,
) -> Vec<ConvergencePublicationRunnerEvidencePersistenceBlocker> {
    let mut blockers = Vec::new();
    if evidence.status != ConvergencePublicationRunnerEvidenceStatus::Reviewable {
        blockers
            .push(ConvergencePublicationRunnerEvidencePersistenceBlocker::EvidenceNotReviewable);
    }
    if flags.raw_material_present || evidence.raw_output_retained {
        blockers.push(ConvergencePublicationRunnerEvidencePersistenceBlocker::RawMaterialPresent);
    }
    if flags.runner_invocation_requested || evidence.runner_invoked {
        blockers.push(
            ConvergencePublicationRunnerEvidencePersistenceBlocker::RunnerInvocationRequested,
        );
    }
    if flags.provider_handoff_requested || evidence.provider_handoff_created {
        blockers
            .push(ConvergencePublicationRunnerEvidencePersistenceBlocker::ProviderHandoffRequested);
    }
    if flags.snapshot_creation_requested || evidence.snapshot_creation_executed {
        blockers.push(
            ConvergencePublicationRunnerEvidencePersistenceBlocker::SnapshotCreationRequested,
        );
    }
    if flags.publish_requested || evidence.publish_executed {
        blockers.push(ConvergencePublicationRunnerEvidencePersistenceBlocker::PublishRequested);
    }
    if flags.publication_review_requested || evidence.publication_review_executed {
        blockers.push(
            ConvergencePublicationRunnerEvidencePersistenceBlocker::PublicationReviewRequested,
        );
    }
    if flags.provider_write_requested || evidence.provider_write_executed {
        blockers
            .push(ConvergencePublicationRunnerEvidencePersistenceBlocker::ProviderWriteRequested);
    }
    if flags.task_mutation_requested || evidence.task_mutation_executed {
        blockers
            .push(ConvergencePublicationRunnerEvidencePersistenceBlocker::TaskMutationRequested);
    }
    blockers
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PersistenceFlags {
    raw_material_present: bool,
    runner_invocation_requested: bool,
    provider_handoff_requested: bool,
    snapshot_creation_requested: bool,
    publish_requested: bool,
    publication_review_requested: bool,
    provider_write_requested: bool,
    task_mutation_requested: bool,
}

#[cfg(test)]
#[path = "provider_convergence_publication_runner_evidence_persistence/tests.rs"]
mod tests;
