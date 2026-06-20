//! Durable dispatch outcome persistence records.
//!
//! These records reconcile durable executor handoff records with sanitized
//! Codex live executor outcome persistence and durable status linkage.

use serde::{Deserialize, Serialize};

use crate::{
    durable_provider_executor_dispatch_outcome_linkage,
    CodexAppServerLiveExecutorOutcomePersistenceRecord, CodexAppServerLiveExecutorOutcomeRecord,
    DurableDispatchExecutorHandoffRecord, DurableDispatchExecutorHandoffStatus,
    DurableProviderExecutorCommandRecord, DurableProviderExecutorDispatchAdmissionRecord,
    DurableProviderExecutorDispatchOutcomeLinkageInput,
    DurableProviderExecutorDispatchOutcomeLinkageRecord,
};

/// Stable id for one durable dispatch outcome persistence reconciliation.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct DurableDispatchOutcomePersistenceId(pub String);

/// Input for reconciling durable dispatch outcome persistence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableDispatchOutcomePersistenceInput {
    pub handoff: DurableDispatchExecutorHandoffRecord,
    pub admission: DurableProviderExecutorDispatchAdmissionRecord,
    pub command: DurableProviderExecutorCommandRecord,
    pub outcome: CodexAppServerLiveExecutorOutcomeRecord,
    pub live_persistence: CodexAppServerLiveExecutorOutcomePersistenceRecord,
    pub persisted_write_attempt_ids: Vec<String>,
    pub persistence_evidence_refs: Vec<String>,
    pub raw_provider_material_retained: bool,
    pub raw_callback_material_retained: bool,
    pub task_mutation_requested: bool,
    pub review_acceptance_requested: bool,
    pub callback_answer_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
    pub replacement_thread_promotion_requested: bool,
    pub scm_mutation_requested: bool,
}

/// Durable dispatch outcome persistence reconciliation record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableDispatchOutcomePersistenceRecord {
    pub persistence_id: DurableDispatchOutcomePersistenceId,
    pub handoff_id: String,
    pub command_id: String,
    pub admission_id: String,
    pub dispatch_attempt_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub live_executor_outcome_id: String,
    pub runtime_receipt_id: String,
    pub durable_linkage: DurableProviderExecutorDispatchOutcomeLinkageRecord,
    pub status: DurableDispatchOutcomePersistenceStatus,
    pub blockers: Vec<DurableDispatchOutcomePersistenceBlocker>,
    pub evidence_refs: Vec<String>,
    pub provider_write_executed: bool,
    pub raw_payload_persisted: bool,
    pub raw_stream_persisted: bool,
    pub task_mutation_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub callback_answer_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub replacement_thread_promotion_permitted: bool,
    pub scm_mutation_permitted: bool,
}

/// Durable dispatch outcome persistence status.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableDispatchOutcomePersistenceStatus {
    Reconciled,
    Blocked,
}

/// Why durable dispatch outcome persistence is blocked.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableDispatchOutcomePersistenceBlocker {
    HandoffNotReady,
    HandoffAlreadyExecutedProviderWrite,
    HandoffPermitsForbiddenAuthority,
    CommandIdMismatch,
    AdmissionIdMismatch,
    ProviderInstanceMismatch,
    WriteAttemptMismatch,
    PersistenceOutcomeMismatch,
    PersistenceReceiptMismatch,
    DuplicatePersistedWriteAttempt,
    MissingPersistenceEvidence,
    RawPayloadPersisted,
    RawStreamPersisted,
    PersistencePermitsTaskMutation,
    RawProviderMaterialRetained,
    RawCallbackMaterialRetained,
    TaskMutationRequested,
    ReviewAcceptanceRequested,
    CallbackAnswerRequested,
    InterruptionRequested,
    RecoveryRequested,
    ReplacementThreadPromotionRequested,
    ScmMutationRequested,
}

/// Reconcile durable dispatch outcome persistence without writing raw material.
pub fn durable_dispatch_outcome_persistence(
    input: DurableDispatchOutcomePersistenceInput,
) -> DurableDispatchOutcomePersistenceRecord {
    let blockers = persistence_blockers(&input);
    let status = if blockers.is_empty() {
        DurableDispatchOutcomePersistenceStatus::Reconciled
    } else {
        DurableDispatchOutcomePersistenceStatus::Blocked
    };
    let durable_linkage = durable_provider_executor_dispatch_outcome_linkage(
        DurableProviderExecutorDispatchOutcomeLinkageInput {
            admission: input.admission.clone(),
            command: input.command.clone(),
            outcome: input.outcome.clone(),
            runtime_receipt_id: input.live_persistence.receipt_id.0.clone(),
            linkage_evidence_refs: linkage_evidence_refs(&input, &blockers),
            raw_provider_material_retained: input.raw_provider_material_retained,
            raw_callback_material_retained: input.raw_callback_material_retained,
            task_mutation_requested: input.task_mutation_requested,
            review_acceptance_requested: input.review_acceptance_requested,
            callback_answer_requested: input.callback_answer_requested,
            interruption_requested: input.interruption_requested,
            recovery_requested: input.recovery_requested,
            replacement_thread_promotion_requested: input.replacement_thread_promotion_requested,
            scm_mutation_requested: input.scm_mutation_requested,
        },
    );
    let mut evidence_refs = input.handoff.evidence_refs.clone();
    evidence_refs.extend(input.outcome.evidence_refs.clone());
    evidence_refs.extend(input.outcome.receipt_refs.clone());
    evidence_refs.extend(input.persistence_evidence_refs.clone());
    evidence_refs.extend(durable_linkage.evidence_refs.clone());

    DurableDispatchOutcomePersistenceRecord {
        persistence_id: DurableDispatchOutcomePersistenceId(format!(
            "durable-dispatch-outcome-persistence:{}",
            input.handoff.write_attempt_id
        )),
        handoff_id: input.handoff.handoff_id.0,
        command_id: input.handoff.command_id,
        admission_id: input.handoff.admission_id,
        dispatch_attempt_id: input.handoff.dispatch_attempt_id,
        provider_instance_id: input.handoff.provider_instance_id,
        runtime_session_ref: input.handoff.runtime_session_ref,
        write_attempt_id: input.handoff.write_attempt_id,
        idempotency_key: input.handoff.idempotency_key,
        live_executor_outcome_id: input.live_persistence.outcome_id,
        runtime_receipt_id: input.live_persistence.receipt_id.0,
        durable_linkage,
        status,
        blockers,
        evidence_refs: unique_sorted(evidence_refs),
        provider_write_executed: input.live_persistence.provider_write_executed,
        raw_payload_persisted: false,
        raw_stream_persisted: false,
        task_mutation_permitted: false,
        review_acceptance_permitted: false,
        callback_answer_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        replacement_thread_promotion_permitted: false,
        scm_mutation_permitted: false,
    }
}

fn persistence_blockers(
    input: &DurableDispatchOutcomePersistenceInput,
) -> Vec<DurableDispatchOutcomePersistenceBlocker> {
    let mut blockers = Vec::new();

    if input.handoff.status != DurableDispatchExecutorHandoffStatus::ReadyForLiveExecutorBoundary {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::HandoffNotReady);
    }
    if input.handoff.provider_write_executed {
        blockers
            .push(DurableDispatchOutcomePersistenceBlocker::HandoffAlreadyExecutedProviderWrite);
    }
    if handoff_permits_forbidden_authority(&input.handoff) {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::HandoffPermitsForbiddenAuthority);
    }
    identity_blockers(input, &mut blockers);
    persistence_authority_blockers(input, &mut blockers);
    requested_authority_blockers(input, &mut blockers);

    blockers
}

fn handoff_permits_forbidden_authority(handoff: &DurableDispatchExecutorHandoffRecord) -> bool {
    handoff.raw_payload_retained
        || handoff.raw_stream_retained
        || handoff.task_mutation_permitted
        || handoff.review_acceptance_permitted
        || handoff.callback_answer_permitted
        || handoff.interruption_permitted
        || handoff.recovery_permitted
        || handoff.replacement_thread_promotion_permitted
        || handoff.scm_mutation_permitted
}

fn identity_blockers(
    input: &DurableDispatchOutcomePersistenceInput,
    blockers: &mut Vec<DurableDispatchOutcomePersistenceBlocker>,
) {
    if input.handoff.command_id != input.command.command_id.0 {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::CommandIdMismatch);
    }
    if input.handoff.admission_id != input.admission.admission_id.0 {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::AdmissionIdMismatch);
    }
    if input.handoff.provider_instance_id != input.outcome.provider_instance_id {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::ProviderInstanceMismatch);
    }
    if input.handoff.write_attempt_id != input.outcome.write_attempt_id
        || input.handoff.write_attempt_id != input.live_persistence.write_attempt_id
    {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::WriteAttemptMismatch);
    }
    if input.outcome.outcome_id.0 != input.live_persistence.outcome_id {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::PersistenceOutcomeMismatch);
    }
    if !input
        .outcome
        .receipt_refs
        .contains(&input.live_persistence.receipt_id.0)
    {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::PersistenceReceiptMismatch);
    }
    if input
        .persisted_write_attempt_ids
        .contains(&input.handoff.write_attempt_id)
    {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::DuplicatePersistedWriteAttempt);
    }
    if input.persistence_evidence_refs.is_empty()
        || input
            .persistence_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::MissingPersistenceEvidence);
    }
}

fn persistence_authority_blockers(
    input: &DurableDispatchOutcomePersistenceInput,
    blockers: &mut Vec<DurableDispatchOutcomePersistenceBlocker>,
) {
    if input.live_persistence.raw_payload_persisted {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::RawPayloadPersisted);
    }
    if input.live_persistence.raw_stream_persisted {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::RawStreamPersisted);
    }
    if input.live_persistence.task_mutation_permitted {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::PersistencePermitsTaskMutation);
    }
}

fn requested_authority_blockers(
    input: &DurableDispatchOutcomePersistenceInput,
    blockers: &mut Vec<DurableDispatchOutcomePersistenceBlocker>,
) {
    if input.raw_provider_material_retained {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::RawProviderMaterialRetained);
    }
    if input.raw_callback_material_retained {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::RawCallbackMaterialRetained);
    }
    if input.task_mutation_requested {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::TaskMutationRequested);
    }
    if input.review_acceptance_requested {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::ReviewAcceptanceRequested);
    }
    if input.callback_answer_requested {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::CallbackAnswerRequested);
    }
    if input.interruption_requested {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::RecoveryRequested);
    }
    if input.replacement_thread_promotion_requested {
        blockers
            .push(DurableDispatchOutcomePersistenceBlocker::ReplacementThreadPromotionRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(DurableDispatchOutcomePersistenceBlocker::ScmMutationRequested);
    }
}

fn linkage_evidence_refs(
    input: &DurableDispatchOutcomePersistenceInput,
    blockers: &[DurableDispatchOutcomePersistenceBlocker],
) -> Vec<String> {
    if blockers.is_empty() {
        input.persistence_evidence_refs.clone()
    } else {
        vec!["durable-dispatch-outcome-persistence:blocker".to_owned()]
    }
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests;
