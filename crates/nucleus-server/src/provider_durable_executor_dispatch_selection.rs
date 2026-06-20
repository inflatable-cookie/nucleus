//! Durable provider executor dispatch selection records.
//!
//! These records identify durable executor commands that may be considered for
//! dispatch. Selection is read-only: it does not invoke an executor, perform a
//! provider write, retain raw material, or mutate project/task/provider state.

use serde::{Deserialize, Serialize};

use crate::{
    DurableProviderExecutorCommandRecord, DurableProviderExecutorCommandStatus,
    DurableProviderExecutorLane, DurableProviderExecutorMethod, DurableProviderExecutorState,
    DurableProviderExecutorStatusRecord,
};

/// Stable id for one durable executor dispatch selection record.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct DurableProviderExecutorDispatchSelectionId(pub String);

/// Input for selecting a durable executor command for dispatch admission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableProviderExecutorDispatchSelectionInput {
    pub command: DurableProviderExecutorCommandRecord,
    pub latest_status: Option<DurableProviderExecutorStatusRecord>,
    pub provider_ready_evidence_refs: Vec<String>,
    pub runtime_ready_evidence_refs: Vec<String>,
    pub selection_evidence_refs: Vec<String>,
    pub in_flight_write_attempt_ids: Vec<String>,
    pub stale_command_evidence: bool,
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

/// Durable executor command dispatch selection record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableProviderExecutorDispatchSelectionRecord {
    pub selection_id: DurableProviderExecutorDispatchSelectionId,
    pub command_id: String,
    pub lane: DurableProviderExecutorLane,
    pub lane_admission_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub task_id: Option<String>,
    pub work_item_id: Option<String>,
    pub method: DurableProviderExecutorMethod,
    pub latest_status_state: Option<DurableProviderExecutorState>,
    pub status: DurableProviderExecutorDispatchSelectionStatus,
    pub blockers: Vec<DurableProviderExecutorDispatchSelectionBlocker>,
    pub evidence_refs: Vec<String>,
    pub operator_confirmation_ref: Option<String>,
    pub executor_invoked: bool,
    pub provider_write_selected: bool,
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

/// Selection status.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableProviderExecutorDispatchSelectionStatus {
    SelectedForDispatchAdmission,
    Blocked,
}

/// Why a durable executor command cannot be selected for dispatch admission.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableProviderExecutorDispatchSelectionBlocker {
    CommandNotAccepted,
    CommandAlreadyExecutedProviderWrite,
    CommandPermitsForbiddenAuthority,
    LatestStatusInFlight,
    LatestStatusTerminal,
    LatestStatusInvalid,
    MissingOperatorConfirmation,
    MissingRuntimeSessionRef,
    MissingProviderReadyEvidence,
    MissingRuntimeReadyEvidence,
    MissingSelectionEvidence,
    DuplicateInFlightWriteAttempt,
    StaleCommandEvidence,
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

/// Select a durable executor command for possible dispatch admission.
pub fn durable_provider_executor_dispatch_selection(
    input: DurableProviderExecutorDispatchSelectionInput,
) -> DurableProviderExecutorDispatchSelectionRecord {
    let blockers = selection_blockers(&input);
    let status = if blockers.is_empty() {
        DurableProviderExecutorDispatchSelectionStatus::SelectedForDispatchAdmission
    } else {
        DurableProviderExecutorDispatchSelectionStatus::Blocked
    };
    let latest_status_state = input
        .latest_status
        .as_ref()
        .map(|record| record.state.clone());
    let mut evidence_refs = input.command.evidence_refs.clone();
    if let Some(latest_status) = input.latest_status {
        evidence_refs.extend(latest_status.evidence_refs);
    }
    evidence_refs.extend(input.provider_ready_evidence_refs);
    evidence_refs.extend(input.runtime_ready_evidence_refs);
    evidence_refs.extend(input.selection_evidence_refs);

    DurableProviderExecutorDispatchSelectionRecord {
        selection_id: DurableProviderExecutorDispatchSelectionId(format!(
            "durable-provider-executor-dispatch-selection:{}",
            input.command.command_id.0
        )),
        command_id: input.command.command_id.0,
        lane: input.command.lane,
        lane_admission_id: input.command.lane_admission_id,
        provider_instance_id: input.command.provider_instance_id,
        runtime_session_ref: input.command.runtime_session_ref,
        write_attempt_id: input.command.write_attempt_id,
        idempotency_key: input.command.idempotency_key,
        task_id: input.command.task_id,
        work_item_id: input.command.work_item_id,
        method: input.command.method,
        latest_status_state,
        status,
        blockers,
        evidence_refs: unique_sorted(evidence_refs),
        operator_confirmation_ref: input.command.operator_confirmation_ref,
        executor_invoked: false,
        provider_write_selected: false,
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

fn selection_blockers(
    input: &DurableProviderExecutorDispatchSelectionInput,
) -> Vec<DurableProviderExecutorDispatchSelectionBlocker> {
    let mut blockers = Vec::new();

    if input.command.status != DurableProviderExecutorCommandStatus::AcceptedForPersistence {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::CommandNotAccepted);
    }
    if input.command.provider_write_executed {
        blockers.push(
            DurableProviderExecutorDispatchSelectionBlocker::CommandAlreadyExecutedProviderWrite,
        );
    }
    if command_permits_forbidden_authority(&input.command) {
        blockers.push(
            DurableProviderExecutorDispatchSelectionBlocker::CommandPermitsForbiddenAuthority,
        );
    }
    status_blockers(input.latest_status.as_ref(), &mut blockers);
    identity_blockers(input, &mut blockers);
    requested_authority_blockers(input, &mut blockers);

    blockers
}

fn command_permits_forbidden_authority(command: &DurableProviderExecutorCommandRecord) -> bool {
    command.client_authority_granted
        || command.raw_provider_material_retained
        || command.raw_callback_material_retained
        || command.task_mutation_permitted
        || command.review_acceptance_permitted
        || command.callback_answer_permitted
        || command.interruption_permitted
        || command.recovery_permitted
        || command.replacement_thread_promotion_permitted
        || command.scm_mutation_permitted
}

fn status_blockers(
    latest_status: Option<&DurableProviderExecutorStatusRecord>,
    blockers: &mut Vec<DurableProviderExecutorDispatchSelectionBlocker>,
) {
    let Some(latest_status) = latest_status else {
        return;
    };

    match latest_status.state {
        DurableProviderExecutorState::Queued => {}
        DurableProviderExecutorState::Running => {
            blockers.push(DurableProviderExecutorDispatchSelectionBlocker::LatestStatusInFlight);
        }
        DurableProviderExecutorState::Completed
        | DurableProviderExecutorState::Failed(_)
        | DurableProviderExecutorState::Blocked(_)
        | DurableProviderExecutorState::TimedOut
        | DurableProviderExecutorState::CleanupRequired(_) => {
            blockers.push(DurableProviderExecutorDispatchSelectionBlocker::LatestStatusTerminal);
        }
        DurableProviderExecutorState::Invalid => {
            blockers.push(DurableProviderExecutorDispatchSelectionBlocker::LatestStatusInvalid);
        }
    }
}

fn identity_blockers(
    input: &DurableProviderExecutorDispatchSelectionInput,
    blockers: &mut Vec<DurableProviderExecutorDispatchSelectionBlocker>,
) {
    if input
        .command
        .operator_confirmation_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::MissingOperatorConfirmation);
    }
    if input.command.runtime_session_ref.is_empty() {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::MissingRuntimeSessionRef);
    }
    if input.provider_ready_evidence_refs.is_empty()
        || input
            .provider_ready_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers
            .push(DurableProviderExecutorDispatchSelectionBlocker::MissingProviderReadyEvidence);
    }
    if input.runtime_ready_evidence_refs.is_empty()
        || input
            .runtime_ready_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::MissingRuntimeReadyEvidence);
    }
    if input.selection_evidence_refs.is_empty()
        || input
            .selection_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::MissingSelectionEvidence);
    }
    if input
        .in_flight_write_attempt_ids
        .iter()
        .any(|value| value == &input.command.write_attempt_id)
    {
        blockers
            .push(DurableProviderExecutorDispatchSelectionBlocker::DuplicateInFlightWriteAttempt);
    }
    if input.stale_command_evidence {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::StaleCommandEvidence);
    }
}

fn requested_authority_blockers(
    input: &DurableProviderExecutorDispatchSelectionInput,
    blockers: &mut Vec<DurableProviderExecutorDispatchSelectionBlocker>,
) {
    if input.background_execution_requested {
        blockers
            .push(DurableProviderExecutorDispatchSelectionBlocker::BackgroundExecutionRequested);
    }
    if input.provider_write_requested {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::ProviderWriteRequested);
    }
    if input.raw_provider_material_requested {
        blockers
            .push(DurableProviderExecutorDispatchSelectionBlocker::RawProviderMaterialRequested);
    }
    if input.raw_callback_material_requested {
        blockers
            .push(DurableProviderExecutorDispatchSelectionBlocker::RawCallbackMaterialRequested);
    }
    if input.task_mutation_requested {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::TaskMutationRequested);
    }
    if input.review_acceptance_requested {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::ReviewAcceptanceRequested);
    }
    if input.callback_answer_requested {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::CallbackAnswerRequested);
    }
    if input.interruption_requested {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::RecoveryRequested);
    }
    if input.replacement_thread_promotion_requested {
        blockers.push(
            DurableProviderExecutorDispatchSelectionBlocker::ReplacementThreadPromotionRequested,
        );
    }
    if input.scm_mutation_requested {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::ScmMutationRequested);
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
        durable_provider_executor_command, durable_provider_executor_status,
        DurableProviderExecutorCommandId, DurableProviderExecutorCommandInput,
        DurableProviderExecutorRequestedState, DurableProviderExecutorStatusInput,
    };

    fn command() -> DurableProviderExecutorCommandRecord {
        durable_provider_executor_command(DurableProviderExecutorCommandInput {
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
        })
    }

    fn input() -> DurableProviderExecutorDispatchSelectionInput {
        DurableProviderExecutorDispatchSelectionInput {
            command: command(),
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
        }
    }

    fn status(state: DurableProviderExecutorRequestedState) -> DurableProviderExecutorStatusRecord {
        durable_provider_executor_status(DurableProviderExecutorStatusInput {
            command: command(),
            requested_state: state,
            live_executor_outcome_id: Some("outcome:1".to_owned()),
            runtime_receipt_id: Some("receipt:1".to_owned()),
            evidence_refs: vec!["evidence:status:1".to_owned()],
            provider_write_executed: true,
            raw_provider_material_retained: false,
            raw_callback_material_retained: false,
            task_mutation_requested: false,
            review_acceptance_requested: false,
            callback_answer_requested: false,
            interruption_requested: false,
            recovery_requested: false,
            replacement_thread_promotion_requested: false,
            scm_mutation_requested: false,
        })
    }

    #[test]
    fn durable_executor_dispatch_selection_accepts_eligible_command_without_execution() {
        let record = durable_provider_executor_dispatch_selection(input());

        assert_eq!(
            record.status,
            DurableProviderExecutorDispatchSelectionStatus::SelectedForDispatchAdmission
        );
        assert!(record.blockers.is_empty());
        assert_eq!(record.command_id, "durable-provider-executor-command:1");
        assert_eq!(record.task_id.as_deref(), Some("task:1"));
        assert_eq!(record.work_item_id.as_deref(), Some("work:1"));
        assert!(record
            .evidence_refs
            .contains(&"evidence:provider-ready:1".to_owned()));
        assert!(!record.executor_invoked);
        assert!(!record.provider_write_selected);
        assert!(!record.client_authority_granted);
        assert!(!record.task_mutation_permitted);
    }

    #[test]
    fn durable_executor_dispatch_selection_allows_queued_status() {
        let mut input = input();
        input.latest_status = Some(durable_provider_executor_status(
            DurableProviderExecutorStatusInput {
                command: command(),
                requested_state: DurableProviderExecutorRequestedState::Queued,
                live_executor_outcome_id: None,
                runtime_receipt_id: None,
                evidence_refs: vec!["evidence:status:queued".to_owned()],
                provider_write_executed: false,
                raw_provider_material_retained: false,
                raw_callback_material_retained: false,
                task_mutation_requested: false,
                review_acceptance_requested: false,
                callback_answer_requested: false,
                interruption_requested: false,
                recovery_requested: false,
                replacement_thread_promotion_requested: false,
                scm_mutation_requested: false,
            },
        ));

        let record = durable_provider_executor_dispatch_selection(input);

        assert_eq!(
            record.status,
            DurableProviderExecutorDispatchSelectionStatus::SelectedForDispatchAdmission
        );
        assert_eq!(
            record.latest_status_state,
            Some(DurableProviderExecutorState::Queued)
        );
    }

    #[test]
    fn durable_executor_dispatch_selection_blocks_in_flight_and_terminal_statuses() {
        let mut running = input();
        running.latest_status = Some(durable_provider_executor_status(
            DurableProviderExecutorStatusInput {
                command: command(),
                requested_state: DurableProviderExecutorRequestedState::Running,
                live_executor_outcome_id: None,
                runtime_receipt_id: None,
                evidence_refs: vec!["evidence:status:running".to_owned()],
                provider_write_executed: false,
                raw_provider_material_retained: false,
                raw_callback_material_retained: false,
                task_mutation_requested: false,
                review_acceptance_requested: false,
                callback_answer_requested: false,
                interruption_requested: false,
                recovery_requested: false,
                replacement_thread_promotion_requested: false,
                scm_mutation_requested: false,
            },
        ));
        let running_record = durable_provider_executor_dispatch_selection(running);

        let mut completed = input();
        completed.latest_status = Some(status(DurableProviderExecutorRequestedState::Completed));
        let completed_record = durable_provider_executor_dispatch_selection(completed);

        assert!(running_record
            .blockers
            .contains(&DurableProviderExecutorDispatchSelectionBlocker::LatestStatusInFlight));
        assert!(completed_record
            .blockers
            .contains(&DurableProviderExecutorDispatchSelectionBlocker::LatestStatusTerminal));
    }

    #[test]
    fn durable_executor_dispatch_selection_blocks_missing_readiness_and_stale_evidence() {
        let mut input = input();
        input.command.operator_confirmation_ref = None;
        input.command.runtime_session_ref.clear();
        input.provider_ready_evidence_refs.clear();
        input.runtime_ready_evidence_refs = vec![String::new()];
        input.selection_evidence_refs.clear();
        input
            .in_flight_write_attempt_ids
            .push("provider-transport-write:1".to_owned());
        input.stale_command_evidence = true;

        let record = durable_provider_executor_dispatch_selection(input);

        assert_eq!(
            record.status,
            DurableProviderExecutorDispatchSelectionStatus::Blocked
        );
        assert!(record.blockers.contains(
            &DurableProviderExecutorDispatchSelectionBlocker::MissingOperatorConfirmation
        ));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorDispatchSelectionBlocker::MissingRuntimeSessionRef));
        assert!(record.blockers.contains(
            &DurableProviderExecutorDispatchSelectionBlocker::MissingProviderReadyEvidence
        ));
        assert!(record.blockers.contains(
            &DurableProviderExecutorDispatchSelectionBlocker::MissingRuntimeReadyEvidence
        ));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorDispatchSelectionBlocker::MissingSelectionEvidence));
        assert!(record.blockers.contains(
            &DurableProviderExecutorDispatchSelectionBlocker::DuplicateInFlightWriteAttempt
        ));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorDispatchSelectionBlocker::StaleCommandEvidence));
    }

    #[test]
    fn durable_executor_dispatch_selection_blocks_authority_widening() {
        let mut input = input();
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

        let record = durable_provider_executor_dispatch_selection(input);

        assert!(record.blockers.contains(
            &DurableProviderExecutorDispatchSelectionBlocker::BackgroundExecutionRequested
        ));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorDispatchSelectionBlocker::ProviderWriteRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorDispatchSelectionBlocker::TaskMutationRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorDispatchSelectionBlocker::ScmMutationRequested));
    }
}
