//! Durable dispatch executor handoff records.
//!
//! These records bridge accepted durable invocation requests to the Codex live
//! executor boundary. Handoff is still execution-free: it does not call an
//! executor, write to provider transport, retain raw material, or mutate tasks.

use serde::{Deserialize, Serialize};

use crate::{
    CodexAppServerLiveExecutorMethod, DurableDispatchInvocationRequestRecord,
    DurableDispatchInvocationRequestStatus, DurableProviderExecutorLane,
    DurableProviderExecutorMethod,
};

/// Stable id for one durable dispatch executor handoff record.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct DurableDispatchExecutorHandoffId(pub String);

/// Input for building a durable dispatch executor handoff.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableDispatchExecutorHandoffInput {
    pub request: DurableDispatchInvocationRequestRecord,
    pub supported_methods: Vec<DurableProviderExecutorMethod>,
    pub live_executor_method_sequence: Vec<CodexAppServerLiveExecutorMethod>,
    pub payload_ref: Option<String>,
    pub handoff_evidence_refs: Vec<String>,
    pub executor_invocation_requested: bool,
    pub provider_write_requested: bool,
    pub raw_payload_retained: bool,
    pub raw_stream_retained: bool,
    pub task_mutation_requested: bool,
    pub review_acceptance_requested: bool,
    pub callback_answer_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
    pub replacement_thread_promotion_requested: bool,
    pub scm_mutation_requested: bool,
}

/// Durable dispatch executor handoff record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableDispatchExecutorHandoffRecord {
    pub handoff_id: DurableDispatchExecutorHandoffId,
    pub request_id: String,
    pub preflight_id: String,
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
    pub live_executor_method_sequence: Vec<CodexAppServerLiveExecutorMethod>,
    pub payload_ref: Option<String>,
    pub status: DurableDispatchExecutorHandoffStatus,
    pub blockers: Vec<DurableDispatchExecutorHandoffBlocker>,
    pub evidence_refs: Vec<String>,
    pub executor_invoked: bool,
    pub provider_write_executed: bool,
    pub raw_payload_retained: bool,
    pub raw_stream_retained: bool,
    pub task_mutation_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub callback_answer_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub replacement_thread_promotion_permitted: bool,
    pub scm_mutation_permitted: bool,
}

/// Executor handoff status.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableDispatchExecutorHandoffStatus {
    ReadyForLiveExecutorBoundary,
    Blocked,
}

/// Why executor handoff is blocked.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableDispatchExecutorHandoffBlocker {
    RequestNotAccepted,
    RequestAlreadyInvokedExecutor,
    RequestPermitsForbiddenAuthority,
    MissingHandoffEvidence,
    UnsupportedProviderMethod,
    MissingLiveExecutorMethodSequence,
    LiveExecutorMethodMismatch,
    MissingPayloadRef,
    ExecutorInvocationRequested,
    ProviderWriteRequested,
    RawPayloadRetained,
    RawStreamRetained,
    TaskMutationRequested,
    ReviewAcceptanceRequested,
    CallbackAnswerRequested,
    InterruptionRequested,
    RecoveryRequested,
    ReplacementThreadPromotionRequested,
    ScmMutationRequested,
}

/// Build a durable executor handoff record without executing provider I/O.
pub fn durable_dispatch_executor_handoff(
    input: DurableDispatchExecutorHandoffInput,
) -> DurableDispatchExecutorHandoffRecord {
    let blockers = handoff_blockers(&input);
    let status = if blockers.is_empty() {
        DurableDispatchExecutorHandoffStatus::ReadyForLiveExecutorBoundary
    } else {
        DurableDispatchExecutorHandoffStatus::Blocked
    };
    let mut evidence_refs = input.request.evidence_refs.clone();
    evidence_refs.extend(input.handoff_evidence_refs.clone());
    if let Some(payload_ref) = input.payload_ref.as_ref() {
        evidence_refs.push(format!("payload-ref:{payload_ref}"));
    }

    DurableDispatchExecutorHandoffRecord {
        handoff_id: DurableDispatchExecutorHandoffId(format!(
            "durable-dispatch-executor-handoff:{}:{}",
            input.request.dispatch_attempt_id, input.request.write_attempt_id
        )),
        request_id: input.request.request_id.0,
        preflight_id: input.request.preflight_id,
        admission_id: input.request.admission_id,
        selection_id: input.request.selection_id,
        command_id: input.request.command_id,
        dispatch_attempt_id: input.request.dispatch_attempt_id,
        lane: input.request.lane,
        lane_admission_id: input.request.lane_admission_id,
        provider_instance_id: input.request.provider_instance_id,
        runtime_session_ref: input.request.runtime_session_ref,
        write_attempt_id: input.request.write_attempt_id,
        idempotency_key: input.request.idempotency_key,
        task_id: input.request.task_id,
        work_item_id: input.request.work_item_id,
        method: input.request.method,
        live_executor_method_sequence: input.live_executor_method_sequence,
        payload_ref: input.payload_ref,
        status,
        blockers,
        evidence_refs: unique_sorted(evidence_refs),
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

fn handoff_blockers(
    input: &DurableDispatchExecutorHandoffInput,
) -> Vec<DurableDispatchExecutorHandoffBlocker> {
    let mut blockers = Vec::new();

    if input.request.status != DurableDispatchInvocationRequestStatus::AcceptedForExecutorHandoff {
        blockers.push(DurableDispatchExecutorHandoffBlocker::RequestNotAccepted);
    }
    if input.request.executor_invoked || input.request.provider_write_executed {
        blockers.push(DurableDispatchExecutorHandoffBlocker::RequestAlreadyInvokedExecutor);
    }
    if request_permits_forbidden_authority(&input.request) {
        blockers.push(DurableDispatchExecutorHandoffBlocker::RequestPermitsForbiddenAuthority);
    }
    if input.handoff_evidence_refs.is_empty()
        || input
            .handoff_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers.push(DurableDispatchExecutorHandoffBlocker::MissingHandoffEvidence);
    }
    if !input.supported_methods.contains(&input.request.method) {
        blockers.push(DurableDispatchExecutorHandoffBlocker::UnsupportedProviderMethod);
    }
    if input.live_executor_method_sequence.is_empty() {
        blockers.push(DurableDispatchExecutorHandoffBlocker::MissingLiveExecutorMethodSequence);
    }
    if !live_executor_methods_match(&input.request.method, &input.live_executor_method_sequence) {
        blockers.push(DurableDispatchExecutorHandoffBlocker::LiveExecutorMethodMismatch);
    }
    if input.payload_ref.as_deref().unwrap_or_default().is_empty() {
        blockers.push(DurableDispatchExecutorHandoffBlocker::MissingPayloadRef);
    }
    authority_blockers(input, &mut blockers);

    blockers
}

fn request_permits_forbidden_authority(request: &DurableDispatchInvocationRequestRecord) -> bool {
    request.client_authority_granted
        || request.raw_provider_material_retained
        || request.raw_callback_material_retained
        || request.task_mutation_permitted
        || request.review_acceptance_permitted
        || request.callback_answer_permitted
        || request.interruption_permitted
        || request.recovery_permitted
        || request.replacement_thread_promotion_permitted
        || request.scm_mutation_permitted
}

fn live_executor_methods_match(
    method: &DurableProviderExecutorMethod,
    sequence: &[CodexAppServerLiveExecutorMethod],
) -> bool {
    match method {
        DurableProviderExecutorMethod::TurnStart => {
            sequence.contains(&CodexAppServerLiveExecutorMethod::TurnStart)
        }
        DurableProviderExecutorMethod::CallbackResponse => {
            sequence.contains(&CodexAppServerLiveExecutorMethod::TurnStart)
        }
        DurableProviderExecutorMethod::TurnInterrupt => {
            sequence.contains(&CodexAppServerLiveExecutorMethod::TurnStart)
        }
        DurableProviderExecutorMethod::ThreadResume => {
            sequence.contains(&CodexAppServerLiveExecutorMethod::ThreadStart)
        }
    }
}

fn authority_blockers(
    input: &DurableDispatchExecutorHandoffInput,
    blockers: &mut Vec<DurableDispatchExecutorHandoffBlocker>,
) {
    if input.executor_invocation_requested {
        blockers.push(DurableDispatchExecutorHandoffBlocker::ExecutorInvocationRequested);
    }
    if input.provider_write_requested {
        blockers.push(DurableDispatchExecutorHandoffBlocker::ProviderWriteRequested);
    }
    if input.raw_payload_retained {
        blockers.push(DurableDispatchExecutorHandoffBlocker::RawPayloadRetained);
    }
    if input.raw_stream_retained {
        blockers.push(DurableDispatchExecutorHandoffBlocker::RawStreamRetained);
    }
    if input.task_mutation_requested {
        blockers.push(DurableDispatchExecutorHandoffBlocker::TaskMutationRequested);
    }
    if input.review_acceptance_requested {
        blockers.push(DurableDispatchExecutorHandoffBlocker::ReviewAcceptanceRequested);
    }
    if input.callback_answer_requested {
        blockers.push(DurableDispatchExecutorHandoffBlocker::CallbackAnswerRequested);
    }
    if input.interruption_requested {
        blockers.push(DurableDispatchExecutorHandoffBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(DurableDispatchExecutorHandoffBlocker::RecoveryRequested);
    }
    if input.replacement_thread_promotion_requested {
        blockers.push(DurableDispatchExecutorHandoffBlocker::ReplacementThreadPromotionRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(DurableDispatchExecutorHandoffBlocker::ScmMutationRequested);
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
    use crate::DurableDispatchInvocationRequestId;

    fn request() -> DurableDispatchInvocationRequestRecord {
        DurableDispatchInvocationRequestRecord {
            request_id: DurableDispatchInvocationRequestId(
                "durable-dispatch-invocation-request:dispatch-attempt:1:provider-transport-write:1"
                    .to_owned(),
            ),
            preflight_id: "durable-dispatch-invocation-preflight:dispatch-attempt:1".to_owned(),
            admission_id: "durable-provider-executor-dispatch-admission:dispatch-attempt:1"
                .to_owned(),
            selection_id: "durable-provider-executor-dispatch-selection:1".to_owned(),
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
            status: DurableDispatchInvocationRequestStatus::AcceptedForExecutorHandoff,
            blockers: Vec::new(),
            evidence_refs: vec!["evidence:request:1".to_owned()],
            operator_confirmation_ref: Some("operator-confirmation:invoke:1".to_owned()),
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

    fn input() -> DurableDispatchExecutorHandoffInput {
        DurableDispatchExecutorHandoffInput {
            request: request(),
            supported_methods: vec![DurableProviderExecutorMethod::TurnStart],
            live_executor_method_sequence: vec![CodexAppServerLiveExecutorMethod::TurnStart],
            payload_ref: Some("payload:turn-start:1".to_owned()),
            handoff_evidence_refs: vec!["evidence:handoff:1".to_owned()],
            executor_invocation_requested: false,
            provider_write_requested: false,
            raw_payload_retained: false,
            raw_stream_retained: false,
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
    fn durable_dispatch_executor_handoff_accepts_request_without_execution() {
        let record = durable_dispatch_executor_handoff(input());

        assert_eq!(
            record.status,
            DurableDispatchExecutorHandoffStatus::ReadyForLiveExecutorBoundary
        );
        assert!(record.blockers.is_empty());
        assert_eq!(record.dispatch_attempt_id, "dispatch-attempt:1");
        assert_eq!(record.write_attempt_id, "provider-transport-write:1");
        assert_eq!(record.idempotency_key, "idempotency:1");
        assert!(!record.executor_invoked);
        assert!(!record.provider_write_executed);
        assert!(!record.raw_payload_retained);
        assert!(!record.task_mutation_permitted);
    }

    #[test]
    fn durable_dispatch_executor_handoff_blocks_bad_shape() {
        let mut input = input();
        input.request.status = DurableDispatchInvocationRequestStatus::Blocked;
        input.supported_methods.clear();
        input.live_executor_method_sequence.clear();
        input.payload_ref = None;
        input.handoff_evidence_refs.clear();

        let record = durable_dispatch_executor_handoff(input);

        assert_eq!(record.status, DurableDispatchExecutorHandoffStatus::Blocked);
        assert!(record
            .blockers
            .contains(&DurableDispatchExecutorHandoffBlocker::RequestNotAccepted));
        assert!(record
            .blockers
            .contains(&DurableDispatchExecutorHandoffBlocker::UnsupportedProviderMethod));
        assert!(record
            .blockers
            .contains(&DurableDispatchExecutorHandoffBlocker::MissingLiveExecutorMethodSequence));
        assert!(record
            .blockers
            .contains(&DurableDispatchExecutorHandoffBlocker::MissingPayloadRef));
        assert!(record
            .blockers
            .contains(&DurableDispatchExecutorHandoffBlocker::MissingHandoffEvidence));
    }

    #[test]
    fn durable_dispatch_executor_handoff_blocks_authority_widening() {
        let mut input = input();
        input.executor_invocation_requested = true;
        input.provider_write_requested = true;
        input.raw_payload_retained = true;
        input.raw_stream_retained = true;
        input.task_mutation_requested = true;
        input.review_acceptance_requested = true;
        input.callback_answer_requested = true;
        input.interruption_requested = true;
        input.recovery_requested = true;
        input.replacement_thread_promotion_requested = true;
        input.scm_mutation_requested = true;

        let record = durable_dispatch_executor_handoff(input);

        assert!(record
            .blockers
            .contains(&DurableDispatchExecutorHandoffBlocker::ExecutorInvocationRequested));
        assert!(record
            .blockers
            .contains(&DurableDispatchExecutorHandoffBlocker::ProviderWriteRequested));
        assert!(record
            .blockers
            .contains(&DurableDispatchExecutorHandoffBlocker::RawPayloadRetained));
        assert!(record
            .blockers
            .contains(&DurableDispatchExecutorHandoffBlocker::TaskMutationRequested));
        assert!(record
            .blockers
            .contains(&DurableDispatchExecutorHandoffBlocker::ScmMutationRequested));
    }
}
