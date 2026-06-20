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
        admission_id: "durable-provider-executor-dispatch-admission:dispatch-attempt:1".to_owned(),
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
