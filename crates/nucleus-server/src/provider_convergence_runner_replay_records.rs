//! Replay records for stopped Convergence runner adapter decisions.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceStoppedRunnerCommandAdapterRecord, ConvergenceStoppedRunnerCommandAdapterSet,
    ConvergenceStoppedRunnerCommandAdapterStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergenceRunnerReplayRecordsInput {
    pub adapter: ConvergenceStoppedRunnerCommandAdapterSet,
    pub existing_replay_record_ids: Vec<String>,
    pub raw_material_present: bool,
    pub backend_effect_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceRunnerReplayRecordSet {
    pub replay_set_id: String,
    pub records: Vec<ConvergenceRunnerReplayRecord>,
    pub duplicate_replay_record_ids: Vec<String>,
    pub blocked_replay_record_ids: Vec<String>,
    pub unsupported_replay_record_ids: Vec<String>,
    pub backend_effect_permitted: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub bundle_permitted: bool,
    pub approval_permitted: bool,
    pub promotion_permitted: bool,
    pub release_permitted: bool,
    pub resolution_publication_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceRunnerReplayRecord {
    pub replay_record_id: String,
    pub adapter_record_id: String,
    pub persisted_evidence_id: String,
    pub evidence_id: String,
    pub proof_id: String,
    pub persisted_request_id: String,
    pub request_id: String,
    pub idempotency_key: String,
    pub task_ids: Vec<String>,
    pub repo_ids: Vec<String>,
    pub effect_families: Vec<ConvergenceRunnerReplayEffectFamily>,
    pub provider_refs: ConvergenceRunnerReplayProviderRefs,
    pub status: ConvergenceRunnerReplayStatus,
    pub blockers: Vec<ConvergenceRunnerReplayBlocker>,
    pub duplicate_replay_detected: bool,
    pub backend_effect_permitted: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub bundle_permitted: bool,
    pub approval_permitted: bool,
    pub promotion_permitted: bool,
    pub release_permitted: bool,
    pub resolution_publication_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceRunnerReplayProviderRefs {
    pub snap_id: Option<String>,
    pub root_manifest_ref: Option<String>,
    pub scope_id: Option<String>,
    pub gate_id: Option<String>,
    pub lane_id: Option<String>,
    pub publication_id: Option<String>,
    pub bundle_id: Option<String>,
    pub promotion_id: Option<String>,
    pub release_channel: Option<String>,
    pub publisher_user_id: Option<String>,
    pub metadata_only: Option<bool>,
    pub resolution_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceRunnerReplayEffectFamily {
    LocalSnapCreation,
    ObjectUpload,
    PublicationCreation,
    LaneHeadSync,
    BundleCreation,
    BundleApproval,
    BundlePromotion,
    ReleaseCreation,
    ResolutionPublication,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceRunnerReplayStatus {
    Replayed,
    DuplicateNoop,
    Blocked,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceRunnerReplayBlocker {
    AdapterRecordNotRunnable,
    DuplicateReplayRecord,
    BackendEffectRequested,
    RawMaterialPresent,
}

pub fn convergence_runner_replay_records(
    input: ConvergenceRunnerReplayRecordsInput,
) -> ConvergenceRunnerReplayRecordSet {
    let existing_replay_record_ids = input.existing_replay_record_ids;
    let mut records = input
        .adapter
        .records
        .into_iter()
        .map(|record| {
            replay_record(
                record,
                &existing_replay_record_ids,
                input.raw_material_present,
                input.backend_effect_requested,
            )
        })
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.replay_record_id.cmp(&right.replay_record_id));

    ConvergenceRunnerReplayRecordSet {
        replay_set_id: "convergence-runner-replay-records".to_owned(),
        duplicate_replay_record_ids: records
            .iter()
            .filter(|record| record.duplicate_replay_detected)
            .map(|record| record.replay_record_id.clone())
            .collect(),
        blocked_replay_record_ids: records
            .iter()
            .filter(|record| record.status == ConvergenceRunnerReplayStatus::Blocked)
            .map(|record| record.replay_record_id.clone())
            .collect(),
        unsupported_replay_record_ids: records
            .iter()
            .filter(|record| record.status == ConvergenceRunnerReplayStatus::Unsupported)
            .map(|record| record.replay_record_id.clone())
            .collect(),
        records,
        backend_effect_permitted: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        bundle_permitted: false,
        approval_permitted: false,
        promotion_permitted: false,
        release_permitted: false,
        resolution_publication_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}

fn replay_record(
    adapter: ConvergenceStoppedRunnerCommandAdapterRecord,
    existing_replay_record_ids: &[String],
    raw_material_present: bool,
    backend_effect_requested: bool,
) -> ConvergenceRunnerReplayRecord {
    let replay_record_id = format!("convergence-runner-replay:{}", adapter.adapter_record_id);
    let duplicate_replay_detected = existing_replay_record_ids.contains(&replay_record_id);
    let blockers = blockers(
        &adapter,
        duplicate_replay_detected,
        raw_material_present,
        backend_effect_requested,
    );
    let status = status(&adapter, duplicate_replay_detected, &blockers);

    ConvergenceRunnerReplayRecord {
        replay_record_id,
        adapter_record_id: adapter.adapter_record_id,
        persisted_evidence_id: adapter.persisted_evidence_id,
        evidence_id: adapter.evidence_id,
        proof_id: adapter.proof_id,
        persisted_request_id: adapter.persisted_request_id,
        request_id: adapter.request_id,
        idempotency_key: adapter.idempotency_key,
        task_ids: adapter.task_ids,
        repo_ids: adapter.repo_ids,
        effect_families: convergence_effect_families(),
        provider_refs: ConvergenceRunnerReplayProviderRefs {
            snap_id: None,
            root_manifest_ref: None,
            scope_id: None,
            gate_id: None,
            lane_id: None,
            publication_id: None,
            bundle_id: None,
            promotion_id: None,
            release_channel: None,
            publisher_user_id: None,
            metadata_only: None,
            resolution_ref: None,
        },
        status,
        blockers,
        duplicate_replay_detected,
        backend_effect_permitted: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        bundle_permitted: false,
        approval_permitted: false,
        promotion_permitted: false,
        release_permitted: false,
        resolution_publication_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}

fn status(
    adapter: &ConvergenceStoppedRunnerCommandAdapterRecord,
    duplicate_replay_detected: bool,
    blockers: &[ConvergenceRunnerReplayBlocker],
) -> ConvergenceRunnerReplayStatus {
    if duplicate_replay_detected {
        ConvergenceRunnerReplayStatus::DuplicateNoop
    } else if adapter.status == ConvergenceStoppedRunnerCommandAdapterStatus::Unsupported {
        ConvergenceRunnerReplayStatus::Unsupported
    } else if !blockers.is_empty() {
        ConvergenceRunnerReplayStatus::Blocked
    } else {
        ConvergenceRunnerReplayStatus::Replayed
    }
}

fn blockers(
    adapter: &ConvergenceStoppedRunnerCommandAdapterRecord,
    duplicate_replay_detected: bool,
    raw_material_present: bool,
    backend_effect_requested: bool,
) -> Vec<ConvergenceRunnerReplayBlocker> {
    let mut blockers = Vec::new();
    if duplicate_replay_detected {
        blockers.push(ConvergenceRunnerReplayBlocker::DuplicateReplayRecord);
    }
    if adapter.status != ConvergenceStoppedRunnerCommandAdapterStatus::Runnable
        && adapter.status != ConvergenceStoppedRunnerCommandAdapterStatus::Unsupported
    {
        blockers.push(ConvergenceRunnerReplayBlocker::AdapterRecordNotRunnable);
    }
    if backend_effect_requested {
        blockers.push(ConvergenceRunnerReplayBlocker::BackendEffectRequested);
    }
    if raw_material_present {
        blockers.push(ConvergenceRunnerReplayBlocker::RawMaterialPresent);
    }
    blockers
}

fn convergence_effect_families() -> Vec<ConvergenceRunnerReplayEffectFamily> {
    vec![
        ConvergenceRunnerReplayEffectFamily::LocalSnapCreation,
        ConvergenceRunnerReplayEffectFamily::ObjectUpload,
        ConvergenceRunnerReplayEffectFamily::PublicationCreation,
        ConvergenceRunnerReplayEffectFamily::LaneHeadSync,
        ConvergenceRunnerReplayEffectFamily::BundleCreation,
        ConvergenceRunnerReplayEffectFamily::BundleApproval,
        ConvergenceRunnerReplayEffectFamily::BundlePromotion,
        ConvergenceRunnerReplayEffectFamily::ReleaseCreation,
        ConvergenceRunnerReplayEffectFamily::ResolutionPublication,
    ]
}

#[cfg(test)]
#[path = "provider_convergence_runner_replay_records/tests.rs"]
mod tests;
