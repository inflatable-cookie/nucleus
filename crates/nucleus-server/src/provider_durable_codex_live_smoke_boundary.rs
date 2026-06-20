//! Durable Codex live-smoke authority boundary.
//!
//! This boundary decides whether a durable executor handoff is eligible for a
//! dry-run report or a separately invoked live provider smoke. It never invokes
//! the executor, writes to Codex, retains raw material, mutates tasks, accepts
//! reviews, answers callbacks, cancels/resumes provider work, or mutates SCM.

use serde::{Deserialize, Serialize};

use crate::{
    DurableDispatchExecutorHandoffRecord, DurableDispatchExecutorHandoffStatus,
    DurableProviderExecutorLane, DurableProviderExecutorMethod,
};

/// Stable id for one durable Codex live-smoke boundary.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct DurableCodexLiveSmokeBoundaryId(pub String);

/// Operator intent for the durable live smoke.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableCodexLiveSmokeIntent {
    DryRunOnly,
    ConfirmedRealWrite {
        confirmation_ref: String,
    },
    ConfirmedRealWriteWithEffect {
        confirmation_ref: String,
        effect_ref: String,
    },
}

/// Input for durable Codex live-smoke boundary evaluation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableCodexLiveSmokeBoundaryInput {
    pub handoff: DurableDispatchExecutorHandoffRecord,
    pub intent: DurableCodexLiveSmokeIntent,
    pub smoke_evidence_refs: Vec<String>,
    pub task_mutation_requested: bool,
    pub review_acceptance_requested: bool,
    pub callback_answer_requested: bool,
    pub cancellation_requested: bool,
    pub resume_requested: bool,
    pub scm_mutation_requested: bool,
    pub raw_provider_material_requested: bool,
    pub raw_stream_requested: bool,
}

/// Durable smoke boundary record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableCodexLiveSmokeBoundaryRecord {
    pub boundary_id: DurableCodexLiveSmokeBoundaryId,
    pub handoff_id: String,
    pub request_id: String,
    pub command_id: String,
    pub dispatch_attempt_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub status: DurableCodexLiveSmokeBoundaryStatus,
    pub blockers: Vec<DurableCodexLiveSmokeBoundaryBlocker>,
    pub evidence_refs: Vec<String>,
    pub confirmation_ref: Option<String>,
    pub effect_ref: Option<String>,
    pub provider_write_executed: bool,
    pub executor_invoked: bool,
    pub raw_provider_material_retained: bool,
    pub raw_stream_retained: bool,
    pub task_mutation_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub callback_answer_permitted: bool,
    pub cancellation_permitted: bool,
    pub resume_permitted: bool,
    pub scm_mutation_permitted: bool,
}

/// Durable smoke boundary status.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableCodexLiveSmokeBoundaryStatus {
    DryRunEligible,
    EligibleForExplicitLiveProviderWrite,
    Blocked,
}

/// Why durable live-smoke execution is not eligible.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableCodexLiveSmokeBoundaryBlocker {
    HandoffNotReady,
    HandoffAlreadyInvokedExecutor,
    HandoffAlreadyExecutedProviderWrite,
    HandoffPermitsForbiddenAuthority,
    HandoffRetainedRawPayload,
    HandoffRetainedRawStream,
    LaneNotTaskBackedTurnStart,
    MethodNotTurnStart,
    MissingSmokeEvidence,
    MissingRealWriteConfirmation,
    MissingRealWriteEffectFlag,
    TaskMutationRequested,
    ReviewAcceptanceRequested,
    CallbackAnswerRequested,
    CancellationRequested,
    ResumeRequested,
    ScmMutationRequested,
    RawProviderMaterialRequested,
    RawStreamRequested,
}

/// Build the durable live-smoke boundary without provider I/O.
pub fn durable_codex_live_smoke_boundary(
    input: DurableCodexLiveSmokeBoundaryInput,
) -> DurableCodexLiveSmokeBoundaryRecord {
    let mut blockers = boundary_blockers(&input);
    let (confirmation_ref, effect_ref) = intent_refs(&input.intent);
    let intent_status = match &input.intent {
        DurableCodexLiveSmokeIntent::DryRunOnly => {
            DurableCodexLiveSmokeBoundaryStatus::DryRunEligible
        }
        DurableCodexLiveSmokeIntent::ConfirmedRealWrite { .. } => {
            blockers.push(DurableCodexLiveSmokeBoundaryBlocker::MissingRealWriteEffectFlag);
            DurableCodexLiveSmokeBoundaryStatus::Blocked
        }
        DurableCodexLiveSmokeIntent::ConfirmedRealWriteWithEffect { .. } => {
            DurableCodexLiveSmokeBoundaryStatus::EligibleForExplicitLiveProviderWrite
        }
    };
    let status = if blockers.is_empty() {
        intent_status
    } else {
        DurableCodexLiveSmokeBoundaryStatus::Blocked
    };
    let mut evidence_refs = input.handoff.evidence_refs.clone();
    evidence_refs.extend(input.smoke_evidence_refs);
    if let Some(reference) = confirmation_ref.as_ref() {
        evidence_refs.push(reference.clone());
    }
    if let Some(reference) = effect_ref.as_ref() {
        evidence_refs.push(reference.clone());
    }

    DurableCodexLiveSmokeBoundaryRecord {
        boundary_id: DurableCodexLiveSmokeBoundaryId(format!(
            "durable-codex-live-smoke-boundary:{}",
            input.handoff.write_attempt_id
        )),
        handoff_id: input.handoff.handoff_id.0,
        request_id: input.handoff.request_id,
        command_id: input.handoff.command_id,
        dispatch_attempt_id: input.handoff.dispatch_attempt_id,
        provider_instance_id: input.handoff.provider_instance_id,
        runtime_session_ref: input.handoff.runtime_session_ref,
        write_attempt_id: input.handoff.write_attempt_id,
        idempotency_key: input.handoff.idempotency_key,
        status,
        blockers,
        evidence_refs: unique_sorted(evidence_refs),
        confirmation_ref,
        effect_ref,
        provider_write_executed: false,
        executor_invoked: false,
        raw_provider_material_retained: false,
        raw_stream_retained: false,
        task_mutation_permitted: false,
        review_acceptance_permitted: false,
        callback_answer_permitted: false,
        cancellation_permitted: false,
        resume_permitted: false,
        scm_mutation_permitted: false,
    }
}

fn boundary_blockers(
    input: &DurableCodexLiveSmokeBoundaryInput,
) -> Vec<DurableCodexLiveSmokeBoundaryBlocker> {
    let mut blockers = Vec::new();

    if input.handoff.status != DurableDispatchExecutorHandoffStatus::ReadyForLiveExecutorBoundary {
        blockers.push(DurableCodexLiveSmokeBoundaryBlocker::HandoffNotReady);
    }
    if input.handoff.executor_invoked {
        blockers.push(DurableCodexLiveSmokeBoundaryBlocker::HandoffAlreadyInvokedExecutor);
    }
    if input.handoff.provider_write_executed {
        blockers.push(DurableCodexLiveSmokeBoundaryBlocker::HandoffAlreadyExecutedProviderWrite);
    }
    if handoff_permits_forbidden_authority(&input.handoff) {
        blockers.push(DurableCodexLiveSmokeBoundaryBlocker::HandoffPermitsForbiddenAuthority);
    }
    if input.handoff.raw_payload_retained {
        blockers.push(DurableCodexLiveSmokeBoundaryBlocker::HandoffRetainedRawPayload);
    }
    if input.handoff.raw_stream_retained {
        blockers.push(DurableCodexLiveSmokeBoundaryBlocker::HandoffRetainedRawStream);
    }
    if input.handoff.lane != DurableProviderExecutorLane::TaskBackedTurnStart {
        blockers.push(DurableCodexLiveSmokeBoundaryBlocker::LaneNotTaskBackedTurnStart);
    }
    if input.handoff.method != DurableProviderExecutorMethod::TurnStart {
        blockers.push(DurableCodexLiveSmokeBoundaryBlocker::MethodNotTurnStart);
    }
    if input.smoke_evidence_refs.is_empty()
        || input
            .smoke_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers.push(DurableCodexLiveSmokeBoundaryBlocker::MissingSmokeEvidence);
    }
    if matches!(input.intent, DurableCodexLiveSmokeIntent::DryRunOnly)
        && input.handoff.provider_write_executed
    {
        blockers.push(DurableCodexLiveSmokeBoundaryBlocker::MissingRealWriteConfirmation);
    }
    requested_authority_blockers(input, &mut blockers);

    blockers
}

fn handoff_permits_forbidden_authority(handoff: &DurableDispatchExecutorHandoffRecord) -> bool {
    handoff.task_mutation_permitted
        || handoff.review_acceptance_permitted
        || handoff.callback_answer_permitted
        || handoff.interruption_permitted
        || handoff.recovery_permitted
        || handoff.replacement_thread_promotion_permitted
        || handoff.scm_mutation_permitted
}

fn requested_authority_blockers(
    input: &DurableCodexLiveSmokeBoundaryInput,
    blockers: &mut Vec<DurableCodexLiveSmokeBoundaryBlocker>,
) {
    if input.task_mutation_requested {
        blockers.push(DurableCodexLiveSmokeBoundaryBlocker::TaskMutationRequested);
    }
    if input.review_acceptance_requested {
        blockers.push(DurableCodexLiveSmokeBoundaryBlocker::ReviewAcceptanceRequested);
    }
    if input.callback_answer_requested {
        blockers.push(DurableCodexLiveSmokeBoundaryBlocker::CallbackAnswerRequested);
    }
    if input.cancellation_requested {
        blockers.push(DurableCodexLiveSmokeBoundaryBlocker::CancellationRequested);
    }
    if input.resume_requested {
        blockers.push(DurableCodexLiveSmokeBoundaryBlocker::ResumeRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(DurableCodexLiveSmokeBoundaryBlocker::ScmMutationRequested);
    }
    if input.raw_provider_material_requested {
        blockers.push(DurableCodexLiveSmokeBoundaryBlocker::RawProviderMaterialRequested);
    }
    if input.raw_stream_requested {
        blockers.push(DurableCodexLiveSmokeBoundaryBlocker::RawStreamRequested);
    }
}

fn intent_refs(intent: &DurableCodexLiveSmokeIntent) -> (Option<String>, Option<String>) {
    match intent {
        DurableCodexLiveSmokeIntent::DryRunOnly => (None, None),
        DurableCodexLiveSmokeIntent::ConfirmedRealWrite { confirmation_ref } => {
            (Some(confirmation_ref.clone()), None)
        }
        DurableCodexLiveSmokeIntent::ConfirmedRealWriteWithEffect {
            confirmation_ref,
            effect_ref,
        } => (Some(confirmation_ref.clone()), Some(effect_ref.clone())),
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
    use crate::{CodexAppServerLiveExecutorMethod, DurableDispatchExecutorHandoffId};

    #[test]
    fn durable_codex_live_smoke_boundary_accepts_dry_run_without_provider_write() {
        let record =
            durable_codex_live_smoke_boundary(input(DurableCodexLiveSmokeIntent::DryRunOnly));

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
        let record = durable_codex_live_smoke_boundary(input(
            DurableCodexLiveSmokeIntent::ConfirmedRealWrite {
                confirmation_ref: "evidence:confirm-real-write".to_owned(),
            },
        ));

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
}
