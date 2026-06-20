//! Durable provider executor dispatch outcome linkage records.
//!
//! These records connect admitted durable dispatch attempts to sanitized live
//! executor outcomes and durable executor status records. Linkage records do
//! not mutate tasks, reviews, callbacks, interruptions, recovery state, SCM
//! state, or provider transports.

use serde::{Deserialize, Serialize};

use crate::{
    durable_provider_executor_status, CodexAppServerLiveExecutorOutcomeRecord,
    CodexAppServerLiveExecutorOutcomeStatus, DurableProviderExecutorCommandRecord,
    DurableProviderExecutorDispatchAdmissionRecord, DurableProviderExecutorDispatchAdmissionStatus,
    DurableProviderExecutorRequestedState, DurableProviderExecutorStatusInput,
    DurableProviderExecutorStatusRecord,
};

/// Stable id for one durable executor dispatch outcome linkage record.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct DurableProviderExecutorDispatchOutcomeLinkageId(pub String);

/// Input for linking an admitted dispatch attempt to a live executor outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableProviderExecutorDispatchOutcomeLinkageInput {
    pub admission: DurableProviderExecutorDispatchAdmissionRecord,
    pub command: DurableProviderExecutorCommandRecord,
    pub outcome: CodexAppServerLiveExecutorOutcomeRecord,
    pub runtime_receipt_id: String,
    pub linkage_evidence_refs: Vec<String>,
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

/// Durable executor dispatch outcome linkage record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableProviderExecutorDispatchOutcomeLinkageRecord {
    pub linkage_id: DurableProviderExecutorDispatchOutcomeLinkageId,
    pub admission_id: String,
    pub selection_id: String,
    pub command_id: String,
    pub dispatch_attempt_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub live_executor_outcome_id: String,
    pub runtime_receipt_id: String,
    pub status: DurableProviderExecutorDispatchOutcomeLinkageStatus,
    pub blockers: Vec<DurableProviderExecutorDispatchOutcomeLinkageBlocker>,
    pub durable_status: DurableProviderExecutorStatusRecord,
    pub evidence_refs: Vec<String>,
    pub provider_completion_recorded: bool,
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

/// Outcome linkage status.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableProviderExecutorDispatchOutcomeLinkageStatus {
    Linked,
    Blocked,
}

/// Why dispatch outcome linkage is blocked.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableProviderExecutorDispatchOutcomeLinkageBlocker {
    AdmissionNotAccepted,
    AdmissionPermitsForbiddenAuthority,
    CommandIdMismatch,
    ProviderInstanceMismatch,
    WriteAttemptMismatch,
    MissingOutcomeId,
    MissingRuntimeReceiptId,
    MissingLinkageEvidence,
    OutcomeRetainedRawPayload,
    OutcomeRetainedRawStream,
    OutcomePermitsTaskMutation,
    OutcomePermitsCallbackResponse,
    OutcomePermitsCancellation,
    OutcomePermitsResume,
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

/// Link an admitted durable dispatch attempt to a sanitized live outcome.
pub fn durable_provider_executor_dispatch_outcome_linkage(
    input: DurableProviderExecutorDispatchOutcomeLinkageInput,
) -> DurableProviderExecutorDispatchOutcomeLinkageRecord {
    let blockers = linkage_blockers(&input);
    let status = if blockers.is_empty() {
        DurableProviderExecutorDispatchOutcomeLinkageStatus::Linked
    } else {
        DurableProviderExecutorDispatchOutcomeLinkageStatus::Blocked
    };
    let durable_status = durable_provider_executor_status(status_input(&input, &blockers));
    let mut evidence_refs = input.admission.evidence_refs.clone();
    evidence_refs.extend(input.outcome.evidence_refs.clone());
    evidence_refs.extend(input.outcome.receipt_refs.clone());
    evidence_refs.extend(input.linkage_evidence_refs.clone());
    evidence_refs.push(input.runtime_receipt_id.clone());

    DurableProviderExecutorDispatchOutcomeLinkageRecord {
        linkage_id: DurableProviderExecutorDispatchOutcomeLinkageId(format!(
            "durable-provider-executor-dispatch-outcome-linkage:{}:{}",
            input.admission.dispatch_attempt_id, input.outcome.outcome_id.0
        )),
        admission_id: input.admission.admission_id.0,
        selection_id: input.admission.selection_id,
        command_id: input.admission.command_id,
        dispatch_attempt_id: input.admission.dispatch_attempt_id,
        provider_instance_id: input.outcome.provider_instance_id,
        runtime_session_ref: input.admission.runtime_session_ref,
        write_attempt_id: input.outcome.write_attempt_id,
        idempotency_key: input.admission.idempotency_key,
        live_executor_outcome_id: input.outcome.outcome_id.0,
        runtime_receipt_id: input.runtime_receipt_id,
        status,
        blockers,
        durable_status,
        evidence_refs: unique_sorted(evidence_refs),
        provider_completion_recorded: matches!(
            input.outcome.status,
            CodexAppServerLiveExecutorOutcomeStatus::Completed
        ),
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

fn linkage_blockers(
    input: &DurableProviderExecutorDispatchOutcomeLinkageInput,
) -> Vec<DurableProviderExecutorDispatchOutcomeLinkageBlocker> {
    let mut blockers = Vec::new();

    if input.admission.status != DurableProviderExecutorDispatchAdmissionStatus::AcceptedForDispatch
    {
        blockers.push(DurableProviderExecutorDispatchOutcomeLinkageBlocker::AdmissionNotAccepted);
    }
    if admission_permits_forbidden_authority(&input.admission) {
        blockers.push(
            DurableProviderExecutorDispatchOutcomeLinkageBlocker::AdmissionPermitsForbiddenAuthority,
        );
    }
    identity_blockers(input, &mut blockers);
    outcome_authority_blockers(input, &mut blockers);
    requested_authority_blockers(input, &mut blockers);

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
    input: &DurableProviderExecutorDispatchOutcomeLinkageInput,
    blockers: &mut Vec<DurableProviderExecutorDispatchOutcomeLinkageBlocker>,
) {
    if input.admission.command_id != input.command.command_id.0 {
        blockers.push(DurableProviderExecutorDispatchOutcomeLinkageBlocker::CommandIdMismatch);
    }
    if input.outcome.provider_instance_id != input.admission.provider_instance_id {
        blockers
            .push(DurableProviderExecutorDispatchOutcomeLinkageBlocker::ProviderInstanceMismatch);
    }
    if input.outcome.write_attempt_id != input.admission.write_attempt_id {
        blockers.push(DurableProviderExecutorDispatchOutcomeLinkageBlocker::WriteAttemptMismatch);
    }
    if input.outcome.outcome_id.0.is_empty() {
        blockers.push(DurableProviderExecutorDispatchOutcomeLinkageBlocker::MissingOutcomeId);
    }
    if input.runtime_receipt_id.is_empty() {
        blockers
            .push(DurableProviderExecutorDispatchOutcomeLinkageBlocker::MissingRuntimeReceiptId);
    }
    if input.linkage_evidence_refs.is_empty()
        || input
            .linkage_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers.push(DurableProviderExecutorDispatchOutcomeLinkageBlocker::MissingLinkageEvidence);
    }
}

fn outcome_authority_blockers(
    input: &DurableProviderExecutorDispatchOutcomeLinkageInput,
    blockers: &mut Vec<DurableProviderExecutorDispatchOutcomeLinkageBlocker>,
) {
    if input.outcome.raw_payload_retained {
        blockers
            .push(DurableProviderExecutorDispatchOutcomeLinkageBlocker::OutcomeRetainedRawPayload);
    }
    if input.outcome.raw_stream_retained {
        blockers
            .push(DurableProviderExecutorDispatchOutcomeLinkageBlocker::OutcomeRetainedRawStream);
    }
    if input.outcome.task_mutation_permitted {
        blockers
            .push(DurableProviderExecutorDispatchOutcomeLinkageBlocker::OutcomePermitsTaskMutation);
    }
    if input.outcome.callback_response_permitted {
        blockers.push(
            DurableProviderExecutorDispatchOutcomeLinkageBlocker::OutcomePermitsCallbackResponse,
        );
    }
    if input.outcome.cancellation_permitted {
        blockers
            .push(DurableProviderExecutorDispatchOutcomeLinkageBlocker::OutcomePermitsCancellation);
    }
    if input.outcome.resume_permitted {
        blockers.push(DurableProviderExecutorDispatchOutcomeLinkageBlocker::OutcomePermitsResume);
    }
}

fn requested_authority_blockers(
    input: &DurableProviderExecutorDispatchOutcomeLinkageInput,
    blockers: &mut Vec<DurableProviderExecutorDispatchOutcomeLinkageBlocker>,
) {
    if input.raw_provider_material_retained {
        blockers.push(
            DurableProviderExecutorDispatchOutcomeLinkageBlocker::RawProviderMaterialRetained,
        );
    }
    if input.raw_callback_material_retained {
        blockers.push(
            DurableProviderExecutorDispatchOutcomeLinkageBlocker::RawCallbackMaterialRetained,
        );
    }
    if input.task_mutation_requested {
        blockers.push(DurableProviderExecutorDispatchOutcomeLinkageBlocker::TaskMutationRequested);
    }
    if input.review_acceptance_requested {
        blockers
            .push(DurableProviderExecutorDispatchOutcomeLinkageBlocker::ReviewAcceptanceRequested);
    }
    if input.callback_answer_requested {
        blockers
            .push(DurableProviderExecutorDispatchOutcomeLinkageBlocker::CallbackAnswerRequested);
    }
    if input.interruption_requested {
        blockers.push(DurableProviderExecutorDispatchOutcomeLinkageBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(DurableProviderExecutorDispatchOutcomeLinkageBlocker::RecoveryRequested);
    }
    if input.replacement_thread_promotion_requested {
        blockers.push(
            DurableProviderExecutorDispatchOutcomeLinkageBlocker::ReplacementThreadPromotionRequested,
        );
    }
    if input.scm_mutation_requested {
        blockers.push(DurableProviderExecutorDispatchOutcomeLinkageBlocker::ScmMutationRequested);
    }
}

fn status_input(
    input: &DurableProviderExecutorDispatchOutcomeLinkageInput,
    blockers: &[DurableProviderExecutorDispatchOutcomeLinkageBlocker],
) -> DurableProviderExecutorStatusInput {
    DurableProviderExecutorStatusInput {
        command: input.command.clone(),
        requested_state: requested_state(&input.outcome.status, !blockers.is_empty()),
        live_executor_outcome_id: Some(input.outcome.outcome_id.0.clone()),
        runtime_receipt_id: Some(input.runtime_receipt_id.clone()),
        evidence_refs: status_evidence_refs(input, blockers),
        provider_write_executed: input.outcome.provider_write_executed,
        raw_provider_material_retained: input.raw_provider_material_retained,
        raw_callback_material_retained: input.raw_callback_material_retained,
        task_mutation_requested: input.task_mutation_requested,
        review_acceptance_requested: input.review_acceptance_requested,
        callback_answer_requested: input.callback_answer_requested,
        interruption_requested: input.interruption_requested,
        recovery_requested: input.recovery_requested,
        replacement_thread_promotion_requested: input.replacement_thread_promotion_requested,
        scm_mutation_requested: input.scm_mutation_requested,
    }
}

fn requested_state(
    outcome_status: &CodexAppServerLiveExecutorOutcomeStatus,
    linkage_blocked: bool,
) -> DurableProviderExecutorRequestedState {
    if linkage_blocked {
        return DurableProviderExecutorRequestedState::Blocked(
            "dispatch linkage blocked".to_owned(),
        );
    }

    match outcome_status {
        CodexAppServerLiveExecutorOutcomeStatus::Accepted => {
            DurableProviderExecutorRequestedState::Running
        }
        CodexAppServerLiveExecutorOutcomeStatus::Completed => {
            DurableProviderExecutorRequestedState::Completed
        }
        CodexAppServerLiveExecutorOutcomeStatus::Failed(reason) => {
            DurableProviderExecutorRequestedState::Failed(reason.clone())
        }
        CodexAppServerLiveExecutorOutcomeStatus::TimedOut => {
            DurableProviderExecutorRequestedState::TimedOut
        }
        CodexAppServerLiveExecutorOutcomeStatus::Blocked(reason) => {
            DurableProviderExecutorRequestedState::Blocked(reason.clone())
        }
        CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(reason) => {
            DurableProviderExecutorRequestedState::CleanupRequired(reason.clone())
        }
    }
}

fn status_evidence_refs(
    input: &DurableProviderExecutorDispatchOutcomeLinkageInput,
    blockers: &[DurableProviderExecutorDispatchOutcomeLinkageBlocker],
) -> Vec<String> {
    if blockers.is_empty() {
        let mut refs = input.outcome.evidence_refs.clone();
        refs.extend(input.linkage_evidence_refs.clone());
        refs.extend(input.outcome.receipt_refs.clone());
        refs.push(input.runtime_receipt_id.clone());
        unique_sorted(refs)
    } else {
        vec!["durable-provider-executor-dispatch-linkage:blocker".to_owned()]
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
        codex_live_executor_outcome_record, durable_provider_executor_command,
        durable_provider_executor_dispatch_admission, durable_provider_executor_dispatch_selection,
        CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorMethod,
        CodexAppServerLiveExecutorOutcomeInput, DurableProviderExecutorCommandId,
        DurableProviderExecutorCommandInput, DurableProviderExecutorDispatchAdmissionInput,
        DurableProviderExecutorDispatchSelectionInput, DurableProviderExecutorLane,
        DurableProviderExecutorMethod, DurableProviderExecutorState,
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

    fn admission() -> DurableProviderExecutorDispatchAdmissionRecord {
        durable_provider_executor_dispatch_admission(
            DurableProviderExecutorDispatchAdmissionInput {
                selection: durable_provider_executor_dispatch_selection(
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

    fn outcome(
        status: CodexAppServerLiveExecutorOutcomeStatus,
    ) -> CodexAppServerLiveExecutorOutcomeRecord {
        let provider_write_executed =
            !matches!(status, CodexAppServerLiveExecutorOutcomeStatus::Accepted);
        codex_live_executor_outcome_record(CodexAppServerLiveExecutorOutcomeInput {
            provider_instance_id: "codex:local-default".to_owned(),
            write_attempt_id: "provider-transport-write:1".to_owned(),
            receipt_refs: vec!["receipt:provider:1".to_owned()],
            thread_id: Some("thread:1".to_owned()),
            turn_id: Some("turn:1".to_owned()),
            final_turn_status: Some("completed".to_owned()),
            status,
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
            provider_write_executed,
        })
    }

    fn input(
        status: CodexAppServerLiveExecutorOutcomeStatus,
    ) -> DurableProviderExecutorDispatchOutcomeLinkageInput {
        DurableProviderExecutorDispatchOutcomeLinkageInput {
            admission: admission(),
            command: command(),
            outcome: outcome(status),
            runtime_receipt_id: "runtime-receipt:1".to_owned(),
            linkage_evidence_refs: vec!["evidence:linkage:1".to_owned()],
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
    fn durable_executor_dispatch_outcome_linkage_records_completed_status() {
        let record = durable_provider_executor_dispatch_outcome_linkage(input(
            CodexAppServerLiveExecutorOutcomeStatus::Completed,
        ));

        assert_eq!(
            record.status,
            DurableProviderExecutorDispatchOutcomeLinkageStatus::Linked
        );
        assert!(record.blockers.is_empty());
        assert_eq!(
            record.live_executor_outcome_id,
            "codex-live-executor-outcome:provider-transport-write:1:completed"
        );
        assert_eq!(
            record.durable_status.state,
            DurableProviderExecutorState::Completed
        );
        assert!(record.provider_completion_recorded);
        assert!(!record.task_mutation_permitted);
        assert!(!record.review_acceptance_permitted);
    }

    #[test]
    fn durable_executor_dispatch_outcome_linkage_keeps_failure_inspectable() {
        let record = durable_provider_executor_dispatch_outcome_linkage(input(
            CodexAppServerLiveExecutorOutcomeStatus::Failed("provider exited".to_owned()),
        ));

        assert_eq!(
            record.durable_status.state,
            DurableProviderExecutorState::Failed("provider exited".to_owned())
        );
        assert_eq!(
            record.status,
            DurableProviderExecutorDispatchOutcomeLinkageStatus::Linked
        );
    }

    #[test]
    fn durable_executor_dispatch_outcome_linkage_keeps_accepted_outcome_running() {
        let record = durable_provider_executor_dispatch_outcome_linkage(input(
            CodexAppServerLiveExecutorOutcomeStatus::Accepted,
        ));

        assert_eq!(
            record.durable_status.state,
            DurableProviderExecutorState::Running
        );
        assert!(!record.provider_completion_recorded);
    }

    #[test]
    fn durable_executor_dispatch_outcome_linkage_blocks_mismatched_records() {
        let mut input = input(CodexAppServerLiveExecutorOutcomeStatus::Blocked(
            "provider blocked".to_owned(),
        ));
        input.admission.status = DurableProviderExecutorDispatchAdmissionStatus::Blocked;
        input.command.command_id.0 = "durable-provider-executor-command:other".to_owned();
        input.outcome.provider_instance_id = "codex:other".to_owned();
        input.outcome.write_attempt_id = "provider-transport-write:other".to_owned();
        input.runtime_receipt_id.clear();
        input.linkage_evidence_refs.clear();

        let record = durable_provider_executor_dispatch_outcome_linkage(input);

        assert_eq!(
            record.status,
            DurableProviderExecutorDispatchOutcomeLinkageStatus::Blocked
        );
        assert_eq!(
            record.durable_status.state,
            DurableProviderExecutorState::Invalid
        );
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorDispatchOutcomeLinkageBlocker::AdmissionNotAccepted));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorDispatchOutcomeLinkageBlocker::CommandIdMismatch));
        assert!(record.blockers.contains(
            &DurableProviderExecutorDispatchOutcomeLinkageBlocker::ProviderInstanceMismatch
        ));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorDispatchOutcomeLinkageBlocker::WriteAttemptMismatch));
        assert!(record.blockers.contains(
            &DurableProviderExecutorDispatchOutcomeLinkageBlocker::MissingRuntimeReceiptId
        ));
        assert!(record.blockers.contains(
            &DurableProviderExecutorDispatchOutcomeLinkageBlocker::MissingLinkageEvidence
        ));
    }

    #[test]
    fn durable_executor_dispatch_outcome_linkage_blocks_authority_widening() {
        let mut input = input(CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(
            "cleanup".to_owned(),
        ));
        input.raw_provider_material_retained = true;
        input.raw_callback_material_retained = true;
        input.task_mutation_requested = true;
        input.review_acceptance_requested = true;
        input.callback_answer_requested = true;
        input.interruption_requested = true;
        input.recovery_requested = true;
        input.replacement_thread_promotion_requested = true;
        input.scm_mutation_requested = true;

        let record = durable_provider_executor_dispatch_outcome_linkage(input);

        assert!(record.blockers.contains(
            &DurableProviderExecutorDispatchOutcomeLinkageBlocker::RawProviderMaterialRetained
        ));
        assert!(record.blockers.contains(
            &DurableProviderExecutorDispatchOutcomeLinkageBlocker::RawCallbackMaterialRetained
        ));
        assert!(record.blockers.contains(
            &DurableProviderExecutorDispatchOutcomeLinkageBlocker::TaskMutationRequested
        ));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorDispatchOutcomeLinkageBlocker::ScmMutationRequested));
    }
}
