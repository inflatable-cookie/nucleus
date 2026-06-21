//! Stopped-by-default Convergence-like publication admissions.

use serde::{Deserialize, Serialize};

use crate::{
    AdapterNeutralChangeRequestChainPersistenceRecord,
    AdapterNeutralChangeRequestChainPersistenceSet,
    AdapterNeutralChangeRequestChainPersistenceStatus, AdapterNeutralChangeRequestProviderStageRef,
    AdapterNeutralChangeRequestStageKind, ConvergenceLikeChangeRequestProviderStageKind,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergencePublicationAdmissionInput {
    pub persisted_chains: AdapterNeutralChangeRequestChainPersistenceSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergencePublicationAdmissionSet {
    pub admission_set_id: String,
    pub admissions: Vec<ConvergencePublicationAdmissionRecord>,
    pub skipped_persisted_projection_ids: Vec<String>,
    pub snapshot_creation_permitted: bool,
    pub publish_permitted: bool,
    pub publication_review_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub callback_response_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergencePublicationAdmissionRecord {
    pub admission_id: String,
    pub persisted_projection_id: String,
    pub projection_id: String,
    pub task_ids: Vec<String>,
    pub repo_ids: Vec<String>,
    pub operator_refs: Vec<String>,
    pub snapshot_stage_refs: Vec<String>,
    pub publish_stage_refs: Vec<String>,
    pub publication_review_stage_refs: Vec<String>,
    pub status: ConvergencePublicationAdmissionStatus,
    pub blockers: Vec<ConvergencePublicationAdmissionBlocker>,
    pub snapshot_creation_permitted: bool,
    pub publish_permitted: bool,
    pub publication_review_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub callback_response_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergencePublicationAdmissionStatus {
    Admitted,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergencePublicationAdmissionBlocker {
    PersistenceNotReady,
    DuplicateProjection,
    MissingSnapshotStage,
    MissingPublishStage,
    MissingPublicationReviewStage,
    GitLikeStagePresent,
}

pub fn convergence_publication_admission(
    input: ConvergencePublicationAdmissionInput,
) -> ConvergencePublicationAdmissionSet {
    let mut admissions = input
        .persisted_chains
        .records
        .into_iter()
        .map(admission_record)
        .collect::<Vec<_>>();
    admissions.sort_by(|left, right| left.admission_id.cmp(&right.admission_id));

    ConvergencePublicationAdmissionSet {
        admission_set_id: "convergence-publication-admission".to_owned(),
        skipped_persisted_projection_ids: admissions
            .iter()
            .filter(|admission| admission.status != ConvergencePublicationAdmissionStatus::Admitted)
            .map(|admission| admission.persisted_projection_id.clone())
            .collect(),
        admissions,
        snapshot_creation_permitted: false,
        publish_permitted: false,
        publication_review_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        callback_response_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        raw_output_retained: false,
    }
}

fn admission_record(
    record: AdapterNeutralChangeRequestChainPersistenceRecord,
) -> ConvergencePublicationAdmissionRecord {
    let snapshot_stage_refs = provider_stage_refs(
        &record,
        ConvergenceLikeChangeRequestProviderStageKind::Snapshot,
    );
    let publish_stage_refs = provider_stage_refs(
        &record,
        ConvergenceLikeChangeRequestProviderStageKind::Publish,
    );
    let publication_review_stage_refs = provider_stage_refs(
        &record,
        ConvergenceLikeChangeRequestProviderStageKind::PublicationReview,
    );
    let blockers = blockers(
        &record,
        &snapshot_stage_refs,
        &publish_stage_refs,
        &publication_review_stage_refs,
    );
    let status = if blockers.is_empty() {
        ConvergencePublicationAdmissionStatus::Admitted
    } else {
        ConvergencePublicationAdmissionStatus::Blocked
    };

    ConvergencePublicationAdmissionRecord {
        admission_id: format!(
            "convergence-publication-admission:{}",
            record.persisted_projection_id
        ),
        persisted_projection_id: record.persisted_projection_id,
        projection_id: record.projection_id,
        task_ids: unique_sorted(
            record
                .stages
                .iter()
                .map(|stage| stage.task_id.clone())
                .collect(),
        ),
        repo_ids: unique_sorted(
            record
                .stages
                .iter()
                .map(|stage| stage.repo_id.clone())
                .collect(),
        ),
        operator_refs: unique_sorted(
            record
                .stages
                .iter()
                .map(|stage| stage.operator_ref.clone())
                .collect(),
        ),
        snapshot_stage_refs,
        publish_stage_refs,
        publication_review_stage_refs,
        status,
        blockers,
        snapshot_creation_permitted: false,
        publish_permitted: false,
        publication_review_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        callback_response_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        raw_output_retained: false,
    }
}

fn provider_stage_refs(
    record: &AdapterNeutralChangeRequestChainPersistenceRecord,
    provider_kind: ConvergenceLikeChangeRequestProviderStageKind,
) -> Vec<String> {
    let mut refs = record
        .stages
        .iter()
        .filter_map(|stage| match &stage.provider_ref {
            AdapterNeutralChangeRequestProviderStageRef::ConvergenceLike {
                stage_kind,
                provider_record_ref,
            } if stage_kind == &provider_kind => Some(provider_record_ref.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    refs.sort();
    refs.dedup();
    refs
}

fn blockers(
    record: &AdapterNeutralChangeRequestChainPersistenceRecord,
    snapshot_stage_refs: &[String],
    publish_stage_refs: &[String],
    publication_review_stage_refs: &[String],
) -> Vec<ConvergencePublicationAdmissionBlocker> {
    let mut blockers = Vec::new();
    if record.status != AdapterNeutralChangeRequestChainPersistenceStatus::Persisted {
        blockers.push(ConvergencePublicationAdmissionBlocker::PersistenceNotReady);
    }
    if record.duplicate_projection_detected {
        blockers.push(ConvergencePublicationAdmissionBlocker::DuplicateProjection);
    }
    if snapshot_stage_refs.is_empty() {
        blockers.push(ConvergencePublicationAdmissionBlocker::MissingSnapshotStage);
    }
    if publish_stage_refs.is_empty() {
        blockers.push(ConvergencePublicationAdmissionBlocker::MissingPublishStage);
    }
    if publication_review_stage_refs.is_empty() {
        blockers.push(ConvergencePublicationAdmissionBlocker::MissingPublicationReviewStage);
    }
    if record.stages.iter().any(|stage| {
        matches!(
            stage.provider_ref,
            AdapterNeutralChangeRequestProviderStageRef::GitLike { .. }
        ) && stage.neutral_stage != AdapterNeutralChangeRequestStageKind::Unsupported
    }) {
        blockers.push(ConvergencePublicationAdmissionBlocker::GitLikeStagePresent);
    }
    blockers
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
#[path = "provider_convergence_publication_admission/tests.rs"]
mod tests;
