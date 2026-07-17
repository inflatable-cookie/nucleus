//! Persistence records for stopped Convergence local snap requests.

use crate::provider_no_effects::{ConvergenceSnapNoAuthority};
use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceLocalSnapStoppedRequestRecord, ConvergenceLocalSnapStoppedRequestSet,
    ConvergenceLocalSnapStoppedRequestStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergenceLocalSnapRequestPersistenceInput {
    pub requests: ConvergenceLocalSnapStoppedRequestSet,
    pub existing_idempotency_keys: Vec<String>,
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
pub struct ConvergenceLocalSnapRequestPersistenceSet {
    pub persistence_set_id: String,
    pub records: Vec<ConvergenceLocalSnapRequestPersistenceRecord>,
    pub duplicate_idempotency_keys: Vec<String>,
    pub blocked_request_ids: Vec<String>,
    #[serde(flatten)]
    pub no_effects: ConvergenceSnapNoAuthority,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapRequestPersistenceRecord {
    pub persisted_request_id: String,
    pub stopped_request_id: String,
    pub idempotency_key: String,
    pub descriptor_id: String,
    pub admission_id: String,
    pub replay_record_id: String,
    pub adapter_record_id: String,
    pub persisted_evidence_id: String,
    pub evidence_id: String,
    pub proof_id: String,
    pub source_persisted_request_id: String,
    pub source_request_id: String,
    pub task_ids: Vec<String>,
    pub repo_ids: Vec<String>,
    pub source_authority_ref: String,
    pub execution_authority_ref: String,
    pub local_snap_descriptor_ref: Option<String>,
    pub request_status: ConvergenceLocalSnapStoppedRequestStatus,
    pub status: ConvergenceLocalSnapRequestPersistenceStatus,
    pub blockers: Vec<ConvergenceLocalSnapRequestPersistenceBlocker>,
    pub duplicate_idempotency_detected: bool,
    #[serde(flatten)]
    pub no_effects: ConvergenceSnapNoAuthority,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapRequestPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapRequestPersistenceBlocker {
    RequestNotStopped,
    RawMaterialPresent,
    CommandSpawnRequested,
    LocalSnapCreationRequested,
    ObjectUploadRequested,
    PublicationRequested,
    LaneSyncRequested,
    ProviderWriteRequested,
    TaskMutationRequested,
}

pub fn convergence_local_snap_request_persistence(
    input: ConvergenceLocalSnapRequestPersistenceInput,
) -> ConvergenceLocalSnapRequestPersistenceSet {
    let existing_idempotency_keys = input.existing_idempotency_keys;
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
        .requests
        .requests
        .into_iter()
        .map(|request| persistence_record(&flags, &existing_idempotency_keys, request))
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.persisted_request_id.cmp(&right.persisted_request_id));

    ConvergenceLocalSnapRequestPersistenceSet {
        persistence_set_id: "convergence-local-snap-request-persistence".to_owned(),
        duplicate_idempotency_keys: records
            .iter()
            .filter(|record| record.duplicate_idempotency_detected)
            .map(|record| record.idempotency_key.clone())
            .collect(),
        blocked_request_ids: records
            .iter()
            .filter(|record| record.status == ConvergenceLocalSnapRequestPersistenceStatus::Blocked)
            .map(|record| record.stopped_request_id.clone())
            .collect(),
        records,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}

fn persistence_record(
    flags: &PersistenceFlags,
    existing_idempotency_keys: &[String],
    request: ConvergenceLocalSnapStoppedRequestRecord,
) -> ConvergenceLocalSnapRequestPersistenceRecord {
    let duplicate_idempotency_detected =
        existing_idempotency_keys.contains(&request.idempotency_key);
    let blockers = if duplicate_idempotency_detected {
        Vec::new()
    } else {
        blockers(flags, &request)
    };
    let status = if duplicate_idempotency_detected {
        ConvergenceLocalSnapRequestPersistenceStatus::DuplicateNoop
    } else if blockers.is_empty() {
        ConvergenceLocalSnapRequestPersistenceStatus::Persisted
    } else {
        ConvergenceLocalSnapRequestPersistenceStatus::Blocked
    };

    ConvergenceLocalSnapRequestPersistenceRecord {
        persisted_request_id: format!("convergence-local-snap-request:{}", request.idempotency_key),
        stopped_request_id: request.stopped_request_id,
        idempotency_key: request.idempotency_key,
        descriptor_id: request.descriptor_id,
        admission_id: request.admission_id,
        replay_record_id: request.replay_record_id,
        adapter_record_id: request.adapter_record_id,
        persisted_evidence_id: request.persisted_evidence_id,
        evidence_id: request.evidence_id,
        proof_id: request.proof_id,
        source_persisted_request_id: request.persisted_request_id,
        source_request_id: request.source_request_id,
        task_ids: request.task_ids,
        repo_ids: request.repo_ids,
        source_authority_ref: request.source_authority_ref,
        execution_authority_ref: request.execution_authority_ref,
        local_snap_descriptor_ref: request.local_snap_descriptor_ref,
        request_status: request.status,
        status,
        blockers,
        duplicate_idempotency_detected,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}

fn blockers(
    flags: &PersistenceFlags,
    request: &ConvergenceLocalSnapStoppedRequestRecord,
) -> Vec<ConvergenceLocalSnapRequestPersistenceBlocker> {
    let mut blockers = Vec::new();
    if request.status != ConvergenceLocalSnapStoppedRequestStatus::Stopped {
        blockers.push(ConvergenceLocalSnapRequestPersistenceBlocker::RequestNotStopped);
    }
    if flags.raw_material_present || request.raw_output_retained {
        blockers.push(ConvergenceLocalSnapRequestPersistenceBlocker::RawMaterialPresent);
    }
    if flags.command_spawn_requested || request.command_spawned {
        blockers.push(ConvergenceLocalSnapRequestPersistenceBlocker::CommandSpawnRequested);
    }
    if flags.local_snap_creation_requested || request.local_snap_creation_executed {
        blockers.push(ConvergenceLocalSnapRequestPersistenceBlocker::LocalSnapCreationRequested);
    }
    if flags.object_upload_requested || request.object_upload_permitted {
        blockers.push(ConvergenceLocalSnapRequestPersistenceBlocker::ObjectUploadRequested);
    }
    if flags.publication_requested || request.publication_permitted {
        blockers.push(ConvergenceLocalSnapRequestPersistenceBlocker::PublicationRequested);
    }
    if flags.lane_sync_requested || request.lane_sync_permitted {
        blockers.push(ConvergenceLocalSnapRequestPersistenceBlocker::LaneSyncRequested);
    }
    if flags.provider_write_requested || request.provider_write_permitted {
        blockers.push(ConvergenceLocalSnapRequestPersistenceBlocker::ProviderWriteRequested);
    }
    if flags.task_mutation_requested || request.task_mutation_permitted {
        blockers.push(ConvergenceLocalSnapRequestPersistenceBlocker::TaskMutationRequested);
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
#[path = "provider_convergence_local_snap_request_persistence/tests.rs"]
mod tests;
