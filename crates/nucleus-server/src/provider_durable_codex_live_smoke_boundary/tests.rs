use super::*;
use crate::{CodexAppServerLiveExecutorMethod, DurableDispatchExecutorHandoffId};

#[test]
fn durable_codex_live_smoke_boundary_accepts_dry_run_without_provider_write() {
    let record = durable_codex_live_smoke_boundary(input(DurableCodexLiveSmokeIntent::DryRunOnly));

    assert_eq!(
        record.status,
        DurableCodexLiveSmokeBoundaryStatus::DryRunEligible
    );
    assert!(record.blockers.is_empty());
    assert!(!record.provider_write_executed);
    assert!(!record.executor_invoked);
    assert!(!record.task_mutation_permitted);
    assert!(!record.review_acceptance_permitted);
    assert!(!record.callback_answer_permitted);
    assert!(!record.cancellation_permitted);
    assert!(!record.resume_permitted);
    assert!(!record.scm_mutation_permitted);
}

#[test]
fn durable_codex_live_smoke_boundary_blocks_confirmation_without_effect_flag() {
    let record =
        durable_codex_live_smoke_boundary(input(DurableCodexLiveSmokeIntent::ConfirmedRealWrite {
            confirmation_ref: "evidence:confirm-real-write".to_owned(),
        }));

    assert_eq!(record.status, DurableCodexLiveSmokeBoundaryStatus::Blocked);
    assert_eq!(
        record.blockers,
        vec![DurableCodexLiveSmokeBoundaryBlocker::MissingRealWriteEffectFlag]
    );
    assert_eq!(
        record.confirmation_ref.as_deref(),
        Some("evidence:confirm-real-write")
    );
    assert!(record.effect_ref.is_none());
    assert!(!record.provider_write_executed);
}

#[test]
fn durable_codex_live_smoke_boundary_accepts_explicit_real_write_intent_without_execution() {
    let record = durable_codex_live_smoke_boundary(input(
        DurableCodexLiveSmokeIntent::ConfirmedRealWriteWithEffect {
            confirmation_ref: "evidence:confirm-real-write".to_owned(),
            effect_ref: "evidence:execute-provider-write-flag".to_owned(),
        },
    ));

    assert_eq!(
        record.status,
        DurableCodexLiveSmokeBoundaryStatus::EligibleForExplicitLiveProviderWrite
    );
    assert!(record.blockers.is_empty());
    assert!(record
        .evidence_refs
        .contains(&"evidence:execute-provider-write-flag".to_owned()));
    assert!(!record.provider_write_executed);
    assert!(!record.executor_invoked);
}

#[test]
fn durable_codex_live_smoke_boundary_blocks_authority_widening_and_raw_requests() {
    let mut input = input(DurableCodexLiveSmokeIntent::DryRunOnly);
    input.task_mutation_requested = true;
    input.review_acceptance_requested = true;
    input.callback_answer_requested = true;
    input.cancellation_requested = true;
    input.resume_requested = true;
    input.scm_mutation_requested = true;
    input.raw_provider_material_requested = true;
    input.raw_stream_requested = true;

    let record = durable_codex_live_smoke_boundary(input);

    assert_eq!(record.status, DurableCodexLiveSmokeBoundaryStatus::Blocked);
    assert_eq!(
        record.blockers,
        vec![
            DurableCodexLiveSmokeBoundaryBlocker::TaskMutationRequested,
            DurableCodexLiveSmokeBoundaryBlocker::ReviewAcceptanceRequested,
            DurableCodexLiveSmokeBoundaryBlocker::CallbackAnswerRequested,
            DurableCodexLiveSmokeBoundaryBlocker::CancellationRequested,
            DurableCodexLiveSmokeBoundaryBlocker::ResumeRequested,
            DurableCodexLiveSmokeBoundaryBlocker::ScmMutationRequested,
            DurableCodexLiveSmokeBoundaryBlocker::RawProviderMaterialRequested,
            DurableCodexLiveSmokeBoundaryBlocker::RawStreamRequested,
        ]
    );
    assert!(!record.provider_write_executed);
}

#[test]
fn durable_codex_live_smoke_boundary_blocks_unsafe_handoff_state() {
    let mut input = input(DurableCodexLiveSmokeIntent::DryRunOnly);
    input.handoff.status = DurableDispatchExecutorHandoffStatus::Blocked;
    input.handoff.executor_invoked = true;
    input.handoff.provider_write_executed = true;
    input.handoff.raw_payload_retained = true;
    input.handoff.raw_stream_retained = true;
    input.handoff.task_mutation_permitted = true;
    input.handoff.lane = DurableProviderExecutorLane::CallbackResponse;
    input.handoff.method = DurableProviderExecutorMethod::CallbackResponse;

    let record = durable_codex_live_smoke_boundary(input);

    assert_eq!(record.status, DurableCodexLiveSmokeBoundaryStatus::Blocked);
    assert!(record
        .blockers
        .contains(&DurableCodexLiveSmokeBoundaryBlocker::HandoffNotReady));
    assert!(record
        .blockers
        .contains(&DurableCodexLiveSmokeBoundaryBlocker::HandoffAlreadyInvokedExecutor));
    assert!(record
        .blockers
        .contains(&DurableCodexLiveSmokeBoundaryBlocker::HandoffAlreadyExecutedProviderWrite));
    assert!(record
        .blockers
        .contains(&DurableCodexLiveSmokeBoundaryBlocker::HandoffPermitsForbiddenAuthority));
    assert!(record
        .blockers
        .contains(&DurableCodexLiveSmokeBoundaryBlocker::HandoffRetainedRawPayload));
    assert!(record
        .blockers
        .contains(&DurableCodexLiveSmokeBoundaryBlocker::HandoffRetainedRawStream));
    assert!(record
        .blockers
        .contains(&DurableCodexLiveSmokeBoundaryBlocker::LaneNotTaskBackedTurnStart));
    assert!(record
        .blockers
        .contains(&DurableCodexLiveSmokeBoundaryBlocker::MethodNotTurnStart));
    assert!(!record.provider_write_executed);
}

fn input(intent: DurableCodexLiveSmokeIntent) -> DurableCodexLiveSmokeBoundaryInput {
    DurableCodexLiveSmokeBoundaryInput {
        handoff: handoff(),
        intent,
        smoke_evidence_refs: vec!["evidence:durable-live-smoke".to_owned()],
        task_mutation_requested: false,
        review_acceptance_requested: false,
        callback_answer_requested: false,
        cancellation_requested: false,
        resume_requested: false,
        scm_mutation_requested: false,
        raw_provider_material_requested: false,
        raw_stream_requested: false,
    }
}

fn handoff() -> DurableDispatchExecutorHandoffRecord {
    DurableDispatchExecutorHandoffRecord {
        handoff_id: DurableDispatchExecutorHandoffId("handoff:smoke".to_owned()),
        request_id: "request:smoke".to_owned(),
        preflight_id: "preflight:smoke".to_owned(),
        admission_id: "admission:smoke".to_owned(),
        selection_id: "selection:smoke".to_owned(),
        command_id: "command:smoke".to_owned(),
        dispatch_attempt_id: "dispatch:smoke".to_owned(),
        lane: DurableProviderExecutorLane::TaskBackedTurnStart,
        lane_admission_id: "lane-admission:smoke".to_owned(),
        provider_instance_id: "codex:smoke".to_owned(),
        runtime_session_ref: "runtime-session:smoke".to_owned(),
        write_attempt_id: "write:smoke".to_owned(),
        idempotency_key: "idempotency:smoke".to_owned(),
        task_id: Some("task:smoke".to_owned()),
        work_item_id: Some("work:smoke".to_owned()),
        method: DurableProviderExecutorMethod::TurnStart,
        live_executor_method_sequence: vec![CodexAppServerLiveExecutorMethod::TurnStart],
        payload_ref: Some("payload-ref:smoke".to_owned()),
        status: DurableDispatchExecutorHandoffStatus::ReadyForLiveExecutorBoundary,
        blockers: Vec::new(),
        evidence_refs: vec!["evidence:handoff:smoke".to_owned()],
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
