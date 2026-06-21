//! Command descriptors for stopped Convergence local snap admissions.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceLocalSnapAdmissionRecord, ConvergenceLocalSnapAdmissionSet,
    ConvergenceLocalSnapAdmissionStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergenceLocalSnapCommandDescriptorsInput {
    pub admissions: ConvergenceLocalSnapAdmissionSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapCommandDescriptorSet {
    pub descriptor_set_id: String,
    pub descriptors: Vec<ConvergenceLocalSnapCommandDescriptorRecord>,
    pub skipped_admission_ids: Vec<String>,
    pub executable_argv_built: bool,
    pub local_snap_creation_executed: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapCommandDescriptorRecord {
    pub descriptor_id: String,
    pub admission_id: String,
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
    pub source_authority_ref: String,
    pub execution_authority_ref: String,
    pub local_snap_descriptor_ref: Option<String>,
    pub status: ConvergenceLocalSnapCommandDescriptorStatus,
    pub blockers: Vec<ConvergenceLocalSnapCommandDescriptorBlocker>,
    pub executable_argv_built: bool,
    pub local_snap_creation_executed: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapCommandDescriptorStatus {
    Ready,
    Blocked,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapCommandDescriptorBlocker {
    AdmissionNotAdmitted,
}

pub fn convergence_local_snap_command_descriptors(
    input: ConvergenceLocalSnapCommandDescriptorsInput,
) -> ConvergenceLocalSnapCommandDescriptorSet {
    let mut descriptors = input
        .admissions
        .records
        .into_iter()
        .map(descriptor_record)
        .collect::<Vec<_>>();
    descriptors.sort_by(|left, right| left.descriptor_id.cmp(&right.descriptor_id));

    ConvergenceLocalSnapCommandDescriptorSet {
        descriptor_set_id: "convergence-local-snap-command-descriptors".to_owned(),
        skipped_admission_ids: descriptors
            .iter()
            .filter(|descriptor| {
                descriptor.status != ConvergenceLocalSnapCommandDescriptorStatus::Ready
            })
            .map(|descriptor| descriptor.admission_id.clone())
            .collect(),
        descriptors,
        executable_argv_built: false,
        local_snap_creation_executed: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_output_retained: false,
    }
}

fn descriptor_record(
    admission: ConvergenceLocalSnapAdmissionRecord,
) -> ConvergenceLocalSnapCommandDescriptorRecord {
    let blockers = blockers(&admission);
    let status = status(&admission, &blockers);

    ConvergenceLocalSnapCommandDescriptorRecord {
        descriptor_id: format!("convergence-local-snap-command:{}", admission.admission_id),
        admission_id: admission.admission_id.clone(),
        replay_record_id: admission.replay_record_id,
        adapter_record_id: admission.adapter_record_id,
        persisted_evidence_id: admission.persisted_evidence_id,
        evidence_id: admission.evidence_id,
        proof_id: admission.proof_id,
        persisted_request_id: admission.persisted_request_id,
        request_id: admission.request_id,
        idempotency_key: admission.idempotency_key,
        task_ids: admission.task_ids,
        repo_ids: admission.repo_ids,
        source_authority_ref: format!("source-authority:{}", admission.admission_id),
        execution_authority_ref: format!("execution-authority:{}", admission.admission_id),
        local_snap_descriptor_ref: if status == ConvergenceLocalSnapCommandDescriptorStatus::Ready {
            Some(format!("convergence-local-snap:{}", admission.admission_id))
        } else {
            None
        },
        status,
        blockers,
        executable_argv_built: false,
        local_snap_creation_executed: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_output_retained: false,
    }
}

fn status(
    admission: &ConvergenceLocalSnapAdmissionRecord,
    blockers: &[ConvergenceLocalSnapCommandDescriptorBlocker],
) -> ConvergenceLocalSnapCommandDescriptorStatus {
    if admission.status == ConvergenceLocalSnapAdmissionStatus::Unsupported {
        ConvergenceLocalSnapCommandDescriptorStatus::Unsupported
    } else if blockers.is_empty() {
        ConvergenceLocalSnapCommandDescriptorStatus::Ready
    } else {
        ConvergenceLocalSnapCommandDescriptorStatus::Blocked
    }
}

fn blockers(
    admission: &ConvergenceLocalSnapAdmissionRecord,
) -> Vec<ConvergenceLocalSnapCommandDescriptorBlocker> {
    if admission.status == ConvergenceLocalSnapAdmissionStatus::Admitted {
        Vec::new()
    } else {
        vec![ConvergenceLocalSnapCommandDescriptorBlocker::AdmissionNotAdmitted]
    }
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_command_descriptors/tests.rs"]
mod tests;
