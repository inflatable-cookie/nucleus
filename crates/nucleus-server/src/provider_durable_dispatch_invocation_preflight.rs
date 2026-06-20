//! Durable dispatch invocation preflight records.
//!
//! These records decide whether an accepted durable dispatch admission may
//! proceed toward executor invocation. Preflight does not invoke an executor,
//! execute provider writes, retain raw material, or mutate task state.

use serde::{Deserialize, Serialize};

use crate::{
    DurableProviderExecutorDispatchAdmissionRecord, DurableProviderExecutorDispatchAdmissionStatus,
    DurableProviderExecutorLane, DurableProviderExecutorMethod,
};

/// Stable id for one durable dispatch invocation preflight.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct DurableDispatchInvocationPreflightId(pub String);

/// Input for durable dispatch invocation preflight.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableDispatchInvocationPreflightInput {
    pub admission: DurableProviderExecutorDispatchAdmissionRecord,
    pub operator_confirmation_ref: Option<String>,
    pub provider_ready_evidence_refs: Vec<String>,
    pub runtime_session_evidence_refs: Vec<String>,
    pub invocation_evidence_refs: Vec<String>,
    pub supported_methods: Vec<DurableProviderExecutorMethod>,
    pub in_flight_invocation_attempt_ids: Vec<String>,
    pub stale_admission_evidence: bool,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub executor_invocation_requested: bool,
    pub background_execution_requested: bool,
    pub provider_write_requested: bool,
    pub raw_provider_material_requested: bool,
    pub raw_callback_material_requested: bool,
    pub task_mutation_requested: bool,
    pub review_acceptance_requested: bool,
    pub callback_answer_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
    pub replacement_thread_promotion_requested: bool,
    pub scm_mutation_requested: bool,
}

/// Durable dispatch invocation preflight record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableDispatchInvocationPreflightRecord {
    pub preflight_id: DurableDispatchInvocationPreflightId,
    pub admission_id: String,
    pub selection_id: String,
    pub command_id: String,
    pub dispatch_attempt_id: String,
    pub lane: DurableProviderExecutorLane,
    pub lane_admission_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub task_id: Option<String>,
    pub work_item_id: Option<String>,
    pub method: DurableProviderExecutorMethod,
    pub status: DurableDispatchInvocationPreflightStatus,
    pub blockers: Vec<DurableDispatchInvocationPreflightBlocker>,
    pub evidence_refs: Vec<String>,
    pub operator_confirmation_ref: Option<String>,
    pub executor_invoked: bool,
    pub provider_write_executed: bool,
    pub client_authority_granted: bool,
    pub raw_provider_material_retained: bool,
    pub raw_callback_material_retained: bool,
    pub task_mutation_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub callback_answer_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub replacement_thread_promotion_permitted: bool,
    pub scm_mutation_permitted: bool,
}

/// Invocation preflight status.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableDispatchInvocationPreflightStatus {
    AcceptedForInvocationRequest,
    Blocked,
}

/// Why durable dispatch invocation preflight is blocked.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableDispatchInvocationPreflightBlocker {
    AdmissionNotAccepted,
    AdmissionAlreadyExecutedProviderWrite,
    AdmissionPermitsForbiddenAuthority,
    MissingOperatorConfirmation,
    MissingProviderReadyEvidence,
    MissingRuntimeSessionEvidence,
    MissingInvocationEvidence,
    UnsupportedProviderMethod,
    DuplicateInFlightInvocationAttempt,
    StaleAdmissionEvidence,
    WriteAttemptMismatch,
    IdempotencyMismatch,
    ExecutorInvocationRequested,
    BackgroundExecutionRequested,
    ProviderWriteRequested,
    RawProviderMaterialRequested,
    RawCallbackMaterialRequested,
    TaskMutationRequested,
    ReviewAcceptanceRequested,
    CallbackAnswerRequested,
    InterruptionRequested,
    RecoveryRequested,
    ReplacementThreadPromotionRequested,
    ScmMutationRequested,
}

/// Build durable dispatch invocation preflight without executing provider I/O.
pub fn durable_dispatch_invocation_preflight(
    input: DurableDispatchInvocationPreflightInput,
) -> DurableDispatchInvocationPreflightRecord {
    let blockers = preflight_blockers(&input);
    let status = if blockers.is_empty() {
        DurableDispatchInvocationPreflightStatus::AcceptedForInvocationRequest
    } else {
        DurableDispatchInvocationPreflightStatus::Blocked
    };
    let mut evidence_refs = input.admission.evidence_refs.clone();
    evidence_refs.extend(input.provider_ready_evidence_refs);
    evidence_refs.extend(input.runtime_session_evidence_refs);
    evidence_refs.extend(input.invocation_evidence_refs);
    if let Some(operator_confirmation_ref) = input.operator_confirmation_ref.as_ref() {
        evidence_refs.push(operator_confirmation_ref.clone());
    }

    DurableDispatchInvocationPreflightRecord {
        preflight_id: DurableDispatchInvocationPreflightId(format!(
            "durable-dispatch-invocation-preflight:{}",
            input.admission.dispatch_attempt_id
        )),
        admission_id: input.admission.admission_id.0,
        selection_id: input.admission.selection_id,
        command_id: input.admission.command_id,
        dispatch_attempt_id: input.admission.dispatch_attempt_id,
        lane: input.admission.lane,
        lane_admission_id: input.admission.lane_admission_id,
        provider_instance_id: input.admission.provider_instance_id,
        runtime_session_ref: input.admission.runtime_session_ref,
        write_attempt_id: input.write_attempt_id,
        idempotency_key: input.idempotency_key,
        task_id: input.admission.task_id,
        work_item_id: input.admission.work_item_id,
        method: input.admission.method,
        status,
        blockers,
        evidence_refs: unique_sorted(evidence_refs),
        operator_confirmation_ref: input.operator_confirmation_ref,
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

fn preflight_blockers(
    input: &DurableDispatchInvocationPreflightInput,
) -> Vec<DurableDispatchInvocationPreflightBlocker> {
    let mut blockers = Vec::new();

    if input.admission.status != DurableProviderExecutorDispatchAdmissionStatus::AcceptedForDispatch
    {
        blockers.push(DurableDispatchInvocationPreflightBlocker::AdmissionNotAccepted);
    }
    if input.admission.provider_write_executed {
        blockers
            .push(DurableDispatchInvocationPreflightBlocker::AdmissionAlreadyExecutedProviderWrite);
    }
    if admission_permits_forbidden_authority(&input.admission) {
        blockers
            .push(DurableDispatchInvocationPreflightBlocker::AdmissionPermitsForbiddenAuthority);
    }
    identity_blockers(input, &mut blockers);
    authority_blockers(input, &mut blockers);

    blockers
}

fn admission_permits_forbidden_authority(
    admission: &DurableProviderExecutorDispatchAdmissionRecord,
) -> bool {
    admission.client_authority_granted
        || admission.raw_provider_material_retained
        || admission.raw_callback_material_retained
        || admission.task_mutation_permitted
        || admission.review_acceptance_permitted
        || admission.callback_answer_permitted
        || admission.interruption_permitted
        || admission.recovery_permitted
        || admission.replacement_thread_promotion_permitted
        || admission.scm_mutation_permitted
}

fn identity_blockers(
    input: &DurableDispatchInvocationPreflightInput,
    blockers: &mut Vec<DurableDispatchInvocationPreflightBlocker>,
) {
    if input
        .operator_confirmation_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(DurableDispatchInvocationPreflightBlocker::MissingOperatorConfirmation);
    }
    if input.provider_ready_evidence_refs.is_empty()
        || input
            .provider_ready_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers.push(DurableDispatchInvocationPreflightBlocker::MissingProviderReadyEvidence);
    }
    if input.runtime_session_evidence_refs.is_empty()
        || input
            .runtime_session_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers.push(DurableDispatchInvocationPreflightBlocker::MissingRuntimeSessionEvidence);
    }
    if input.invocation_evidence_refs.is_empty()
        || input
            .invocation_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers.push(DurableDispatchInvocationPreflightBlocker::MissingInvocationEvidence);
    }
    if !input.supported_methods.contains(&input.admission.method) {
        blockers.push(DurableDispatchInvocationPreflightBlocker::UnsupportedProviderMethod);
    }
    if input
        .in_flight_invocation_attempt_ids
        .iter()
        .any(|value| value == &input.admission.dispatch_attempt_id)
    {
        blockers
            .push(DurableDispatchInvocationPreflightBlocker::DuplicateInFlightInvocationAttempt);
    }
    if input.stale_admission_evidence {
        blockers.push(DurableDispatchInvocationPreflightBlocker::StaleAdmissionEvidence);
    }
    if input.write_attempt_id != input.admission.write_attempt_id {
        blockers.push(DurableDispatchInvocationPreflightBlocker::WriteAttemptMismatch);
    }
    if input.idempotency_key != input.admission.idempotency_key {
        blockers.push(DurableDispatchInvocationPreflightBlocker::IdempotencyMismatch);
    }
}

fn authority_blockers(
    input: &DurableDispatchInvocationPreflightInput,
    blockers: &mut Vec<DurableDispatchInvocationPreflightBlocker>,
) {
    if input.executor_invocation_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::ExecutorInvocationRequested);
    }
    if input.background_execution_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::BackgroundExecutionRequested);
    }
    if input.provider_write_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::ProviderWriteRequested);
    }
    if input.raw_provider_material_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::RawProviderMaterialRequested);
    }
    if input.raw_callback_material_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::RawCallbackMaterialRequested);
    }
    if input.task_mutation_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::TaskMutationRequested);
    }
    if input.review_acceptance_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::ReviewAcceptanceRequested);
    }
    if input.callback_answer_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::CallbackAnswerRequested);
    }
    if input.interruption_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::RecoveryRequested);
    }
    if input.replacement_thread_promotion_requested {
        blockers
            .push(DurableDispatchInvocationPreflightBlocker::ReplacementThreadPromotionRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::ScmMutationRequested);
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
        durable_provider_executor_command, durable_provider_executor_dispatch_admission,
        durable_provider_executor_dispatch_selection, DurableProviderExecutorCommandId,
        DurableProviderExecutorCommandInput, DurableProviderExecutorDispatchAdmissionInput,
        DurableProviderExecutorDispatchSelectionInput, DurableProviderExecutorLane,
        DurableProviderExecutorMethod,
    };

    fn admission() -> DurableProviderExecutorDispatchAdmissionRecord {
        durable_provider_executor_dispatch_admission(
            DurableProviderExecutorDispatchAdmissionInput {
                selection: durable_provider_executor_dispatch_selection(
                    DurableProviderExecutorDispatchSelectionInput {
                        command: durable_provider_executor_command(
                            DurableProviderExecutorCommandInput {
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
                                evidence_refs: vec!["evidence:command:1".to_owned()],
                                operator_confirmation_ref: Some(
                                    "operator-confirmation:1".to_owned(),
                                ),
                                client_authority_requested: false,
                                invoke_executor_requested: false,
                                raw_provider_material_requested: false,
                                raw_callback_material_requested: false,
                                task_mutation_requested: false,
                                review_acceptance_requested: false,
                                callback_answer_requested: false,
                                interruption_requested: false,
                                recovery_requested: false,
                                replacement_thread_promotion_requested: false,
                                scm_mutation_requested: false,
                            },
                        ),
                        latest_status: None,
                        provider_ready_evidence_refs: vec!["evidence:provider-ready:1".to_owned()],
                        runtime_ready_evidence_refs: vec!["evidence:runtime-ready:1".to_owned()],
                        selection_evidence_refs: vec!["evidence:selection:1".to_owned()],
                        in_flight_write_attempt_ids: Vec::new(),
                        stale_command_evidence: false,
                        background_execution_requested: false,
                        provider_write_requested: false,
                        raw_provider_material_requested: false,
                        raw_callback_material_requested: false,
                        task_mutation_requested: false,
                        review_acceptance_requested: false,
                        callback_answer_requested: false,
                        interruption_requested: false,
                        recovery_requested: false,
                        replacement_thread_promotion_requested: false,
                        scm_mutation_requested: false,
                    },
                ),
                dispatch_attempt_id: "dispatch-attempt:1".to_owned(),
                operator_confirmation_ref: Some("operator-confirmation:dispatch:1".to_owned()),
                runtime_session_evidence_refs: vec!["evidence:runtime-session:1".to_owned()],
                provider_ready_evidence_refs: vec!["evidence:provider-ready:admission:1".to_owned()],
                admission_evidence_refs: vec!["evidence:admission:1".to_owned()],
                write_attempt_id: "provider-transport-write:1".to_owned(),
                idempotency_key: "idempotency:1".to_owned(),
                invoke_executor_requested: false,
                background_execution_requested: false,
                provider_write_requested: false,
                raw_provider_material_requested: false,
                raw_callback_material_requested: false,
                task_mutation_requested: false,
                review_acceptance_requested: false,
                callback_answer_requested: false,
                interruption_requested: false,
                recovery_requested: false,
                replacement_thread_promotion_requested: false,
                scm_mutation_requested: false,
            },
        )
    }

    fn input() -> DurableDispatchInvocationPreflightInput {
        DurableDispatchInvocationPreflightInput {
            admission: admission(),
            operator_confirmation_ref: Some("operator-confirmation:invoke:1".to_owned()),
            provider_ready_evidence_refs: vec!["evidence:provider-ready:invoke:1".to_owned()],
            runtime_session_evidence_refs: vec!["evidence:runtime-session:invoke:1".to_owned()],
            invocation_evidence_refs: vec!["evidence:invocation:1".to_owned()],
            supported_methods: vec![DurableProviderExecutorMethod::TurnStart],
            in_flight_invocation_attempt_ids: Vec::new(),
            stale_admission_evidence: false,
            write_attempt_id: "provider-transport-write:1".to_owned(),
            idempotency_key: "idempotency:1".to_owned(),
            executor_invocation_requested: false,
            background_execution_requested: false,
            provider_write_requested: false,
            raw_provider_material_requested: false,
            raw_callback_material_requested: false,
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
    fn durable_dispatch_invocation_preflight_accepts_admission_without_execution() {
        let record = durable_dispatch_invocation_preflight(input());

        assert_eq!(
            record.status,
            DurableDispatchInvocationPreflightStatus::AcceptedForInvocationRequest
        );
        assert!(record.blockers.is_empty());
        assert_eq!(record.command_id, "durable-provider-executor-command:1");
        assert_eq!(record.dispatch_attempt_id, "dispatch-attempt:1");
        assert_eq!(record.method, DurableProviderExecutorMethod::TurnStart);
        assert!(!record.executor_invoked);
        assert!(!record.provider_write_executed);
        assert!(!record.client_authority_granted);
        assert!(!record.task_mutation_permitted);
    }

    #[test]
    fn durable_dispatch_invocation_preflight_blocks_missing_evidence_and_identity_mismatch() {
        let mut input = input();
        input.operator_confirmation_ref = None;
        input.provider_ready_evidence_refs.clear();
        input.runtime_session_evidence_refs = vec![String::new()];
        input.invocation_evidence_refs.clear();
        input.supported_methods.clear();
        input
            .in_flight_invocation_attempt_ids
            .push("dispatch-attempt:1".to_owned());
        input.stale_admission_evidence = true;
        input.write_attempt_id = "provider-transport-write:other".to_owned();
        input.idempotency_key = "idempotency:other".to_owned();

        let record = durable_dispatch_invocation_preflight(input);

        assert_eq!(
            record.status,
            DurableDispatchInvocationPreflightStatus::Blocked
        );
        assert!(record
            .blockers
            .contains(&DurableDispatchInvocationPreflightBlocker::MissingOperatorConfirmation));
        assert!(record
            .blockers
            .contains(&DurableDispatchInvocationPreflightBlocker::MissingProviderReadyEvidence));
        assert!(record
            .blockers
            .contains(&DurableDispatchInvocationPreflightBlocker::MissingRuntimeSessionEvidence));
        assert!(record
            .blockers
            .contains(&DurableDispatchInvocationPreflightBlocker::MissingInvocationEvidence));
        assert!(record
            .blockers
            .contains(&DurableDispatchInvocationPreflightBlocker::UnsupportedProviderMethod));
        assert!(record.blockers.contains(
            &DurableDispatchInvocationPreflightBlocker::DuplicateInFlightInvocationAttempt
        ));
        assert!(record
            .blockers
            .contains(&DurableDispatchInvocationPreflightBlocker::StaleAdmissionEvidence));
        assert!(record
            .blockers
            .contains(&DurableDispatchInvocationPreflightBlocker::WriteAttemptMismatch));
        assert!(record
            .blockers
            .contains(&DurableDispatchInvocationPreflightBlocker::IdempotencyMismatch));
    }

    #[test]
    fn durable_dispatch_invocation_preflight_blocks_authority_widening() {
        let mut input = input();
        input.executor_invocation_requested = true;
        input.background_execution_requested = true;
        input.provider_write_requested = true;
        input.raw_provider_material_requested = true;
        input.raw_callback_material_requested = true;
        input.task_mutation_requested = true;
        input.review_acceptance_requested = true;
        input.callback_answer_requested = true;
        input.interruption_requested = true;
        input.recovery_requested = true;
        input.replacement_thread_promotion_requested = true;
        input.scm_mutation_requested = true;

        let record = durable_dispatch_invocation_preflight(input);

        assert!(record
            .blockers
            .contains(&DurableDispatchInvocationPreflightBlocker::ExecutorInvocationRequested));
        assert!(record
            .blockers
            .contains(&DurableDispatchInvocationPreflightBlocker::BackgroundExecutionRequested));
        assert!(record
            .blockers
            .contains(&DurableDispatchInvocationPreflightBlocker::ProviderWriteRequested));
        assert!(record
            .blockers
            .contains(&DurableDispatchInvocationPreflightBlocker::TaskMutationRequested));
        assert!(record
            .blockers
            .contains(&DurableDispatchInvocationPreflightBlocker::ScmMutationRequested));
    }

    #[test]
    fn durable_dispatch_invocation_preflight_blocks_non_accepted_admission() {
        let mut input = input();
        input.admission.status = DurableProviderExecutorDispatchAdmissionStatus::Blocked;

        let record = durable_dispatch_invocation_preflight(input);

        assert!(record
            .blockers
            .contains(&DurableDispatchInvocationPreflightBlocker::AdmissionNotAccepted));
    }
}
