use super::*;
use crate::{
    durable_dispatch_invocation_preflight, durable_provider_executor_command,
    durable_provider_executor_dispatch_admission, durable_provider_executor_dispatch_selection,
    DurableDispatchInvocationPreflightInput, DurableProviderExecutorCommandId,
    DurableProviderExecutorCommandInput, DurableProviderExecutorDispatchAdmissionInput,
    DurableProviderExecutorDispatchSelectionInput, DurableProviderExecutorLane,
    DurableProviderExecutorMethod,
};

fn preflight() -> DurableDispatchInvocationPreflightRecord {
    durable_dispatch_invocation_preflight(DurableDispatchInvocationPreflightInput {
        admission: durable_provider_executor_dispatch_admission(
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
        ),
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
    })
}

fn input() -> DurableDispatchInvocationRequestInput {
    DurableDispatchInvocationRequestInput {
        preflight: preflight(),
        invocation_request_evidence_refs: vec!["evidence:request:1".to_owned()],
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
fn durable_dispatch_invocation_request_accepts_preflight_without_execution() {
    let record = durable_dispatch_invocation_request(input());

    assert_eq!(
        record.status,
        DurableDispatchInvocationRequestStatus::AcceptedForExecutorHandoff
    );
    assert!(record.blockers.is_empty());
    assert_eq!(
        record.request_id.0,
        "durable-dispatch-invocation-request:dispatch-attempt:1:provider-transport-write:1"
    );
    assert!(!record.executor_invoked);
    assert!(!record.provider_write_executed);
    assert!(!record.client_authority_granted);
    assert!(!record.task_mutation_permitted);
}

#[test]
fn durable_dispatch_invocation_request_blocks_preflight_and_missing_evidence() {
    let mut input = input();
    input.preflight.status = DurableDispatchInvocationPreflightStatus::Blocked;
    input.invocation_request_evidence_refs.clear();

    let record = durable_dispatch_invocation_request(input);

    assert_eq!(
        record.status,
        DurableDispatchInvocationRequestStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationRequestBlocker::PreflightNotAccepted));
    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationRequestBlocker::MissingInvocationRequestEvidence));
}

#[test]
fn durable_dispatch_invocation_request_blocks_authority_widening() {
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

    let record = durable_dispatch_invocation_request(input);

    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationRequestBlocker::ExecutorInvocationRequested));
    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationRequestBlocker::ProviderWriteRequested));
    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationRequestBlocker::TaskMutationRequested));
    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationRequestBlocker::ScmMutationRequested));
}
