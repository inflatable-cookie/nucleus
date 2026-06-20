//! Persistence for SCM change-request preparation admission records.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::{
    ScmChangeRequestPrepAdmissionBlocker, ScmChangeRequestPrepAdmissionRecord,
    ScmChangeRequestPrepAdmissionStatus, ServerStateService,
};

const SCM_CHANGE_REQUEST_PREP_PREFIX: &str = "scm-change-request-prep:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmChangeRequestPrepPersistenceInput {
    pub admission: ScmChangeRequestPrepAdmissionRecord,
    pub existing_preparation_ids: Vec<String>,
    pub raw_output_present: bool,
    pub branch_or_snapshot_requested: bool,
    pub commit_or_publish_requested: bool,
    pub push_or_remote_publish_requested: bool,
    pub forge_effect_requested: bool,
    pub provider_write_requested: bool,
    pub callback_response_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmChangeRequestPrepPersistenceRecord {
    pub persisted_preparation_id: String,
    pub admission_id: String,
    pub decision_id: String,
    pub readiness_id: String,
    pub workflow_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub repo_id: String,
    pub operator_ref: String,
    pub adapter_label: String,
    pub workflow_label: String,
    pub evidence_refs: Vec<String>,
    pub admission_status: ScmChangeRequestPrepAdmissionStatus,
    pub admission_blockers: Vec<ScmChangeRequestPrepAdmissionBlocker>,
    pub status: ScmChangeRequestPrepPersistenceStatus,
    pub blockers: Vec<ScmChangeRequestPrepPersistenceBlocker>,
    pub duplicate_preparation_detected: bool,
    pub branch_or_snapshot_authority_granted: bool,
    pub commit_or_publish_authority_granted: bool,
    pub push_or_remote_publish_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmChangeRequestPrepPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmChangeRequestPrepPersistenceBlocker {
    AdmissionNotAdmitted,
    MissingEvidenceRef,
    RawOutputPresent,
    BranchOrSnapshotRequested,
    CommitOrPublishRequested,
    PushOrRemotePublishRequested,
    ForgeEffectRequested,
    ProviderWriteRequested,
    CallbackResponseRequested,
    InterruptionRequested,
    RecoveryRequested,
}

pub fn persist_scm_change_request_prep<B>(
    state: &ServerStateService<B>,
    input: ScmChangeRequestPrepPersistenceInput,
) -> LocalStoreResult<ScmChangeRequestPrepPersistenceRecord>
where
    B: LocalStoreBackend,
{
    let persisted_preparation_id = persisted_preparation_id(&input.admission.admission_id);
    if input
        .existing_preparation_ids
        .contains(&persisted_preparation_id)
    {
        return Ok(persistence_record(
            input,
            persisted_preparation_id,
            ScmChangeRequestPrepPersistenceStatus::DuplicateNoop,
            Vec::new(),
            true,
        ));
    }

    let blockers = blockers(&input);
    if !blockers.is_empty() {
        return Ok(persistence_record(
            input,
            persisted_preparation_id,
            ScmChangeRequestPrepPersistenceStatus::Blocked,
            blockers,
            false,
        ));
    }

    let record = persistence_record(
        input,
        persisted_preparation_id,
        ScmChangeRequestPrepPersistenceStatus::Persisted,
        Vec::new(),
        false,
    );
    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.persisted_preparation_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.persisted_preparation_id)),
            payload: json_payload(serde_json::to_vec(&record).map_err(json_error)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(record)
}

pub fn read_scm_change_request_prep_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ScmChangeRequestPrepPersistenceRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(SCM_CHANGE_REQUEST_PREP_PREFIX))
        .map(|record| {
            serde_json::from_slice::<ScmChangeRequestPrepPersistenceRecord>(&record.payload.bytes)
                .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| {
        left.persisted_preparation_id
            .cmp(&right.persisted_preparation_id)
    });
    Ok(records)
}

pub fn scm_change_request_prep_diagnostics_from_persisted_records(
    records: Vec<ScmChangeRequestPrepPersistenceRecord>,
) -> crate::ScmChangeRequestPrepDiagnosticsRecord {
    crate::scm_change_request_prep_diagnostics(
        records.into_iter().map(admission_from_record).collect(),
    )
}

fn admission_from_record(
    record: ScmChangeRequestPrepPersistenceRecord,
) -> ScmChangeRequestPrepAdmissionRecord {
    ScmChangeRequestPrepAdmissionRecord {
        admission_id: record.admission_id,
        decision_id: record.decision_id,
        readiness_id: record.readiness_id,
        workflow_id: record.workflow_id,
        task_id: record.task_id,
        work_item_id: record.work_item_id,
        completion_id: record.completion_id,
        repo_id: record.repo_id,
        operator_ref: record.operator_ref,
        adapter_label: record.adapter_label,
        workflow_label: record.workflow_label,
        evidence_refs: record.evidence_refs,
        status: record.admission_status,
        blockers: record.admission_blockers,
        preparation_admitted: record.status == ScmChangeRequestPrepPersistenceStatus::Persisted,
        branch_or_snapshot_authority_granted: false,
        commit_or_publish_authority_granted: false,
        push_or_remote_publish_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        raw_output_retained: false,
    }
}

fn persistence_record(
    input: ScmChangeRequestPrepPersistenceInput,
    persisted_preparation_id: String,
    status: ScmChangeRequestPrepPersistenceStatus,
    blockers: Vec<ScmChangeRequestPrepPersistenceBlocker>,
    duplicate_preparation_detected: bool,
) -> ScmChangeRequestPrepPersistenceRecord {
    ScmChangeRequestPrepPersistenceRecord {
        persisted_preparation_id,
        admission_id: input.admission.admission_id,
        decision_id: input.admission.decision_id,
        readiness_id: input.admission.readiness_id,
        workflow_id: input.admission.workflow_id,
        task_id: input.admission.task_id,
        work_item_id: input.admission.work_item_id,
        completion_id: input.admission.completion_id,
        repo_id: input.admission.repo_id,
        operator_ref: input.admission.operator_ref,
        adapter_label: input.admission.adapter_label,
        workflow_label: input.admission.workflow_label,
        evidence_refs: unique_sorted(input.admission.evidence_refs),
        admission_status: input.admission.status,
        admission_blockers: input.admission.blockers,
        status,
        blockers,
        duplicate_preparation_detected,
        branch_or_snapshot_authority_granted: false,
        commit_or_publish_authority_granted: false,
        push_or_remote_publish_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        raw_output_retained: false,
    }
}

fn blockers(
    input: &ScmChangeRequestPrepPersistenceInput,
) -> Vec<ScmChangeRequestPrepPersistenceBlocker> {
    let mut blockers = Vec::new();
    if input.admission.status != ScmChangeRequestPrepAdmissionStatus::Admitted {
        blockers.push(ScmChangeRequestPrepPersistenceBlocker::AdmissionNotAdmitted);
    }
    if input.admission.evidence_refs.is_empty() {
        blockers.push(ScmChangeRequestPrepPersistenceBlocker::MissingEvidenceRef);
    }
    if input.raw_output_present || input.admission.raw_output_retained {
        blockers.push(ScmChangeRequestPrepPersistenceBlocker::RawOutputPresent);
    }
    if input.branch_or_snapshot_requested || input.admission.branch_or_snapshot_authority_granted {
        blockers.push(ScmChangeRequestPrepPersistenceBlocker::BranchOrSnapshotRequested);
    }
    if input.commit_or_publish_requested || input.admission.commit_or_publish_authority_granted {
        blockers.push(ScmChangeRequestPrepPersistenceBlocker::CommitOrPublishRequested);
    }
    if input.push_or_remote_publish_requested
        || input.admission.push_or_remote_publish_authority_granted
    {
        blockers.push(ScmChangeRequestPrepPersistenceBlocker::PushOrRemotePublishRequested);
    }
    if input.forge_effect_requested || input.admission.forge_authority_granted {
        blockers.push(ScmChangeRequestPrepPersistenceBlocker::ForgeEffectRequested);
    }
    if input.provider_write_requested || input.admission.provider_authority_granted {
        blockers.push(ScmChangeRequestPrepPersistenceBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested || input.admission.callback_authority_granted {
        blockers.push(ScmChangeRequestPrepPersistenceBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested || input.admission.interruption_authority_granted {
        blockers.push(ScmChangeRequestPrepPersistenceBlocker::InterruptionRequested);
    }
    if input.recovery_requested || input.admission.recovery_authority_granted {
        blockers.push(ScmChangeRequestPrepPersistenceBlocker::RecoveryRequested);
    }
    blockers
}

fn persisted_preparation_id(admission_id: &str) -> String {
    format!("{SCM_CHANGE_REQUEST_PREP_PREFIX}{admission_id}")
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests;
