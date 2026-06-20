//! Codex callback response durable linkage persistence.
//!
//! This module stores reference-only callback response execution linkage. It
//! does not expose raw callback material, accept reviews, complete tasks, or
//! replay provider writes.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::state::ServerStateService;

use super::callback_response_execution_receipt_linkage::{
    CodexAppServerCallbackResponseExecutionReceiptLink,
    CodexAppServerCallbackResponseExecutionReceiptLinkBlocker,
    CodexAppServerCallbackResponseExecutionReceiptLinkStatus,
    CodexAppServerCallbackResponseExecutionRuntimeProgress,
};

const CALLBACK_RESPONSE_LINKAGE_PREFIX: &str = "codex-callback-response-durable-linkage:";

/// Input for persisting one callback response durable linkage record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerCallbackResponseDurableLinkageInput {
    pub link: CodexAppServerCallbackResponseExecutionReceiptLink,
    pub durable_dispatch_ref: String,
    pub durable_status_ref: String,
}

/// Persisted reference-only callback response durable linkage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerCallbackResponseDurableLinkageRecord {
    pub linkage_id: String,
    pub link_id: String,
    pub admission_id: String,
    pub policy_id: String,
    pub request_id: String,
    pub callback_response_id: String,
    pub envelope_id: String,
    pub provider_callback_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub live_executor_outcome_id: String,
    pub runtime_receipt_id: String,
    pub durable_dispatch_ref: String,
    pub durable_status_ref: String,
    pub provider_instance_id: String,
    pub callback_response_write_attempt_id: String,
    pub runtime_progress: String,
    pub status: String,
    pub blocker_refs: Vec<String>,
    pub callback_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub provider_completion_recorded: bool,
    pub provider_write_recorded: bool,
    pub task_completion_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub raw_callback_material_retained: bool,
    pub raw_provider_material_retained: bool,
    pub provider_io_replayed: bool,
}

/// Persist one reference-only callback response durable linkage record.
pub fn persist_codex_callback_response_durable_linkage<B>(
    state: &ServerStateService<B>,
    input: CodexAppServerCallbackResponseDurableLinkageInput,
) -> LocalStoreResult<CodexAppServerCallbackResponseDurableLinkageRecord>
where
    B: LocalStoreBackend,
{
    validate_linkage_input(&input)?;
    let record = durable_linkage_record_from_input(input);

    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.linkage_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.linkage_id)),
            payload: json_payload(encode_durable_linkage_record(&record)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(record)
}

/// Read persisted callback response durable linkage records.
pub fn read_codex_callback_response_durable_linkage_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<CodexAppServerCallbackResponseDurableLinkageRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(CALLBACK_RESPONSE_LINKAGE_PREFIX))
        .map(|record| decode_durable_linkage_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.linkage_id.cmp(&right.linkage_id));
    Ok(records)
}

fn validate_linkage_input(
    input: &CodexAppServerCallbackResponseDurableLinkageInput,
) -> LocalStoreResult<()> {
    let link = &input.link;
    if link.link_id.0.trim().is_empty()
        || link.admission_id.trim().is_empty()
        || link.policy_id.trim().is_empty()
        || link.request_id.trim().is_empty()
        || link.callback_response_id.trim().is_empty()
        || link.envelope_id.trim().is_empty()
        || link.provider_callback_id.trim().is_empty()
        || link.task_id.trim().is_empty()
        || link.work_item_id.trim().is_empty()
        || link.live_executor_outcome_id.trim().is_empty()
        || link.runtime_receipt_id.0.trim().is_empty()
        || link.provider_instance_id.trim().is_empty()
        || link.callback_response_write_attempt_id.trim().is_empty()
        || input.durable_dispatch_ref.trim().is_empty()
        || input.durable_status_ref.trim().is_empty()
        || link.evidence_refs.is_empty()
    {
        return invalid(
            "callback response durable linkage requires identity, durable refs, and evidence refs",
        );
    }
    if link.task_completion_permitted
        || link.review_acceptance_permitted
        || link.raw_callback_material_retained
    {
        return invalid("callback response durable linkage cannot grant task, review, or raw callback authority");
    }
    if link
        .evidence_refs
        .iter()
        .chain(link.callback_refs.iter())
        .any(|value| value.trim().is_empty())
    {
        return invalid("callback response durable linkage refs cannot be empty");
    }

    Ok(())
}

fn durable_linkage_record_from_input(
    input: CodexAppServerCallbackResponseDurableLinkageInput,
) -> CodexAppServerCallbackResponseDurableLinkageRecord {
    let link = input.link;

    CodexAppServerCallbackResponseDurableLinkageRecord {
        linkage_id: format!("{}{}", CALLBACK_RESPONSE_LINKAGE_PREFIX, link.link_id.0),
        link_id: link.link_id.0,
        admission_id: link.admission_id,
        policy_id: link.policy_id,
        request_id: link.request_id,
        callback_response_id: link.callback_response_id,
        envelope_id: link.envelope_id,
        provider_callback_id: link.provider_callback_id,
        task_id: link.task_id,
        work_item_id: link.work_item_id,
        live_executor_outcome_id: link.live_executor_outcome_id,
        runtime_receipt_id: link.runtime_receipt_id.0,
        durable_dispatch_ref: input.durable_dispatch_ref,
        durable_status_ref: input.durable_status_ref,
        provider_instance_id: link.provider_instance_id,
        callback_response_write_attempt_id: link.callback_response_write_attempt_id,
        runtime_progress: runtime_progress_label(&link.runtime_progress),
        status: status_label(&link.status),
        blocker_refs: blocker_refs(&link.status),
        callback_refs: link.callback_refs,
        evidence_refs: link.evidence_refs,
        provider_completion_recorded: link.provider_completion_recorded,
        provider_write_recorded: link.provider_write_recorded,
        task_completion_permitted: false,
        review_acceptance_permitted: false,
        raw_callback_material_retained: false,
        raw_provider_material_retained: false,
        provider_io_replayed: false,
    }
}

fn runtime_progress_label(
    progress: &CodexAppServerCallbackResponseExecutionRuntimeProgress,
) -> String {
    match progress {
        CodexAppServerCallbackResponseExecutionRuntimeProgress::Accepted => "accepted".to_owned(),
        CodexAppServerCallbackResponseExecutionRuntimeProgress::Completed => "completed".to_owned(),
        CodexAppServerCallbackResponseExecutionRuntimeProgress::Failed(reason) => {
            format!("failed:{reason}")
        }
        CodexAppServerCallbackResponseExecutionRuntimeProgress::TimedOut => "timed_out".to_owned(),
        CodexAppServerCallbackResponseExecutionRuntimeProgress::Blocked(reason) => {
            format!("blocked:{reason}")
        }
        CodexAppServerCallbackResponseExecutionRuntimeProgress::CleanupRequired(reason) => {
            format!("cleanup_required:{reason}")
        }
    }
}

fn status_label(status: &CodexAppServerCallbackResponseExecutionReceiptLinkStatus) -> String {
    match status {
        CodexAppServerCallbackResponseExecutionReceiptLinkStatus::Linked => "linked".to_owned(),
        CodexAppServerCallbackResponseExecutionReceiptLinkStatus::Blocked(_) => {
            "blocked".to_owned()
        }
    }
}

fn blocker_refs(status: &CodexAppServerCallbackResponseExecutionReceiptLinkStatus) -> Vec<String> {
    match status {
        CodexAppServerCallbackResponseExecutionReceiptLinkStatus::Linked => Vec::new(),
        CodexAppServerCallbackResponseExecutionReceiptLinkStatus::Blocked(blockers) => {
            blockers.iter().map(blocker_label).collect()
        }
    }
}

fn blocker_label(blocker: &CodexAppServerCallbackResponseExecutionReceiptLinkBlocker) -> String {
    format!("{blocker:?}")
}

fn encode_durable_linkage_record(
    record: &CodexAppServerCallbackResponseDurableLinkageRecord,
) -> LocalStoreResult<Vec<u8>> {
    serde_json::to_vec(&DurableLinkageRecordDto::from_record(record)).map_err(json_error)
}

fn decode_durable_linkage_record(
    bytes: &[u8],
) -> LocalStoreResult<CodexAppServerCallbackResponseDurableLinkageRecord> {
    let dto: DurableLinkageRecordDto = serde_json::from_slice(bytes).map_err(json_error)?;
    Ok(dto.into_record())
}

fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

fn invalid<T>(reason: impl Into<String>) -> LocalStoreResult<T> {
    Err(LocalStoreError::InvalidRecord {
        reason: reason.into(),
    })
}

fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct DurableLinkageRecordDto {
    linkage_id: String,
    link_id: String,
    admission_id: String,
    policy_id: String,
    request_id: String,
    callback_response_id: String,
    envelope_id: String,
    provider_callback_id: String,
    task_id: String,
    work_item_id: String,
    live_executor_outcome_id: String,
    runtime_receipt_id: String,
    durable_dispatch_ref: String,
    durable_status_ref: String,
    provider_instance_id: String,
    callback_response_write_attempt_id: String,
    runtime_progress: String,
    status: String,
    blocker_refs: Vec<String>,
    callback_refs: Vec<String>,
    evidence_refs: Vec<String>,
    provider_completion_recorded: bool,
    provider_write_recorded: bool,
    task_completion_permitted: bool,
    review_acceptance_permitted: bool,
    raw_callback_material_retained: bool,
    raw_provider_material_retained: bool,
    provider_io_replayed: bool,
}

impl DurableLinkageRecordDto {
    fn from_record(record: &CodexAppServerCallbackResponseDurableLinkageRecord) -> Self {
        Self {
            linkage_id: record.linkage_id.clone(),
            link_id: record.link_id.clone(),
            admission_id: record.admission_id.clone(),
            policy_id: record.policy_id.clone(),
            request_id: record.request_id.clone(),
            callback_response_id: record.callback_response_id.clone(),
            envelope_id: record.envelope_id.clone(),
            provider_callback_id: record.provider_callback_id.clone(),
            task_id: record.task_id.clone(),
            work_item_id: record.work_item_id.clone(),
            live_executor_outcome_id: record.live_executor_outcome_id.clone(),
            runtime_receipt_id: record.runtime_receipt_id.clone(),
            durable_dispatch_ref: record.durable_dispatch_ref.clone(),
            durable_status_ref: record.durable_status_ref.clone(),
            provider_instance_id: record.provider_instance_id.clone(),
            callback_response_write_attempt_id: record.callback_response_write_attempt_id.clone(),
            runtime_progress: record.runtime_progress.clone(),
            status: record.status.clone(),
            blocker_refs: record.blocker_refs.clone(),
            callback_refs: record.callback_refs.clone(),
            evidence_refs: record.evidence_refs.clone(),
            provider_completion_recorded: record.provider_completion_recorded,
            provider_write_recorded: record.provider_write_recorded,
            task_completion_permitted: record.task_completion_permitted,
            review_acceptance_permitted: record.review_acceptance_permitted,
            raw_callback_material_retained: record.raw_callback_material_retained,
            raw_provider_material_retained: record.raw_provider_material_retained,
            provider_io_replayed: record.provider_io_replayed,
        }
    }

    fn into_record(self) -> CodexAppServerCallbackResponseDurableLinkageRecord {
        CodexAppServerCallbackResponseDurableLinkageRecord {
            linkage_id: self.linkage_id,
            link_id: self.link_id,
            admission_id: self.admission_id,
            policy_id: self.policy_id,
            request_id: self.request_id,
            callback_response_id: self.callback_response_id,
            envelope_id: self.envelope_id,
            provider_callback_id: self.provider_callback_id,
            task_id: self.task_id,
            work_item_id: self.work_item_id,
            live_executor_outcome_id: self.live_executor_outcome_id,
            runtime_receipt_id: self.runtime_receipt_id,
            durable_dispatch_ref: self.durable_dispatch_ref,
            durable_status_ref: self.durable_status_ref,
            provider_instance_id: self.provider_instance_id,
            callback_response_write_attempt_id: self.callback_response_write_attempt_id,
            runtime_progress: self.runtime_progress,
            status: self.status,
            blocker_refs: self.blocker_refs,
            callback_refs: self.callback_refs,
            evidence_refs: self.evidence_refs,
            provider_completion_recorded: self.provider_completion_recorded,
            provider_write_recorded: self.provider_write_recorded,
            task_completion_permitted: self.task_completion_permitted,
            review_acceptance_permitted: self.review_acceptance_permitted,
            raw_callback_material_retained: self.raw_callback_material_retained,
            raw_provider_material_retained: self.raw_provider_material_retained,
            provider_io_replayed: self.provider_io_replayed,
        }
    }
}

#[cfg(test)]
mod tests;
