//! Codex recovery outcome persistence.
//!
//! This module stores reference-only recovery execution outcomes. It does not
//! retain raw provider material, promote replacement threads, resume sessions
//! automatically, answer callbacks, interrupt turns, or mutate tasks.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::state::ServerStateService;

use super::recovery_execution_receipt_linkage::{
    CodexAppServerRecoveryExecutionReceiptLink, CodexAppServerRecoveryExecutionReceiptLinkBlocker,
    CodexAppServerRecoveryExecutionReceiptLinkStatus,
    CodexAppServerRecoveryExecutionRuntimeProgress,
};

const RECOVERY_OUTCOME_LINKAGE_PREFIX: &str = "codex-recovery-outcome-linkage:";

/// Input for persisting one recovery outcome linkage record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerRecoveryOutcomeLinkageInput {
    pub link: CodexAppServerRecoveryExecutionReceiptLink,
    pub durable_dispatch_ref: String,
    pub durable_status_ref: String,
}

/// Persisted reference-only recovery outcome linkage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerRecoveryOutcomeLinkageRecord {
    pub linkage_id: String,
    pub link_id: String,
    pub admission_id: String,
    pub policy_id: String,
    pub need_id: String,
    pub envelope_id: String,
    pub provider_thread_id: String,
    pub provider_turn_id: Option<String>,
    pub provider_request_id: Option<String>,
    pub task_id: String,
    pub work_item_id: String,
    pub live_executor_outcome_id: String,
    pub runtime_receipt_id: String,
    pub durable_dispatch_ref: String,
    pub durable_status_ref: String,
    pub provider_instance_id: String,
    pub recovery_write_attempt_id: String,
    pub runtime_progress: String,
    pub status: String,
    pub repair_required: bool,
    pub blocker_refs: Vec<String>,
    pub recovery_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub provider_completion_recorded: bool,
    pub provider_write_recorded: bool,
    pub replacement_thread_observed: bool,
    pub task_completion_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub replacement_thread_promotion_permitted: bool,
    pub resume_authority_permitted: bool,
    pub interruption_permitted: bool,
    pub callback_answer_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub raw_provider_material_retained: bool,
    pub raw_callback_material_retained: bool,
    pub provider_io_replayed: bool,
}

/// Persist one reference-only recovery outcome linkage record.
pub fn persist_codex_recovery_outcome_linkage<B>(
    state: &ServerStateService<B>,
    input: CodexAppServerRecoveryOutcomeLinkageInput,
) -> LocalStoreResult<CodexAppServerRecoveryOutcomeLinkageRecord>
where
    B: LocalStoreBackend,
{
    validate_recovery_linkage_input(&input)?;
    let record = recovery_linkage_record_from_input(input);

    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.linkage_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.linkage_id)),
            payload: json_payload(encode_recovery_linkage_record(&record)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(record)
}

/// Read persisted recovery outcome linkage records.
pub fn read_codex_recovery_outcome_linkage_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<CodexAppServerRecoveryOutcomeLinkageRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(RECOVERY_OUTCOME_LINKAGE_PREFIX))
        .map(|record| decode_recovery_linkage_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.linkage_id.cmp(&right.linkage_id));
    Ok(records)
}

fn validate_recovery_linkage_input(
    input: &CodexAppServerRecoveryOutcomeLinkageInput,
) -> LocalStoreResult<()> {
    let link = &input.link;
    if link.link_id.0.trim().is_empty()
        || link.admission_id.trim().is_empty()
        || link.policy_id.trim().is_empty()
        || link.need_id.trim().is_empty()
        || link.envelope_id.trim().is_empty()
        || link.provider_thread_id.trim().is_empty()
        || link.task_id.trim().is_empty()
        || link.work_item_id.trim().is_empty()
        || link.live_executor_outcome_id.trim().is_empty()
        || link.runtime_receipt_id.0.trim().is_empty()
        || link.provider_instance_id.trim().is_empty()
        || link.recovery_write_attempt_id.trim().is_empty()
        || input.durable_dispatch_ref.trim().is_empty()
        || input.durable_status_ref.trim().is_empty()
        || link.evidence_refs.is_empty()
    {
        return invalid(
            "recovery outcome linkage requires identity, durable refs, and evidence refs",
        );
    }
    if link.task_completion_permitted
        || link.review_acceptance_permitted
        || link.replacement_thread_promotion_permitted
        || link.interruption_permitted
        || link.callback_answer_permitted
        || link.scm_mutation_permitted
        || link.raw_provider_material_retained
        || link.raw_callback_material_retained
    {
        return invalid("recovery outcome linkage cannot grant task, review, replacement, interruption, callback, scm, or raw authority");
    }
    if link
        .evidence_refs
        .iter()
        .chain(link.recovery_refs.iter())
        .any(|value| value.trim().is_empty())
    {
        return invalid("recovery outcome linkage refs cannot be empty");
    }

    Ok(())
}

fn recovery_linkage_record_from_input(
    input: CodexAppServerRecoveryOutcomeLinkageInput,
) -> CodexAppServerRecoveryOutcomeLinkageRecord {
    let link = input.link;
    let repair_required = repair_required(&link);

    CodexAppServerRecoveryOutcomeLinkageRecord {
        linkage_id: format!("{}{}", RECOVERY_OUTCOME_LINKAGE_PREFIX, link.link_id.0),
        link_id: link.link_id.0,
        admission_id: link.admission_id,
        policy_id: link.policy_id,
        need_id: link.need_id,
        envelope_id: link.envelope_id,
        provider_thread_id: link.provider_thread_id,
        provider_turn_id: link.provider_turn_id,
        provider_request_id: link.provider_request_id,
        task_id: link.task_id,
        work_item_id: link.work_item_id,
        live_executor_outcome_id: link.live_executor_outcome_id,
        runtime_receipt_id: link.runtime_receipt_id.0,
        durable_dispatch_ref: input.durable_dispatch_ref,
        durable_status_ref: input.durable_status_ref,
        provider_instance_id: link.provider_instance_id,
        recovery_write_attempt_id: link.recovery_write_attempt_id,
        runtime_progress: runtime_progress_label(&link.runtime_progress),
        status: status_label(&link.status),
        repair_required,
        blocker_refs: blocker_refs(&link.status),
        recovery_refs: link.recovery_refs,
        evidence_refs: link.evidence_refs,
        provider_completion_recorded: link.provider_completion_recorded,
        provider_write_recorded: link.provider_write_recorded,
        replacement_thread_observed: link.replacement_thread_observed,
        task_completion_permitted: false,
        review_acceptance_permitted: false,
        replacement_thread_promotion_permitted: false,
        resume_authority_permitted: false,
        interruption_permitted: false,
        callback_answer_permitted: false,
        scm_mutation_permitted: false,
        raw_provider_material_retained: false,
        raw_callback_material_retained: false,
        provider_io_replayed: false,
    }
}

fn repair_required(link: &CodexAppServerRecoveryExecutionReceiptLink) -> bool {
    link.replacement_thread_observed
        || matches!(
            link.status,
            CodexAppServerRecoveryExecutionReceiptLinkStatus::Blocked(_)
        )
        || matches!(
            link.runtime_progress,
            CodexAppServerRecoveryExecutionRuntimeProgress::Failed(_)
                | CodexAppServerRecoveryExecutionRuntimeProgress::TimedOut
                | CodexAppServerRecoveryExecutionRuntimeProgress::Blocked(_)
                | CodexAppServerRecoveryExecutionRuntimeProgress::CleanupRequired(_)
                | CodexAppServerRecoveryExecutionRuntimeProgress::ReplacementThreadObserved(_)
        )
}

fn runtime_progress_label(progress: &CodexAppServerRecoveryExecutionRuntimeProgress) -> String {
    match progress {
        CodexAppServerRecoveryExecutionRuntimeProgress::Accepted => "accepted".to_owned(),
        CodexAppServerRecoveryExecutionRuntimeProgress::Completed => "completed".to_owned(),
        CodexAppServerRecoveryExecutionRuntimeProgress::Failed(reason) => {
            format!("failed:{reason}")
        }
        CodexAppServerRecoveryExecutionRuntimeProgress::TimedOut => "timed_out".to_owned(),
        CodexAppServerRecoveryExecutionRuntimeProgress::Blocked(reason) => {
            format!("blocked:{reason}")
        }
        CodexAppServerRecoveryExecutionRuntimeProgress::CleanupRequired(reason) => {
            format!("cleanup_required:{reason}")
        }
        CodexAppServerRecoveryExecutionRuntimeProgress::ReplacementThreadObserved(reason) => {
            format!("replacement_thread_observed:{reason}")
        }
    }
}

fn status_label(status: &CodexAppServerRecoveryExecutionReceiptLinkStatus) -> String {
    match status {
        CodexAppServerRecoveryExecutionReceiptLinkStatus::Linked => "linked".to_owned(),
        CodexAppServerRecoveryExecutionReceiptLinkStatus::Blocked(_) => "blocked".to_owned(),
    }
}

fn blocker_refs(status: &CodexAppServerRecoveryExecutionReceiptLinkStatus) -> Vec<String> {
    match status {
        CodexAppServerRecoveryExecutionReceiptLinkStatus::Linked => Vec::new(),
        CodexAppServerRecoveryExecutionReceiptLinkStatus::Blocked(blockers) => {
            blockers.iter().map(blocker_label).collect()
        }
    }
}

fn blocker_label(blocker: &CodexAppServerRecoveryExecutionReceiptLinkBlocker) -> String {
    format!("{blocker:?}")
}

fn encode_recovery_linkage_record(
    record: &CodexAppServerRecoveryOutcomeLinkageRecord,
) -> LocalStoreResult<Vec<u8>> {
    serde_json::to_vec(&RecoveryLinkageRecordDto::from_record(record)).map_err(json_error)
}

fn decode_recovery_linkage_record(
    bytes: &[u8],
) -> LocalStoreResult<CodexAppServerRecoveryOutcomeLinkageRecord> {
    let dto: RecoveryLinkageRecordDto = serde_json::from_slice(bytes).map_err(json_error)?;
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
struct RecoveryLinkageRecordDto {
    linkage_id: String,
    link_id: String,
    admission_id: String,
    policy_id: String,
    need_id: String,
    envelope_id: String,
    provider_thread_id: String,
    provider_turn_id: Option<String>,
    provider_request_id: Option<String>,
    task_id: String,
    work_item_id: String,
    live_executor_outcome_id: String,
    runtime_receipt_id: String,
    durable_dispatch_ref: String,
    durable_status_ref: String,
    provider_instance_id: String,
    recovery_write_attempt_id: String,
    runtime_progress: String,
    status: String,
    repair_required: bool,
    blocker_refs: Vec<String>,
    recovery_refs: Vec<String>,
    evidence_refs: Vec<String>,
    provider_completion_recorded: bool,
    provider_write_recorded: bool,
    replacement_thread_observed: bool,
    task_completion_permitted: bool,
    review_acceptance_permitted: bool,
    replacement_thread_promotion_permitted: bool,
    resume_authority_permitted: bool,
    interruption_permitted: bool,
    callback_answer_permitted: bool,
    scm_mutation_permitted: bool,
    raw_provider_material_retained: bool,
    raw_callback_material_retained: bool,
    provider_io_replayed: bool,
}

impl RecoveryLinkageRecordDto {
    fn from_record(record: &CodexAppServerRecoveryOutcomeLinkageRecord) -> Self {
        Self {
            linkage_id: record.linkage_id.clone(),
            link_id: record.link_id.clone(),
            admission_id: record.admission_id.clone(),
            policy_id: record.policy_id.clone(),
            need_id: record.need_id.clone(),
            envelope_id: record.envelope_id.clone(),
            provider_thread_id: record.provider_thread_id.clone(),
            provider_turn_id: record.provider_turn_id.clone(),
            provider_request_id: record.provider_request_id.clone(),
            task_id: record.task_id.clone(),
            work_item_id: record.work_item_id.clone(),
            live_executor_outcome_id: record.live_executor_outcome_id.clone(),
            runtime_receipt_id: record.runtime_receipt_id.clone(),
            durable_dispatch_ref: record.durable_dispatch_ref.clone(),
            durable_status_ref: record.durable_status_ref.clone(),
            provider_instance_id: record.provider_instance_id.clone(),
            recovery_write_attempt_id: record.recovery_write_attempt_id.clone(),
            runtime_progress: record.runtime_progress.clone(),
            status: record.status.clone(),
            repair_required: record.repair_required,
            blocker_refs: record.blocker_refs.clone(),
            recovery_refs: record.recovery_refs.clone(),
            evidence_refs: record.evidence_refs.clone(),
            provider_completion_recorded: record.provider_completion_recorded,
            provider_write_recorded: record.provider_write_recorded,
            replacement_thread_observed: record.replacement_thread_observed,
            task_completion_permitted: record.task_completion_permitted,
            review_acceptance_permitted: record.review_acceptance_permitted,
            replacement_thread_promotion_permitted: record.replacement_thread_promotion_permitted,
            resume_authority_permitted: record.resume_authority_permitted,
            interruption_permitted: record.interruption_permitted,
            callback_answer_permitted: record.callback_answer_permitted,
            scm_mutation_permitted: record.scm_mutation_permitted,
            raw_provider_material_retained: record.raw_provider_material_retained,
            raw_callback_material_retained: record.raw_callback_material_retained,
            provider_io_replayed: record.provider_io_replayed,
        }
    }

    fn into_record(self) -> CodexAppServerRecoveryOutcomeLinkageRecord {
        CodexAppServerRecoveryOutcomeLinkageRecord {
            linkage_id: self.linkage_id,
            link_id: self.link_id,
            admission_id: self.admission_id,
            policy_id: self.policy_id,
            need_id: self.need_id,
            envelope_id: self.envelope_id,
            provider_thread_id: self.provider_thread_id,
            provider_turn_id: self.provider_turn_id,
            provider_request_id: self.provider_request_id,
            task_id: self.task_id,
            work_item_id: self.work_item_id,
            live_executor_outcome_id: self.live_executor_outcome_id,
            runtime_receipt_id: self.runtime_receipt_id,
            durable_dispatch_ref: self.durable_dispatch_ref,
            durable_status_ref: self.durable_status_ref,
            provider_instance_id: self.provider_instance_id,
            recovery_write_attempt_id: self.recovery_write_attempt_id,
            runtime_progress: self.runtime_progress,
            status: self.status,
            repair_required: self.repair_required,
            blocker_refs: self.blocker_refs,
            recovery_refs: self.recovery_refs,
            evidence_refs: self.evidence_refs,
            provider_completion_recorded: self.provider_completion_recorded,
            provider_write_recorded: self.provider_write_recorded,
            replacement_thread_observed: self.replacement_thread_observed,
            task_completion_permitted: self.task_completion_permitted,
            review_acceptance_permitted: self.review_acceptance_permitted,
            replacement_thread_promotion_permitted: self.replacement_thread_promotion_permitted,
            resume_authority_permitted: self.resume_authority_permitted,
            interruption_permitted: self.interruption_permitted,
            callback_answer_permitted: self.callback_answer_permitted,
            scm_mutation_permitted: self.scm_mutation_permitted,
            raw_provider_material_retained: self.raw_provider_material_retained,
            raw_callback_material_retained: self.raw_callback_material_retained,
            provider_io_replayed: self.provider_io_replayed,
        }
    }
}

#[cfg(test)]
mod tests;
