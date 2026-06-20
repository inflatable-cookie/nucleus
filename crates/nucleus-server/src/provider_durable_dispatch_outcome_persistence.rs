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
mod tests {
    use super::*;
    use crate::{
        codex_live_executor_outcome_record, CodexAppServerLiveExecutorCleanupStatus,
        CodexAppServerLiveExecutorMethod, CodexAppServerLiveExecutorOutcomeId,
        CodexAppServerLiveExecutorOutcomeInput, CodexAppServerLiveExecutorOutcomeReplayPolicy,
        CodexAppServerLiveExecutorOutcomeStatus, DurableDispatchExecutorHandoffId,
        DurableProviderExecutorCommandId, DurableProviderExecutorCommandStatus,
        DurableProviderExecutorDispatchAdmissionId, DurableProviderExecutorDispatchAdmissionStatus,
        DurableProviderExecutorLane, DurableProviderExecutorMethod,
    };
    use nucleus_engine::EngineRuntimeReceiptRecordId;

    fn command() -> DurableProviderExecutorCommandRecord {
        DurableProviderExecutorCommandRecord {
            command_id: DurableProviderExecutorCommandId(
                "durable-provider-executor-command:1".to_owned(),
            ),
            lane: DurableProviderExecutorLane::TaskBackedTurnStart,
            lane_admission_id: "task-work-live-executor-admission:1".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            runtime_session_ref: "runtime-session:1".to_owned(),
            write_attempt_id: "provider-transport-write:1".to_owned(),
            idempotency_key: "idempotency:1".to_owned(),
            task_id: Some("task:1".to_owned()),
            work_item_id: Some("work:1".to_owned()),
            method: DurableProviderExecutorMethod::TurnStart,
            status: DurableProviderExecutorCommandStatus::AcceptedForPersistence,
            blockers: Vec::new(),
            evidence_refs: vec!["evidence:command:1".to_owned()],
            operator_confirmation_ref: Some("operator-confirmation:1".to_owned()),
            replay_policy:
                crate::DurableProviderExecutorCommandReplayPolicy::InspectOnlyUntilExplicitDispatch,
            executor_invoked: false,
            provider_write_executed: false,
            client_authority_granted: false,
            raw_provider_material_retained: false,
            raw_callback_material_retained: false,
            task_mutation_permitted: false,
            review_acceptance_permitted: false,
            callback_answer_permitted: false,
            interruption_permitted: false,
            recovery_permitted: false,
            replacement_thread_promotion_permitted: false,
            scm_mutation_permitted: false,
        }
    }

    fn admission() -> DurableProviderExecutorDispatchAdmissionRecord {
        DurableProviderExecutorDispatchAdmissionRecord {
            admission_id: DurableProviderExecutorDispatchAdmissionId(
                "durable-provider-executor-dispatch-admission:dispatch-attempt:1".to_owned(),
            ),
            selection_id: "selection:1".to_owned(),
            command_id: "durable-provider-executor-command:1".to_owned(),
            dispatch_attempt_id: "dispatch-attempt:1".to_owned(),
            lane: DurableProviderExecutorLane::TaskBackedTurnStart,
            lane_admission_id: "task-work-live-executor-admission:1".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            runtime_session_ref: "runtime-session:1".to_owned(),
            write_attempt_id: "provider-transport-write:1".to_owned(),
            idempotency_key: "idempotency:1".to_owned(),
            task_id: Some("task:1".to_owned()),
            work_item_id: Some("work:1".to_owned()),
            method: DurableProviderExecutorMethod::TurnStart,
            status: DurableProviderExecutorDispatchAdmissionStatus::AcceptedForDispatch,
            blockers: Vec::new(),
            evidence_refs: vec!["evidence:admission:1".to_owned()],
            operator_confirmation_ref: Some("operator-confirmation:dispatch:1".to_owned()),
            executor_invoked: false,
            provider_write_executed: false,
            client_authority_granted: false,
            raw_provider_material_retained: false,
            raw_callback_material_retained: false,
            task_mutation_permitted: false,
            review_acceptance_permitted: false,
            callback_answer_permitted: false,
            interruption_permitted: false,
            recovery_permitted: false,
            replacement_thread_promotion_permitted: false,
            scm_mutation_permitted: false,
        }
    }

    fn handoff() -> DurableDispatchExecutorHandoffRecord {
        DurableDispatchExecutorHandoffRecord {
            handoff_id: DurableDispatchExecutorHandoffId(
                "durable-dispatch-executor-handoff:dispatch-attempt:1:provider-transport-write:1"
                    .to_owned(),
            ),
            request_id: "request:1".to_owned(),
            preflight_id: "preflight:1".to_owned(),
            admission_id: "durable-provider-executor-dispatch-admission:dispatch-attempt:1"
                .to_owned(),
            selection_id: "selection:1".to_owned(),
            command_id: "durable-provider-executor-command:1".to_owned(),
            dispatch_attempt_id: "dispatch-attempt:1".to_owned(),
            lane: DurableProviderExecutorLane::TaskBackedTurnStart,
            lane_admission_id: "task-work-live-executor-admission:1".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            runtime_session_ref: "runtime-session:1".to_owned(),
            write_attempt_id: "provider-transport-write:1".to_owned(),
            idempotency_key: "idempotency:1".to_owned(),
            task_id: Some("task:1".to_owned()),
            work_item_id: Some("work:1".to_owned()),
            method: DurableProviderExecutorMethod::TurnStart,
            live_executor_method_sequence: vec![CodexAppServerLiveExecutorMethod::TurnStart],
            payload_ref: Some("payload:1".to_owned()),
            status: DurableDispatchExecutorHandoffStatus::ReadyForLiveExecutorBoundary,
            blockers: Vec::new(),
            evidence_refs: vec!["evidence:handoff:1".to_owned()],
            executor_invoked: false,
            provider_write_executed: false,
            raw_payload_retained: false,
            raw_stream_retained: false,
            task_mutation_permitted: false,
            review_acceptance_permitted: false,
            callback_answer_permitted: false,
            interruption_permitted: false,
            recovery_permitted: false,
            replacement_thread_promotion_permitted: false,
            scm_mutation_permitted: false,
        }
    }

    fn outcome() -> CodexAppServerLiveExecutorOutcomeRecord {
        codex_live_executor_outcome_record(CodexAppServerLiveExecutorOutcomeInput {
            provider_instance_id: "codex:local-default".to_owned(),
            write_attempt_id: "provider-transport-write:1".to_owned(),
            receipt_refs: vec!["receipt:codex-live-executor:provider-transport-write:1".to_owned()],
            thread_id: Some("thread:1".to_owned()),
            turn_id: Some("turn:1".to_owned()),
            final_turn_status: Some("completed".to_owned()),
            status: CodexAppServerLiveExecutorOutcomeStatus::Completed,
            method_sequence: vec![
                CodexAppServerLiveExecutorMethod::Initialize,
                CodexAppServerLiveExecutorMethod::InitializedNotification,
                CodexAppServerLiveExecutorMethod::ThreadStart,
                CodexAppServerLiveExecutorMethod::TurnStart,
                CodexAppServerLiveExecutorMethod::TurnCompleted,
                CodexAppServerLiveExecutorMethod::Cleanup,
            ],
            notification_count: 2,
            server_request_count: 0,
            cleanup_status: CodexAppServerLiveExecutorCleanupStatus::Completed,
            evidence_refs: vec!["evidence:outcome:1".to_owned()],
            provider_write_executed: true,
        })
    }

    fn live_persistence() -> CodexAppServerLiveExecutorOutcomePersistenceRecord {
        CodexAppServerLiveExecutorOutcomePersistenceRecord {
            outcome_id: CodexAppServerLiveExecutorOutcomeId(
                "codex-live-executor-outcome:provider-transport-write:1:completed".to_owned(),
            )
            .0,
            write_attempt_id: "provider-transport-write:1".to_owned(),
            receipt_id: EngineRuntimeReceiptRecordId(
                "receipt:codex-live-executor:provider-transport-write:1".to_owned(),
            ),
            event_id: None,
            replay_policy: CodexAppServerLiveExecutorOutcomeReplayPolicy::InspectOnly,
            provider_write_executed: true,
            raw_payload_persisted: false,
            raw_stream_persisted: false,
            task_mutation_permitted: false,
        }
    }

    fn input() -> DurableDispatchOutcomePersistenceInput {
        DurableDispatchOutcomePersistenceInput {
            handoff: handoff(),
            admission: admission(),
            command: command(),
            outcome: outcome(),
            live_persistence: live_persistence(),
            persisted_write_attempt_ids: Vec::new(),
            persistence_evidence_refs: vec!["evidence:persistence:1".to_owned()],
            raw_provider_material_retained: false,
            raw_callback_material_retained: false,
            task_mutation_requested: false,
            review_acceptance_requested: false,
            callback_answer_requested: false,
            interruption_requested: false,
            recovery_requested: false,
            replacement_thread_promotion_requested: false,
            scm_mutation_requested: false,
        }
    }

    #[test]
    fn durable_dispatch_outcome_persistence_reconciles_sanitized_outcome() {
        let record = durable_dispatch_outcome_persistence(input());

        assert_eq!(
            record.status,
            DurableDispatchOutcomePersistenceStatus::Reconciled
        );
        assert!(record.blockers.is_empty());
        assert_eq!(
            record.durable_linkage.status,
            crate::DurableProviderExecutorDispatchOutcomeLinkageStatus::Linked
        );
        assert!(record.provider_write_executed);
        assert!(!record.raw_payload_persisted);
        assert!(!record.raw_stream_persisted);
        assert!(!record.task_mutation_permitted);
    }

    #[test]
    fn durable_dispatch_outcome_persistence_blocks_duplicates_and_mismatch() {
        let mut input = input();
        input.handoff.status = DurableDispatchExecutorHandoffStatus::Blocked;
        input.command.command_id.0 = "durable-provider-executor-command:other".to_owned();
        input.live_persistence.write_attempt_id = "provider-transport-write:other".to_owned();
        input.live_persistence.outcome_id = "outcome:other".to_owned();
        input.persisted_write_attempt_ids = vec!["provider-transport-write:1".to_owned()];
        input.persistence_evidence_refs.clear();

        let record = durable_dispatch_outcome_persistence(input);

        assert_eq!(
            record.status,
            DurableDispatchOutcomePersistenceStatus::Blocked
        );
        assert!(record
            .blockers
            .contains(&DurableDispatchOutcomePersistenceBlocker::HandoffNotReady));
        assert!(record
            .blockers
            .contains(&DurableDispatchOutcomePersistenceBlocker::CommandIdMismatch));
        assert!(record
            .blockers
            .contains(&DurableDispatchOutcomePersistenceBlocker::WriteAttemptMismatch));
        assert!(record
            .blockers
            .contains(&DurableDispatchOutcomePersistenceBlocker::PersistenceOutcomeMismatch));
        assert!(record
            .blockers
            .contains(&DurableDispatchOutcomePersistenceBlocker::DuplicatePersistedWriteAttempt));
    }

    #[test]
    fn durable_dispatch_outcome_persistence_blocks_authority_widening() {
        let mut input = input();
        input.live_persistence.raw_payload_persisted = true;
        input.live_persistence.raw_stream_persisted = true;
        input.live_persistence.task_mutation_permitted = true;
        input.raw_provider_material_retained = true;
        input.raw_callback_material_retained = true;
        input.task_mutation_requested = true;
        input.review_acceptance_requested = true;
        input.callback_answer_requested = true;
        input.interruption_requested = true;
        input.recovery_requested = true;
        input.replacement_thread_promotion_requested = true;
        input.scm_mutation_requested = true;

        let record = durable_dispatch_outcome_persistence(input);

        assert!(record
            .blockers
            .contains(&DurableDispatchOutcomePersistenceBlocker::RawPayloadPersisted));
        assert!(record
            .blockers
            .contains(&DurableDispatchOutcomePersistenceBlocker::RawStreamPersisted));
        assert!(record
            .blockers
            .contains(&DurableDispatchOutcomePersistenceBlocker::TaskMutationRequested));
        assert!(record
            .blockers
            .contains(&DurableDispatchOutcomePersistenceBlocker::ScmMutationRequested));
    }
}
