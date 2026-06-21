//! Persistence records for Convergence-like stopped publication requests.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergencePublicationStoppedRequestRecord, ConvergencePublicationStoppedRequestSet,
    ConvergencePublicationStoppedRequestStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergencePublicationRequestPersistenceInput {
    pub requests: ConvergencePublicationStoppedRequestSet,
    pub existing_idempotency_keys: Vec<String>,
    pub raw_material_present: bool,
    pub provider_handoff_requested: bool,
    pub snapshot_creation_requested: bool,
    pub publish_requested: bool,
    pub publication_review_requested: bool,
    pub provider_write_requested: bool,
    pub task_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergencePublicationRequestPersistenceSet {
    pub persistence_set_id: String,
    pub records: Vec<ConvergencePublicationRequestPersistenceRecord>,
    pub duplicate_idempotency_keys: Vec<String>,
    pub blocked_request_ids: Vec<String>,
    pub provider_handoff_permitted: bool,
    pub snapshot_creation_permitted: bool,
    pub publish_permitted: bool,
    pub publication_review_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergencePublicationRequestPersistenceRecord {
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
    pub request_status: ConvergencePublicationStoppedRequestStatus,
    pub status: ConvergencePublicationRequestPersistenceStatus,
    pub blockers: Vec<ConvergencePublicationRequestPersistenceBlocker>,
    pub duplicate_idempotency_detected: bool,
    pub provider_handoff_permitted: bool,
    pub snapshot_creation_permitted: bool,
    pub publish_permitted: bool,
    pub publication_review_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergencePublicationRequestPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergencePublicationRequestPersistenceBlocker {
    RequestNotStopped,
    RawMaterialPresent,
    ProviderHandoffRequested,
    SnapshotCreationRequested,
    PublishRequested,
    PublicationReviewRequested,
    ProviderWriteRequested,
    TaskMutationRequested,
}

pub fn convergence_publication_request_persistence(
    input: ConvergencePublicationRequestPersistenceInput,
) -> ConvergencePublicationRequestPersistenceSet {
    let existing_idempotency_keys = input.existing_idempotency_keys.clone();
    let flags = PersistenceFlags {
        raw_material_present: input.raw_material_present,
        provider_handoff_requested: input.provider_handoff_requested,
        snapshot_creation_requested: input.snapshot_creation_requested,
        publish_requested: input.publish_requested,
        publication_review_requested: input.publication_review_requested,
        provider_write_requested: input.provider_write_requested,
        task_mutation_requested: input.task_mutation_requested,
    };
    let mut records = input
        .requests
        .requests
        .into_iter()
        .map(|request| persistence_record(&flags, &existing_idempotency_keys, request))
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.persisted_request_id.cmp(&right.persisted_request_id));

    ConvergencePublicationRequestPersistenceSet {
        persistence_set_id: "convergence-publication-request-persistence".to_owned(),
        duplicate_idempotency_keys: records
            .iter()
            .filter(|record| record.duplicate_idempotency_detected)
            .map(|record| record.idempotency_key.clone())
            .collect(),
        blocked_request_ids: records
            .iter()
            .filter(|record| {
                record.status == ConvergencePublicationRequestPersistenceStatus::Blocked
            })
            .map(|record| record.request_id.clone())
            .collect(),
        records,
        provider_handoff_permitted: false,
        snapshot_creation_permitted: false,
        publish_permitted: false,
        publication_review_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}

fn persistence_record(
    flags: &PersistenceFlags,
    existing_idempotency_keys: &[String],
    request: ConvergencePublicationStoppedRequestRecord,
) -> ConvergencePublicationRequestPersistenceRecord {
    let duplicate_idempotency_detected =
        existing_idempotency_keys.contains(&request.idempotency_key);
    let blockers = if duplicate_idempotency_detected {
        Vec::new()
    } else {
        blockers(flags, &request)
    };
    let status = if duplicate_idempotency_detected {
        ConvergencePublicationRequestPersistenceStatus::DuplicateNoop
    } else if blockers.is_empty() {
        ConvergencePublicationRequestPersistenceStatus::Persisted
    } else {
        ConvergencePublicationRequestPersistenceStatus::Blocked
    };

    ConvergencePublicationRequestPersistenceRecord {
        persisted_request_id: format!(
            "convergence-publication-request:{}",
            request.idempotency_key
        ),
        request_id: request.request_id,
        idempotency_key: request.idempotency_key,
        descriptor_id: request.descriptor_id,
        preflight_id: request.preflight_id,
        admission_id: request.admission_id,
        persisted_projection_id: request.persisted_projection_id,
        projection_id: request.projection_id,
        task_ids: request.task_ids,
        repo_ids: request.repo_ids,
        operator_refs: request.operator_refs,
        snapshot_stage_refs: request.snapshot_stage_refs,
        publish_stage_refs: request.publish_stage_refs,
        publication_review_stage_refs: request.publication_review_stage_refs,
        request_status: request.status,
        status,
        blockers,
        duplicate_idempotency_detected,
        provider_handoff_permitted: false,
        snapshot_creation_permitted: false,
        publish_permitted: false,
        publication_review_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}

fn blockers(
    flags: &PersistenceFlags,
    request: &ConvergencePublicationStoppedRequestRecord,
) -> Vec<ConvergencePublicationRequestPersistenceBlocker> {
    let mut blockers = Vec::new();
    if request.status != ConvergencePublicationStoppedRequestStatus::Stopped {
        blockers.push(ConvergencePublicationRequestPersistenceBlocker::RequestNotStopped);
    }
    if flags.raw_material_present || request.raw_output_retained {
        blockers.push(ConvergencePublicationRequestPersistenceBlocker::RawMaterialPresent);
    }
    if flags.provider_handoff_requested || request.provider_handoff_created {
        blockers.push(ConvergencePublicationRequestPersistenceBlocker::ProviderHandoffRequested);
    }
    if flags.snapshot_creation_requested || request.snapshot_creation_executed {
        blockers.push(ConvergencePublicationRequestPersistenceBlocker::SnapshotCreationRequested);
    }
    if flags.publish_requested || request.publish_executed {
        blockers.push(ConvergencePublicationRequestPersistenceBlocker::PublishRequested);
    }
    if flags.publication_review_requested || request.publication_review_executed {
        blockers.push(ConvergencePublicationRequestPersistenceBlocker::PublicationReviewRequested);
    }
    if flags.provider_write_requested || request.provider_write_executed {
        blockers.push(ConvergencePublicationRequestPersistenceBlocker::ProviderWriteRequested);
    }
    if flags.task_mutation_requested || request.task_mutation_executed {
        blockers.push(ConvergencePublicationRequestPersistenceBlocker::TaskMutationRequested);
    }
    blockers
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PersistenceFlags {
    raw_material_present: bool,
    provider_handoff_requested: bool,
    snapshot_creation_requested: bool,
    publish_requested: bool,
    publication_review_requested: bool,
    provider_write_requested: bool,
    task_mutation_requested: bool,
}

#[cfg(test)]
#[path = "provider_convergence_publication_request_persistence/tests.rs"]
mod tests;
