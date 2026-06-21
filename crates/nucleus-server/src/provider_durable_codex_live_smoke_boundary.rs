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
mod tests;
