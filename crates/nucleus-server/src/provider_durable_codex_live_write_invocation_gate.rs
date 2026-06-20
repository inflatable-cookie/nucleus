//! Durable Codex live provider-write invocation gate.
//!
//! This is the final record before a live smoke runner may invoke provider I/O.
//! The gate itself remains execution-free.

use serde::{Deserialize, Serialize};

use crate::{DurableCodexLiveSmokeBoundaryRecord, DurableCodexLiveSmokeBoundaryStatus};

/// Stable id for one durable live provider-write invocation gate.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct DurableCodexLiveProviderWriteInvocationGateId(pub String);

/// Input for the durable live provider-write invocation gate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableCodexLiveProviderWriteInvocationGateInput {
    pub boundary: DurableCodexLiveSmokeBoundaryRecord,
    pub invocation_evidence_refs: Vec<String>,
    pub executor_invocation_requested: bool,
    pub provider_write_requested: bool,
    pub raw_provider_material_requested: bool,
    pub raw_stream_requested: bool,
    pub task_mutation_requested: bool,
    pub review_acceptance_requested: bool,
    pub callback_answer_requested: bool,
    pub cancellation_requested: bool,
    pub resume_requested: bool,
    pub scm_mutation_requested: bool,
}

/// Invocation gate record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableCodexLiveProviderWriteInvocationGateRecord {
    pub gate_id: DurableCodexLiveProviderWriteInvocationGateId,
    pub boundary_id: String,
    pub handoff_id: String,
    pub request_id: String,
    pub command_id: String,
    pub dispatch_attempt_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub status: DurableCodexLiveProviderWriteInvocationGateStatus,
    pub blockers: Vec<DurableCodexLiveProviderWriteInvocationGateBlocker>,
    pub evidence_refs: Vec<String>,
    pub confirmation_ref: Option<String>,
    pub effect_ref: Option<String>,
    pub executor_invocation_ready: bool,
    pub provider_write_ready: bool,
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableCodexLiveProviderWriteInvocationGateStatus {
    ReadyForExplicitInvocation,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableCodexLiveProviderWriteInvocationGateBlocker {
    BoundaryNotEligibleForLiveProviderWrite,
    MissingInvocationEvidence,
    MissingConfirmationRef,
    MissingEffectRef,
    BoundaryAlreadyExecutedProviderWrite,
    BoundaryAlreadyInvokedExecutor,
    BoundaryRetainedRawProviderMaterial,
    BoundaryRetainedRawStream,
    BoundaryPermitsTaskMutation,
    BoundaryPermitsReviewAcceptance,
    BoundaryPermitsCallbackAnswer,
    BoundaryPermitsCancellation,
    BoundaryPermitsResume,
    BoundaryPermitsScmMutation,
    ExecutorInvocationRequestedAtGate,
    ProviderWriteRequestedAtGate,
    RawProviderMaterialRequested,
    RawStreamRequested,
    TaskMutationRequested,
    ReviewAcceptanceRequested,
    CallbackAnswerRequested,
    CancellationRequested,
    ResumeRequested,
    ScmMutationRequested,
}

/// Build the invocation gate without invoking provider I/O.
pub fn durable_codex_live_provider_write_invocation_gate(
    input: DurableCodexLiveProviderWriteInvocationGateInput,
) -> DurableCodexLiveProviderWriteInvocationGateRecord {
    let blockers = gate_blockers(&input);
    let status = if blockers.is_empty() {
        DurableCodexLiveProviderWriteInvocationGateStatus::ReadyForExplicitInvocation
    } else {
        DurableCodexLiveProviderWriteInvocationGateStatus::Blocked
    };
    let mut evidence_refs = input.boundary.evidence_refs.clone();
    evidence_refs.extend(input.invocation_evidence_refs);

    let invocation_ready =
        status == DurableCodexLiveProviderWriteInvocationGateStatus::ReadyForExplicitInvocation;

    DurableCodexLiveProviderWriteInvocationGateRecord {
        gate_id: DurableCodexLiveProviderWriteInvocationGateId(format!(
            "durable-codex-live-provider-write-invocation-gate:{}",
            input.boundary.write_attempt_id
        )),
        boundary_id: input.boundary.boundary_id.0,
        handoff_id: input.boundary.handoff_id,
        request_id: input.boundary.request_id,
        command_id: input.boundary.command_id,
        dispatch_attempt_id: input.boundary.dispatch_attempt_id,
        provider_instance_id: input.boundary.provider_instance_id,
        runtime_session_ref: input.boundary.runtime_session_ref,
        write_attempt_id: input.boundary.write_attempt_id,
        idempotency_key: input.boundary.idempotency_key,
        status,
        blockers,
        evidence_refs: unique_sorted(evidence_refs),
        confirmation_ref: input.boundary.confirmation_ref,
        effect_ref: input.boundary.effect_ref,
        executor_invocation_ready: invocation_ready,
        provider_write_ready: invocation_ready,
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

fn gate_blockers(
    input: &DurableCodexLiveProviderWriteInvocationGateInput,
) -> Vec<DurableCodexLiveProviderWriteInvocationGateBlocker> {
    let mut blockers = Vec::new();

    if input.boundary.status
        != DurableCodexLiveSmokeBoundaryStatus::EligibleForExplicitLiveProviderWrite
    {
        blockers.push(
            DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryNotEligibleForLiveProviderWrite,
        );
    }
    if input.invocation_evidence_refs.is_empty()
        || input
            .invocation_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers
            .push(DurableCodexLiveProviderWriteInvocationGateBlocker::MissingInvocationEvidence);
    }
    if input
        .boundary
        .confirmation_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(DurableCodexLiveProviderWriteInvocationGateBlocker::MissingConfirmationRef);
    }
    if input
        .boundary
        .effect_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(DurableCodexLiveProviderWriteInvocationGateBlocker::MissingEffectRef);
    }
    if input.boundary.provider_write_executed {
        blockers.push(
            DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryAlreadyExecutedProviderWrite,
        );
    }
    if input.boundary.executor_invoked {
        blockers.push(
            DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryAlreadyInvokedExecutor,
        );
    }
    if input.boundary.raw_provider_material_retained {
        blockers.push(
            DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryRetainedRawProviderMaterial,
        );
    }
    if input.boundary.raw_stream_retained {
        blockers
            .push(DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryRetainedRawStream);
    }
    if input.boundary.task_mutation_permitted {
        blockers
            .push(DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryPermitsTaskMutation);
    }
    if input.boundary.review_acceptance_permitted {
        blockers.push(
            DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryPermitsReviewAcceptance,
        );
    }
    if input.boundary.callback_answer_permitted {
        blockers.push(
            DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryPermitsCallbackAnswer,
        );
    }
    if input.boundary.cancellation_permitted {
        blockers
            .push(DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryPermitsCancellation);
    }
    if input.boundary.resume_permitted {
        blockers.push(DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryPermitsResume);
    }
    if input.boundary.scm_mutation_permitted {
        blockers
            .push(DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryPermitsScmMutation);
    }
    requested_authority_blockers(input, &mut blockers);

    blockers
}

fn requested_authority_blockers(
    input: &DurableCodexLiveProviderWriteInvocationGateInput,
    blockers: &mut Vec<DurableCodexLiveProviderWriteInvocationGateBlocker>,
) {
    if input.executor_invocation_requested {
        blockers.push(
            DurableCodexLiveProviderWriteInvocationGateBlocker::ExecutorInvocationRequestedAtGate,
        );
    }
    if input.provider_write_requested {
        blockers
            .push(DurableCodexLiveProviderWriteInvocationGateBlocker::ProviderWriteRequestedAtGate);
    }
    if input.raw_provider_material_requested {
        blockers
            .push(DurableCodexLiveProviderWriteInvocationGateBlocker::RawProviderMaterialRequested);
    }
    if input.raw_stream_requested {
        blockers.push(DurableCodexLiveProviderWriteInvocationGateBlocker::RawStreamRequested);
    }
    if input.task_mutation_requested {
        blockers.push(DurableCodexLiveProviderWriteInvocationGateBlocker::TaskMutationRequested);
    }
    if input.review_acceptance_requested {
        blockers
            .push(DurableCodexLiveProviderWriteInvocationGateBlocker::ReviewAcceptanceRequested);
    }
    if input.callback_answer_requested {
        blockers.push(DurableCodexLiveProviderWriteInvocationGateBlocker::CallbackAnswerRequested);
    }
    if input.cancellation_requested {
        blockers.push(DurableCodexLiveProviderWriteInvocationGateBlocker::CancellationRequested);
    }
    if input.resume_requested {
        blockers.push(DurableCodexLiveProviderWriteInvocationGateBlocker::ResumeRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(DurableCodexLiveProviderWriteInvocationGateBlocker::ScmMutationRequested);
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
        durable_codex_live_smoke_dispatch_run, DurableCodexLiveSmokeDispatchRunInput,
        DurableCodexLiveSmokeIntent,
    };

    #[test]
    fn durable_codex_live_provider_write_invocation_gate_accepts_eligible_boundary_without_io() {
        let record = durable_codex_live_provider_write_invocation_gate(input(eligible_boundary()));

        assert_eq!(
            record.status,
            DurableCodexLiveProviderWriteInvocationGateStatus::ReadyForExplicitInvocation
        );
        assert!(record.blockers.is_empty());
        assert_eq!(record.confirmation_ref.as_deref(), Some("evidence:confirm"));
        assert_eq!(record.effect_ref.as_deref(), Some("evidence:effect"));
        assert!(record.executor_invocation_ready);
        assert!(record.provider_write_ready);
        assert!(!record.provider_write_executed);
        assert!(!record.executor_invoked);
    }

    #[test]
    fn durable_codex_live_provider_write_invocation_gate_blocks_dry_run_boundary() {
        let record = durable_codex_live_provider_write_invocation_gate(input(dry_run_boundary()));

        assert_eq!(
            record.status,
            DurableCodexLiveProviderWriteInvocationGateStatus::Blocked
        );
        assert!(record.blockers.contains(
            &DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryNotEligibleForLiveProviderWrite
        ));
        assert!(record
            .blockers
            .contains(&DurableCodexLiveProviderWriteInvocationGateBlocker::MissingConfirmationRef));
        assert!(record
            .blockers
            .contains(&DurableCodexLiveProviderWriteInvocationGateBlocker::MissingEffectRef));
        assert!(!record.provider_write_executed);
    }

    #[test]
    fn durable_codex_live_provider_write_invocation_gate_blocks_confirmation_only_boundary() {
        let record =
            durable_codex_live_provider_write_invocation_gate(input(confirmation_only_boundary()));

        assert!(record.blockers.contains(
            &DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryNotEligibleForLiveProviderWrite
        ));
        assert!(record
            .blockers
            .contains(&DurableCodexLiveProviderWriteInvocationGateBlocker::MissingEffectRef));
    }

    #[test]
    fn durable_codex_live_provider_write_invocation_gate_blocks_requested_authority() {
        let mut input = input(eligible_boundary());
        input.executor_invocation_requested = true;
        input.provider_write_requested = true;
        input.raw_provider_material_requested = true;
        input.raw_stream_requested = true;
        input.task_mutation_requested = true;
        input.review_acceptance_requested = true;
        input.callback_answer_requested = true;
        input.cancellation_requested = true;
        input.resume_requested = true;
        input.scm_mutation_requested = true;

        let record = durable_codex_live_provider_write_invocation_gate(input);

        assert_eq!(
            record.status,
            DurableCodexLiveProviderWriteInvocationGateStatus::Blocked
        );
        assert!(record.blockers.contains(
            &DurableCodexLiveProviderWriteInvocationGateBlocker::ExecutorInvocationRequestedAtGate
        ));
        assert!(record.blockers.contains(
            &DurableCodexLiveProviderWriteInvocationGateBlocker::ProviderWriteRequestedAtGate
        ));
        assert!(record
            .blockers
            .contains(&DurableCodexLiveProviderWriteInvocationGateBlocker::ScmMutationRequested));
        assert!(!record.provider_write_executed);
    }

    fn input(
        boundary: DurableCodexLiveSmokeBoundaryRecord,
    ) -> DurableCodexLiveProviderWriteInvocationGateInput {
        DurableCodexLiveProviderWriteInvocationGateInput {
            boundary,
            invocation_evidence_refs: vec!["evidence:invocation-gate".to_owned()],
            executor_invocation_requested: false,
            provider_write_requested: false,
            raw_provider_material_requested: false,
            raw_stream_requested: false,
            task_mutation_requested: false,
            review_acceptance_requested: false,
            callback_answer_requested: false,
            cancellation_requested: false,
            resume_requested: false,
            scm_mutation_requested: false,
        }
    }

    fn eligible_boundary() -> DurableCodexLiveSmokeBoundaryRecord {
        durable_codex_live_smoke_dispatch_run(run_input(
            DurableCodexLiveSmokeIntent::ConfirmedRealWriteWithEffect {
                confirmation_ref: "evidence:confirm".to_owned(),
                effect_ref: "evidence:effect".to_owned(),
            },
        ))
        .boundary
    }

    fn dry_run_boundary() -> DurableCodexLiveSmokeBoundaryRecord {
        durable_codex_live_smoke_dispatch_run(run_input(DurableCodexLiveSmokeIntent::DryRunOnly))
            .boundary
    }

    fn confirmation_only_boundary() -> DurableCodexLiveSmokeBoundaryRecord {
        durable_codex_live_smoke_dispatch_run(run_input(
            DurableCodexLiveSmokeIntent::ConfirmedRealWrite {
                confirmation_ref: "evidence:confirm".to_owned(),
            },
        ))
        .boundary
    }

    fn run_input(intent: DurableCodexLiveSmokeIntent) -> DurableCodexLiveSmokeDispatchRunInput {
        DurableCodexLiveSmokeDispatchRunInput {
            intent,
            run_id: "invocation-gate".to_owned(),
            provider_instance_id: "codex:invocation-gate".to_owned(),
            runtime_session_ref: "runtime-session:invocation-gate".to_owned(),
            task_id: "task:invocation-gate".to_owned(),
            work_item_id: "work:invocation-gate".to_owned(),
            operator_confirmation_ref: "operator-confirmation:invocation-gate".to_owned(),
            evidence_refs: vec!["evidence:invocation-gate:command".to_owned()],
        }
    }
}
