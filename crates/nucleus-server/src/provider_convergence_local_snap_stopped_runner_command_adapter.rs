//! Stopped command-adapter records for Convergence local snap runner evidence.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceLocalSnapRunnerEvidencePersistenceRecord,
    ConvergenceLocalSnapRunnerEvidencePersistenceSet,
    ConvergenceLocalSnapRunnerEvidencePersistenceStatus, ConvergenceLocalSnapRunnerEvidenceStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergenceLocalSnapStoppedRunnerCommandAdapterInput {
    pub persistence: ConvergenceLocalSnapRunnerEvidencePersistenceSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapStoppedRunnerCommandAdapterSet {
    pub adapter_set_id: String,
    pub records: Vec<ConvergenceLocalSnapStoppedRunnerCommandAdapterRecord>,
    pub skipped_persisted_evidence_ids: Vec<String>,
    pub command_spawn_permitted: bool,
    pub local_snap_creation_permitted: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapStoppedRunnerCommandAdapterRecord {
    pub adapter_record_id: String,
    pub persisted_evidence_id: String,
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
    pub adapter_kind: ConvergenceLocalSnapStoppedRunnerCommandAdapterKind,
    pub command_shape: ConvergenceLocalSnapStoppedRunnerCommandShape,
    pub status: ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus,
    pub blockers: Vec<ConvergenceLocalSnapStoppedRunnerCommandAdapterBlocker>,
    pub command_spawn_permitted: bool,
    pub local_snap_creation_permitted: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapStoppedRunnerCommandAdapterKind {
    StoppedProof,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapStoppedRunnerCommandShape {
    ConvergeSnap,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus {
    Runnable,
    Blocked,
    DuplicateNoop,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapStoppedRunnerCommandAdapterBlocker {
    EvidencePersistenceNotReady,
    DuplicateEvidence,
    EvidenceNotReviewable,
    MissingLocalSnapDescriptor,
}

pub fn convergence_local_snap_stopped_runner_command_adapter(
    input: ConvergenceLocalSnapStoppedRunnerCommandAdapterInput,
) -> ConvergenceLocalSnapStoppedRunnerCommandAdapterSet {
    let mut records = input
        .persistence
        .records
        .into_iter()
        .map(adapter_record)
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.adapter_record_id.cmp(&right.adapter_record_id));

    ConvergenceLocalSnapStoppedRunnerCommandAdapterSet {
        adapter_set_id: "convergence-local-snap-stopped-runner-command-adapter".to_owned(),
        skipped_persisted_evidence_ids: records
            .iter()
            .filter(|record| {
                record.status != ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Runnable
            })
            .map(|record| record.persisted_evidence_id.clone())
            .collect(),
        records,
        command_spawn_permitted: false,
        local_snap_creation_permitted: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}

fn adapter_record(
    evidence: ConvergenceLocalSnapRunnerEvidencePersistenceRecord,
) -> ConvergenceLocalSnapStoppedRunnerCommandAdapterRecord {
    let blockers = adapter_blockers(&evidence);
    let status = adapter_status(&evidence, &blockers);

    ConvergenceLocalSnapStoppedRunnerCommandAdapterRecord {
        adapter_record_id: format!(
            "convergence-local-snap-stopped-runner-command:{}",
            evidence.persisted_evidence_id
        ),
        persisted_evidence_id: evidence.persisted_evidence_id,
        evidence_id: evidence.evidence_id,
        proof_id: evidence.proof_id,
        persisted_request_id: evidence.persisted_request_id,
        stopped_request_id: evidence.stopped_request_id,
        idempotency_key: evidence.idempotency_key,
        descriptor_id: evidence.descriptor_id,
        admission_id: evidence.admission_id,
        replay_record_id: evidence.replay_record_id,
        task_ids: evidence.task_ids,
        repo_ids: evidence.repo_ids,
        source_authority_ref: evidence.source_authority_ref,
        execution_authority_ref: evidence.execution_authority_ref,
        inspected_ref_count: evidence.inspected_ref_count,
        local_snap_descriptor_present: evidence.local_snap_descriptor_present,
        adapter_kind: ConvergenceLocalSnapStoppedRunnerCommandAdapterKind::StoppedProof,
        command_shape: ConvergenceLocalSnapStoppedRunnerCommandShape::ConvergeSnap,
        status,
        blockers,
        command_spawn_permitted: false,
        local_snap_creation_permitted: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}

fn adapter_status(
    evidence: &ConvergenceLocalSnapRunnerEvidencePersistenceRecord,
    blockers: &[ConvergenceLocalSnapStoppedRunnerCommandAdapterBlocker],
) -> ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus {
    if evidence.status == ConvergenceLocalSnapRunnerEvidencePersistenceStatus::DuplicateNoop {
        ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::DuplicateNoop
    } else if !blockers.is_empty() {
        ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Blocked
    } else {
        ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Runnable
    }
}

fn adapter_blockers(
    evidence: &ConvergenceLocalSnapRunnerEvidencePersistenceRecord,
) -> Vec<ConvergenceLocalSnapStoppedRunnerCommandAdapterBlocker> {
    let mut blockers = Vec::new();
    if evidence.status == ConvergenceLocalSnapRunnerEvidencePersistenceStatus::DuplicateNoop {
        blockers.push(ConvergenceLocalSnapStoppedRunnerCommandAdapterBlocker::DuplicateEvidence);
        return blockers;
    }
    if evidence.status != ConvergenceLocalSnapRunnerEvidencePersistenceStatus::Persisted {
        blockers.push(
            ConvergenceLocalSnapStoppedRunnerCommandAdapterBlocker::EvidencePersistenceNotReady,
        );
    }
    if evidence.evidence_status != ConvergenceLocalSnapRunnerEvidenceStatus::Reviewable {
        blockers
            .push(ConvergenceLocalSnapStoppedRunnerCommandAdapterBlocker::EvidenceNotReviewable);
    }
    if !evidence.local_snap_descriptor_present {
        blockers.push(
            ConvergenceLocalSnapStoppedRunnerCommandAdapterBlocker::MissingLocalSnapDescriptor,
        );
    }
    blockers
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_stopped_runner_command_adapter/tests.rs"]
mod tests;
