//! Durable provider executor dispatch admission records.
//!
//! These records gate a selected durable executor command before any executor
//! call can happen. Admission remains execution-free and authority-free.

use serde::{Deserialize, Serialize};

use crate::{
    DurableProviderExecutorDispatchSelectionRecord, DurableProviderExecutorDispatchSelectionStatus,
    DurableProviderExecutorLane, DurableProviderExecutorMethod,
};

/// Stable id for one durable executor dispatch admission record.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct DurableProviderExecutorDispatchAdmissionId(pub String);

/// Input for admitting a selected durable executor command to dispatch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableProviderExecutorDispatchAdmissionInput {
    pub selection: DurableProviderExecutorDispatchSelectionRecord,
    pub dispatch_attempt_id: String,
    pub operator_confirmation_ref: Option<String>,
    pub runtime_session_evidence_refs: Vec<String>,
    pub provider_ready_evidence_refs: Vec<String>,
    pub admission_evidence_refs: Vec<String>,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub invoke_executor_requested: bool,
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

/// Durable executor dispatch admission record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableProviderExecutorDispatchAdmissionRecord {
    pub admission_id: DurableProviderExecutorDispatchAdmissionId,
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
    pub status: DurableProviderExecutorDispatchAdmissionStatus,
    pub blockers: Vec<DurableProviderExecutorDispatchAdmissionBlocker>,
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

/// Dispatch admission status.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableProviderExecutorDispatchAdmissionStatus {
    AcceptedForDispatch,
    Blocked,
}

/// Why dispatch admission is blocked.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableProviderExecutorDispatchAdmissionBlocker {
    SelectionNotAccepted,
    SelectionAlreadySelectedProviderWrite,
    SelectionPermitsForbiddenAuthority,
    MissingDispatchAttemptId,
    MissingOperatorConfirmation,
    MissingRuntimeSessionEvidence,
    MissingProviderReadyEvidence,
    MissingAdmissionEvidence,
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

/// Admit a selected durable executor command to dispatch without execution.
pub fn durable_provider_executor_dispatch_admission(
    input: DurableProviderExecutorDispatchAdmissionInput,
) -> DurableProviderExecutorDispatchAdmissionRecord {
    let blockers = admission_blockers(&input);
    let status = if blockers.is_empty() {
        DurableProviderExecutorDispatchAdmissionStatus::AcceptedForDispatch
    } else {
        DurableProviderExecutorDispatchAdmissionStatus::Blocked
    };
    let mut evidence_refs = input.selection.evidence_refs.clone();
    evidence_refs.extend(input.runtime_session_evidence_refs);
    evidence_refs.extend(input.provider_ready_evidence_refs);
    evidence_refs.extend(input.admission_evidence_refs);
    if let Some(operator_confirmation_ref) = input.operator_confirmation_ref.as_ref() {
        evidence_refs.push(operator_confirmation_ref.clone());
    }

    DurableProviderExecutorDispatchAdmissionRecord {
        admission_id: DurableProviderExecutorDispatchAdmissionId(format!(
            "durable-provider-executor-dispatch-admission:{}",
            input.dispatch_attempt_id
        )),
        selection_id: input.selection.selection_id.0,
        command_id: input.selection.command_id,
        dispatch_attempt_id: input.dispatch_attempt_id,
        lane: input.selection.lane,
        lane_admission_id: input.selection.lane_admission_id,
        provider_instance_id: input.selection.provider_instance_id,
        runtime_session_ref: input.selection.runtime_session_ref,
        write_attempt_id: input.write_attempt_id,
        idempotency_key: input.idempotency_key,
        task_id: input.selection.task_id,
        work_item_id: input.selection.work_item_id,
        method: input.selection.method,
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

fn admission_blockers(
    input: &DurableProviderExecutorDispatchAdmissionInput,
) -> Vec<DurableProviderExecutorDispatchAdmissionBlocker> {
    let mut blockers = Vec::new();

    if input.selection.status
        != DurableProviderExecutorDispatchSelectionStatus::SelectedForDispatchAdmission
    {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::SelectionNotAccepted);
    }
    if input.selection.provider_write_selected {
        blockers.push(
            DurableProviderExecutorDispatchAdmissionBlocker::SelectionAlreadySelectedProviderWrite,
        );
    }
    if selection_permits_forbidden_authority(&input.selection) {
        blockers.push(
            DurableProviderExecutorDispatchAdmissionBlocker::SelectionPermitsForbiddenAuthority,
        );
    }
    identity_blockers(input, &mut blockers);
    requested_authority_blockers(input, &mut blockers);

    blockers
}

fn selection_permits_forbidden_authority(
    selection: &DurableProviderExecutorDispatchSelectionRecord,
) -> bool {
    selection.client_authority_granted
        || selection.raw_provider_material_retained
        || selection.raw_callback_material_retained
        || selection.task_mutation_permitted
        || selection.review_acceptance_permitted
        || selection.callback_answer_permitted
        || selection.interruption_permitted
        || selection.recovery_permitted
        || selection.replacement_thread_promotion_permitted
        || selection.scm_mutation_permitted
}

fn identity_blockers(
    input: &DurableProviderExecutorDispatchAdmissionInput,
    blockers: &mut Vec<DurableProviderExecutorDispatchAdmissionBlocker>,
) {
    if input.dispatch_attempt_id.is_empty() {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::MissingDispatchAttemptId);
    }
    if input
        .operator_confirmation_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::MissingOperatorConfirmation);
    }
    if input.runtime_session_evidence_refs.is_empty()
        || input
            .runtime_session_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers
            .push(DurableProviderExecutorDispatchAdmissionBlocker::MissingRuntimeSessionEvidence);
    }
    if input.provider_ready_evidence_refs.is_empty()
        || input
            .provider_ready_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers
            .push(DurableProviderExecutorDispatchAdmissionBlocker::MissingProviderReadyEvidence);
    }
    if input.admission_evidence_refs.is_empty()
        || input
            .admission_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::MissingAdmissionEvidence);
    }
    if input.write_attempt_id != input.selection.write_attempt_id {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::WriteAttemptMismatch);
    }
    if input.idempotency_key != input.selection.idempotency_key {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::IdempotencyMismatch);
    }
}

fn requested_authority_blockers(
    input: &DurableProviderExecutorDispatchAdmissionInput,
    blockers: &mut Vec<DurableProviderExecutorDispatchAdmissionBlocker>,
) {
    if input.invoke_executor_requested {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::ExecutorInvocationRequested);
    }
    if input.background_execution_requested {
        blockers
            .push(DurableProviderExecutorDispatchAdmissionBlocker::BackgroundExecutionRequested);
    }
    if input.provider_write_requested {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::ProviderWriteRequested);
    }
    if input.raw_provider_material_requested {
        blockers
            .push(DurableProviderExecutorDispatchAdmissionBlocker::RawProviderMaterialRequested);
    }
    if input.raw_callback_material_requested {
        blockers
            .push(DurableProviderExecutorDispatchAdmissionBlocker::RawCallbackMaterialRequested);
    }
    if input.task_mutation_requested {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::TaskMutationRequested);
    }
    if input.review_acceptance_requested {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::ReviewAcceptanceRequested);
    }
    if input.callback_answer_requested {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::CallbackAnswerRequested);
    }
    if input.interruption_requested {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::RecoveryRequested);
    }
    if input.replacement_thread_promotion_requested {
        blockers.push(
            DurableProviderExecutorDispatchAdmissionBlocker::ReplacementThreadPromotionRequested,
        );
    }
    if input.scm_mutation_requested {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::ScmMutationRequested);
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
        durable_provider_executor_command, durable_provider_executor_dispatch_selection,
        DurableProviderExecutorCommandId, DurableProviderExecutorCommandInput,
        DurableProviderExecutorDispatchSelectionBlocker,
        DurableProviderExecutorDispatchSelectionInput, DurableProviderExecutorLane,
        DurableProviderExecutorMethod,
    };

    fn selection() -> DurableProviderExecutorDispatchSelectionRecord {
        durable_provider_executor_dispatch_selection(
            DurableProviderExecutorDispatchSelectionInput {
                command: durable_provider_executor_command(DurableProviderExecutorCommandInput {
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
                    operator_confirmation_ref: Some("operator-confirmation:1".to_owned()),
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
                }),
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
        )
    }

    fn input() -> DurableProviderExecutorDispatchAdmissionInput {
        DurableProviderExecutorDispatchAdmissionInput {
            selection: selection(),
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
        }
    }

    #[test]
    fn durable_executor_dispatch_admission_accepts_selection_without_execution() {
        let record = durable_provider_executor_dispatch_admission(input());

        assert_eq!(
            record.status,
            DurableProviderExecutorDispatchAdmissionStatus::AcceptedForDispatch
        );
        assert!(record.blockers.is_empty());
        assert_eq!(record.command_id, "durable-provider-executor-command:1");
        assert_eq!(record.dispatch_attempt_id, "dispatch-attempt:1");
        assert_eq!(record.task_id.as_deref(), Some("task:1"));
        assert!(!record.executor_invoked);
        assert!(!record.provider_write_executed);
        assert!(!record.client_authority_granted);
        assert!(!record.task_mutation_permitted);
    }

    #[test]
    fn durable_executor_dispatch_admission_blocks_non_accepted_selection() {
        let mut input = input();
        input.selection.status = DurableProviderExecutorDispatchSelectionStatus::Blocked;
        input
            .selection
            .blockers
            .push(DurableProviderExecutorDispatchSelectionBlocker::MissingSelectionEvidence);

        let record = durable_provider_executor_dispatch_admission(input);

        assert_eq!(
            record.status,
            DurableProviderExecutorDispatchAdmissionStatus::Blocked
        );
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorDispatchAdmissionBlocker::SelectionNotAccepted));
    }

    #[test]
    fn durable_executor_dispatch_admission_blocks_missing_evidence_and_identity_mismatch() {
        let mut input = input();
        input.dispatch_attempt_id.clear();
        input.operator_confirmation_ref = None;
        input.runtime_session_evidence_refs.clear();
        input.provider_ready_evidence_refs = vec![String::new()];
        input.admission_evidence_refs.clear();
        input.write_attempt_id = "provider-transport-write:other".to_owned();
        input.idempotency_key = "idempotency:other".to_owned();

        let record = durable_provider_executor_dispatch_admission(input);

        assert!(record
            .blockers
            .contains(&DurableProviderExecutorDispatchAdmissionBlocker::MissingDispatchAttemptId));
        assert!(record.blockers.contains(
            &DurableProviderExecutorDispatchAdmissionBlocker::MissingOperatorConfirmation
        ));
        assert!(record.blockers.contains(
            &DurableProviderExecutorDispatchAdmissionBlocker::MissingRuntimeSessionEvidence
        ));
        assert!(record.blockers.contains(
            &DurableProviderExecutorDispatchAdmissionBlocker::MissingProviderReadyEvidence
        ));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorDispatchAdmissionBlocker::MissingAdmissionEvidence));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorDispatchAdmissionBlocker::WriteAttemptMismatch));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorDispatchAdmissionBlocker::IdempotencyMismatch));
    }

    #[test]
    fn durable_executor_dispatch_admission_blocks_authority_widening() {
        let mut input = input();
        input.invoke_executor_requested = true;
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

        let record = durable_provider_executor_dispatch_admission(input);

        assert!(record.blockers.contains(
            &DurableProviderExecutorDispatchAdmissionBlocker::ExecutorInvocationRequested
        ));
        assert!(record.blockers.contains(
            &DurableProviderExecutorDispatchAdmissionBlocker::BackgroundExecutionRequested
        ));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorDispatchAdmissionBlocker::ProviderWriteRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorDispatchAdmissionBlocker::TaskMutationRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorDispatchAdmissionBlocker::ScmMutationRequested));
    }
}
