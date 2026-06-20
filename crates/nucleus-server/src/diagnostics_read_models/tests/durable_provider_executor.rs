use crate::{
    codex_live_executor_outcome_record, durable_provider_executor_command,
    durable_provider_executor_diagnostics, durable_provider_executor_dispatch_admission,
    durable_provider_executor_dispatch_outcome_linkage,
    durable_provider_executor_dispatch_selection, durable_provider_executor_status,
    CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorMethod,
    CodexAppServerLiveExecutorOutcomeInput, CodexAppServerLiveExecutorOutcomeStatus,
    DurableProviderExecutorCommandId, DurableProviderExecutorCommandInput,
    DurableProviderExecutorDispatchAdmissionInput,
    DurableProviderExecutorDispatchOutcomeLinkageInput,
    DurableProviderExecutorDispatchSelectionInput, DurableProviderExecutorLane,
    DurableProviderExecutorMethod, DurableProviderExecutorRequestedState,
    DurableProviderExecutorStatusInput,
};

#[test]
fn durable_provider_executor_diagnostics_are_read_only_and_sanitized() {
    let command = command();
    let status = durable_provider_executor_status(DurableProviderExecutorStatusInput {
        command: command.clone(),
        requested_state: DurableProviderExecutorRequestedState::Completed,
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
    });

    let diagnostics = durable_provider_executor_diagnostics(
        &[command],
        &[status],
        &[],
        &[],
        &[],
        &[],
        &[],
        &[],
        &[],
    );

    assert_eq!(diagnostics.source_status, "records");
    assert_eq!(diagnostics.commands.len(), 1);
    assert_eq!(diagnostics.statuses.len(), 1);
    assert_eq!(diagnostics.dispatch.record_count, 0);
    assert_eq!(diagnostics.invocation.record_count, 0);
    assert!(!diagnostics.client_can_execute_provider_write);
    assert!(!diagnostics.client_can_mutate_tasks);
    assert!(!diagnostics.client_can_accept_review);
    assert!(!diagnostics.client_can_answer_callbacks);
    assert!(!diagnostics.client_can_interrupt_provider);
    assert!(!diagnostics.client_can_resume_provider);
    assert!(!diagnostics.client_can_promote_replacement_thread);
    assert!(!diagnostics.client_can_mutate_scm);
    assert!(!diagnostics.provider_material_exposed);

    let command = &diagnostics.commands[0];
    assert_eq!(command.status, "accepted");
    assert_eq!(command.next_action, "wait_for_durable_executor_status");
    assert!(!command.provider_write_executed);
    assert!(!command.provider_material_exposed);

    let status = &diagnostics.statuses[0];
    assert_eq!(status.state, "completed");
    assert_eq!(status.next_action, "inspect_executor_receipt");
    assert!(status.provider_write_recorded);
    assert!(status.provider_completion_recorded);
    assert!(!status.provider_material_exposed);
    assert!(!status.task_mutation_permitted);
    assert!(!status.review_acceptance_permitted);
}

#[test]
fn durable_executor_dispatch_diagnostics_expose_read_only_progress() {
    let command = command();
    let selection = durable_provider_executor_dispatch_selection(
        DurableProviderExecutorDispatchSelectionInput {
            command: command.clone(),
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
    );
    let admission = durable_provider_executor_dispatch_admission(
        DurableProviderExecutorDispatchAdmissionInput {
            selection: selection.clone(),
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
    );
    let outcome = codex_live_executor_outcome_record(CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: "codex:local-default".to_owned(),
        write_attempt_id: "provider-transport-write:1".to_owned(),
        receipt_refs: vec!["receipt:provider:1".to_owned()],
        thread_id: Some("thread:1".to_owned()),
        turn_id: Some("turn:1".to_owned()),
        final_turn_status: Some("completed".to_owned()),
        status: CodexAppServerLiveExecutorOutcomeStatus::Completed,
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
        provider_write_executed: true,
    });
    let linkage = durable_provider_executor_dispatch_outcome_linkage(
        DurableProviderExecutorDispatchOutcomeLinkageInput {
            admission: admission.clone(),
            command,
            outcome,
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
        },
    );

    let diagnostics = durable_provider_executor_diagnostics(
        &[],
        &[],
        &[selection],
        &[admission],
        &[linkage],
        &[],
        &[],
        &[],
        &[],
    );

    assert_eq!(diagnostics.dispatch.record_count, 3);
    assert_eq!(diagnostics.dispatch.selections[0].status, "selected");
    assert_eq!(diagnostics.dispatch.admissions[0].status, "accepted");
    assert_eq!(diagnostics.dispatch.linkages[0].status, "linked");
    assert_eq!(
        diagnostics.dispatch.linkages[0].durable_status_state,
        "Completed"
    );
    assert!(!diagnostics.dispatch.client_can_execute_provider_write);
    assert!(!diagnostics.dispatch.client_can_mutate_tasks);
    assert!(!diagnostics.dispatch.provider_material_exposed);
    assert!(!diagnostics.dispatch.linkages[0].task_mutation_permitted);
}

fn command() -> crate::DurableProviderExecutorCommandRecord {
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
