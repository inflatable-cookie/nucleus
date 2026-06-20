//! Durable provider executor command records.
//!
//! These records capture server-owned intent to ask a provider executor to
//! perform a previously admitted write. They do not invoke the executor, write
//! to a provider transport, retain raw provider material, mutate tasks, accept
//! reviews, answer callbacks, interrupt turns, resume sessions, promote
//! replacement threads, or mutate SCM state.

use serde::{Deserialize, Serialize};

/// Stable id for one durable provider executor command.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct DurableProviderExecutorCommandId(pub String);

/// Source lane that authorized the provider write attempt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableProviderExecutorLane {
    TaskBackedTurnStart,
    CallbackResponse,
    Interruption,
    Recovery,
}

/// Provider method requested by the durable executor command.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableProviderExecutorMethod {
    TurnStart,
    CallbackResponse,
    TurnInterrupt,
    ThreadResume,
}

/// Input for building a durable provider executor command record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableProviderExecutorCommandInput {
    pub command_id: DurableProviderExecutorCommandId,
    pub lane: DurableProviderExecutorLane,
    pub lane_admission_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub task_id: Option<String>,
    pub work_item_id: Option<String>,
    pub method: DurableProviderExecutorMethod,
    pub evidence_refs: Vec<String>,
    pub operator_confirmation_ref: Option<String>,
    pub client_authority_requested: bool,
    pub invoke_executor_requested: bool,
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

/// Durable executor command record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableProviderExecutorCommandRecord {
    pub command_id: DurableProviderExecutorCommandId,
    pub lane: DurableProviderExecutorLane,
    pub lane_admission_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub task_id: Option<String>,
    pub work_item_id: Option<String>,
    pub method: DurableProviderExecutorMethod,
    pub status: DurableProviderExecutorCommandStatus,
    pub blockers: Vec<DurableProviderExecutorCommandBlocker>,
    pub evidence_refs: Vec<String>,
    pub operator_confirmation_ref: Option<String>,
    pub replay_policy: DurableProviderExecutorCommandReplayPolicy,
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

/// Command admission status.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableProviderExecutorCommandStatus {
    AcceptedForPersistence,
    Blocked,
}

/// Why durable executor command intent is blocked.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableProviderExecutorCommandBlocker {
    MissingCommandId,
    MissingLaneAdmissionId,
    MissingProviderInstanceId,
    MissingRuntimeSessionRef,
    MissingWriteAttemptId,
    MissingIdempotencyKey,
    MissingTaskId,
    MissingWorkItemId,
    MissingEvidenceRef,
    MissingOperatorConfirmation,
    LaneMethodMismatch,
    ClientAuthorityRequested,
    ExecutorInvocationRequested,
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

/// Replay posture for durable provider executor commands.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableProviderExecutorCommandReplayPolicy {
    InspectOnlyUntilExplicitDispatch,
}

/// Build durable executor command intent without executing provider I/O.
pub fn durable_provider_executor_command(
    input: DurableProviderExecutorCommandInput,
) -> DurableProviderExecutorCommandRecord {
    let blockers = command_blockers(&input);
    let status = if blockers.is_empty() {
        DurableProviderExecutorCommandStatus::AcceptedForPersistence
    } else {
        DurableProviderExecutorCommandStatus::Blocked
    };

    DurableProviderExecutorCommandRecord {
        command_id: input.command_id,
        lane: input.lane,
        lane_admission_id: input.lane_admission_id,
        provider_instance_id: input.provider_instance_id,
        runtime_session_ref: input.runtime_session_ref,
        write_attempt_id: input.write_attempt_id,
        idempotency_key: input.idempotency_key,
        task_id: input.task_id,
        work_item_id: input.work_item_id,
        method: input.method,
        status,
        blockers,
        evidence_refs: unique_sorted(input.evidence_refs),
        operator_confirmation_ref: input.operator_confirmation_ref,
        replay_policy: DurableProviderExecutorCommandReplayPolicy::InspectOnlyUntilExplicitDispatch,
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

fn command_blockers(
    input: &DurableProviderExecutorCommandInput,
) -> Vec<DurableProviderExecutorCommandBlocker> {
    let mut blockers = Vec::new();

    if input.command_id.0.is_empty() {
        blockers.push(DurableProviderExecutorCommandBlocker::MissingCommandId);
    }
    if input.lane_admission_id.is_empty() {
        blockers.push(DurableProviderExecutorCommandBlocker::MissingLaneAdmissionId);
    }
    if input.provider_instance_id.is_empty() {
        blockers.push(DurableProviderExecutorCommandBlocker::MissingProviderInstanceId);
    }
    if input.runtime_session_ref.is_empty() {
        blockers.push(DurableProviderExecutorCommandBlocker::MissingRuntimeSessionRef);
    }
    if input.write_attempt_id.is_empty() {
        blockers.push(DurableProviderExecutorCommandBlocker::MissingWriteAttemptId);
    }
    if input.idempotency_key.is_empty() {
        blockers.push(DurableProviderExecutorCommandBlocker::MissingIdempotencyKey);
    }
    if input.task_id.as_deref().unwrap_or_default().is_empty() {
        blockers.push(DurableProviderExecutorCommandBlocker::MissingTaskId);
    }
    if input.work_item_id.as_deref().unwrap_or_default().is_empty() {
        blockers.push(DurableProviderExecutorCommandBlocker::MissingWorkItemId);
    }
    if input.evidence_refs.is_empty() || input.evidence_refs.iter().any(|value| value.is_empty()) {
        blockers.push(DurableProviderExecutorCommandBlocker::MissingEvidenceRef);
    }
    if input
        .operator_confirmation_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(DurableProviderExecutorCommandBlocker::MissingOperatorConfirmation);
    }
    if !lane_method_matches(&input.lane, &input.method) {
        blockers.push(DurableProviderExecutorCommandBlocker::LaneMethodMismatch);
    }
    authority_blockers(input, &mut blockers);

    blockers
}

fn authority_blockers(
    input: &DurableProviderExecutorCommandInput,
    blockers: &mut Vec<DurableProviderExecutorCommandBlocker>,
) {
    if input.client_authority_requested {
        blockers.push(DurableProviderExecutorCommandBlocker::ClientAuthorityRequested);
    }
    if input.invoke_executor_requested {
        blockers.push(DurableProviderExecutorCommandBlocker::ExecutorInvocationRequested);
    }
    if input.raw_provider_material_requested {
        blockers.push(DurableProviderExecutorCommandBlocker::RawProviderMaterialRequested);
    }
    if input.raw_callback_material_requested {
        blockers.push(DurableProviderExecutorCommandBlocker::RawCallbackMaterialRequested);
    }
    if input.task_mutation_requested {
        blockers.push(DurableProviderExecutorCommandBlocker::TaskMutationRequested);
    }
    if input.review_acceptance_requested {
        blockers.push(DurableProviderExecutorCommandBlocker::ReviewAcceptanceRequested);
    }
    if input.callback_answer_requested {
        blockers.push(DurableProviderExecutorCommandBlocker::CallbackAnswerRequested);
    }
    if input.interruption_requested {
        blockers.push(DurableProviderExecutorCommandBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(DurableProviderExecutorCommandBlocker::RecoveryRequested);
    }
    if input.replacement_thread_promotion_requested {
        blockers.push(DurableProviderExecutorCommandBlocker::ReplacementThreadPromotionRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(DurableProviderExecutorCommandBlocker::ScmMutationRequested);
    }
}

fn lane_method_matches(
    lane: &DurableProviderExecutorLane,
    method: &DurableProviderExecutorMethod,
) -> bool {
    matches!(
        (lane, method),
        (
            DurableProviderExecutorLane::TaskBackedTurnStart,
            DurableProviderExecutorMethod::TurnStart
        ) | (
            DurableProviderExecutorLane::CallbackResponse,
            DurableProviderExecutorMethod::CallbackResponse
        ) | (
            DurableProviderExecutorLane::Interruption,
            DurableProviderExecutorMethod::TurnInterrupt
        ) | (
            DurableProviderExecutorLane::Recovery,
            DurableProviderExecutorMethod::ThreadResume
        )
    )
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> DurableProviderExecutorCommandInput {
        DurableProviderExecutorCommandInput {
            command_id: DurableProviderExecutorCommandId(
                "durable-provider-executor-command:1".to_owned(),
            ),
            lane: DurableProviderExecutorLane::TaskBackedTurnStart,
            lane_admission_id: "task-work-live-executor-admission:1".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            runtime_session_ref: "runtime-session:1".to_owned(),
            write_attempt_id: "provider-transport-write:task-work:1".to_owned(),
            idempotency_key: "idempotency:task-work:1".to_owned(),
            task_id: Some("task:1".to_owned()),
            work_item_id: Some("work:1".to_owned()),
            method: DurableProviderExecutorMethod::TurnStart,
            evidence_refs: vec![
                "evidence:policy:1".to_owned(),
                "evidence:operator-confirmation:1".to_owned(),
            ],
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
        }
    }

    #[test]
    fn durable_provider_executor_command_accepts_intent_without_execution() {
        let record = durable_provider_executor_command(input());

        assert_eq!(
            record.status,
            DurableProviderExecutorCommandStatus::AcceptedForPersistence
        );
        assert!(record.blockers.is_empty());
        assert_eq!(record.method, DurableProviderExecutorMethod::TurnStart);
        assert_eq!(record.task_id.as_deref(), Some("task:1"));
        assert_eq!(record.work_item_id.as_deref(), Some("work:1"));
        assert!(!record.executor_invoked);
        assert!(!record.provider_write_executed);
        assert!(!record.client_authority_granted);
        assert!(!record.raw_provider_material_retained);
        assert!(!record.raw_callback_material_retained);
        assert!(!record.task_mutation_permitted);
        assert!(!record.review_acceptance_permitted);
        assert!(!record.callback_answer_permitted);
        assert!(!record.interruption_permitted);
        assert!(!record.recovery_permitted);
        assert!(!record.replacement_thread_promotion_permitted);
        assert!(!record.scm_mutation_permitted);
    }

    #[test]
    fn durable_provider_executor_command_blocks_missing_identity() {
        let mut input = input();
        input.command_id = DurableProviderExecutorCommandId(String::new());
        input.lane_admission_id.clear();
        input.provider_instance_id.clear();
        input.runtime_session_ref.clear();
        input.write_attempt_id.clear();
        input.idempotency_key.clear();
        input.task_id = None;
        input.work_item_id = Some(String::new());
        input.evidence_refs = vec![String::new()];
        input.operator_confirmation_ref = None;

        let record = durable_provider_executor_command(input);

        assert_eq!(record.status, DurableProviderExecutorCommandStatus::Blocked);
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::MissingCommandId));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::MissingLaneAdmissionId));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::MissingProviderInstanceId));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::MissingRuntimeSessionRef));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::MissingWriteAttemptId));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::MissingIdempotencyKey));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::MissingTaskId));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::MissingWorkItemId));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::MissingEvidenceRef));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::MissingOperatorConfirmation));
    }

    #[test]
    fn durable_provider_executor_command_blocks_lane_method_mismatch() {
        let mut input = input();
        input.method = DurableProviderExecutorMethod::ThreadResume;

        let record = durable_provider_executor_command(input);

        assert_eq!(
            record.blockers,
            vec![DurableProviderExecutorCommandBlocker::LaneMethodMismatch]
        );
    }

    #[test]
    fn durable_provider_executor_command_blocks_authority_widening() {
        let mut input = input();
        input.client_authority_requested = true;
        input.invoke_executor_requested = true;
        input.raw_provider_material_requested = true;
        input.raw_callback_material_requested = true;
        input.task_mutation_requested = true;
        input.review_acceptance_requested = true;
        input.callback_answer_requested = true;
        input.interruption_requested = true;
        input.recovery_requested = true;
        input.replacement_thread_promotion_requested = true;
        input.scm_mutation_requested = true;

        let record = durable_provider_executor_command(input);

        assert_eq!(record.status, DurableProviderExecutorCommandStatus::Blocked);
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::ClientAuthorityRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::ExecutorInvocationRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::RawProviderMaterialRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::RawCallbackMaterialRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::TaskMutationRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::ReviewAcceptanceRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::CallbackAnswerRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::InterruptionRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::RecoveryRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::ReplacementThreadPromotionRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorCommandBlocker::ScmMutationRequested));
    }
}
