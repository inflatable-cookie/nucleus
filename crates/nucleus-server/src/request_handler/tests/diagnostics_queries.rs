use super::*;

#[test]
fn handler_returns_empty_diagnostics_snapshot_without_mutation() {
    let (_temp_dir, mut handler) = handler(None);
    let response = handler.handle(diagnostics_request(DiagnosticsQuery::All));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::All(snapshot)
        )) if !snapshot.steward.client_can_mutate
            && !snapshot.effigy.client_can_run_effigy
            && !snapshot.management_sync.client_can_mutate_provider
            && !snapshot.scm_session.client_can_mutate_working_copy
            && snapshot.steward.source_status == "empty"
            && snapshot.effigy.source_status == "disabled"
            && snapshot.management_sync.source_status == "empty"
            && snapshot.scm_session.source_status == "empty"
            && snapshot.task_agent.source_status == "empty"
            && !snapshot.task_agent.client_can_mutate_work_units
            && !snapshot.task_agent.provider_execution_available
            && snapshot.codex_provider.source_status == "empty"
            && !snapshot.codex_provider.client_can_control_provider
            && !snapshot.codex_provider.client_can_mutate_tasks
            && snapshot.live_evidence_completion.timeline_entry_count == 0
            && snapshot.live_evidence_completion.completed_work_item_count == 0
            && !snapshot.live_evidence_completion.client_mutation_authority
            && !snapshot.live_evidence_completion.provider_authority_granted
            && !snapshot.live_evidence_completion.scm_authority_granted
            && snapshot.completion_scm_readiness.candidate_count == 0
            && snapshot.completion_scm_readiness.repair_required
            && !snapshot.completion_scm_readiness.scm_authority_granted
            && !snapshot.completion_scm_readiness.forge_authority_granted
            && snapshot.completion_scm_capture.admission_count == 0
            && !snapshot.completion_scm_capture.scm_capture_executed
            && !snapshot.completion_scm_capture.raw_material_exposed
            && snapshot.completion_scm_capture_preparation.plan_count == 0
            && !snapshot
                .completion_scm_capture_preparation
                .scm_capture_authority_granted
            && snapshot.scm_capture_dry_run.plan_count == 0
            && !snapshot.scm_capture_dry_run.scm_dry_run_authority_granted
            && !snapshot.scm_capture_dry_run.scm_capture_authority_granted
            && snapshot.scm_capture_dry_run_execution.receipt_count == 0
            && !snapshot.scm_capture_dry_run_execution.scm_capture_executed
            && !snapshot.scm_capture_dry_run_execution.raw_material_exposed
            && snapshot.git_dry_run_execution.execution_count == 0
            && !snapshot.git_dry_run_execution.commit_executed
            && !snapshot.git_dry_run_execution.raw_output_retained
    ));
}

#[test]
fn handler_routes_each_diagnostics_query_kind() {
    let (_temp_dir, mut handler) = handler(None);

    let steward = handler.handle(diagnostics_request(DiagnosticsQuery::Steward));
    let effigy = handler.handle(diagnostics_request(DiagnosticsQuery::Effigy));
    let sync = handler.handle(diagnostics_request(DiagnosticsQuery::ManagementSync));
    let scm = handler.handle(diagnostics_request(DiagnosticsQuery::ScmSession));
    let task_agent = handler.handle(diagnostics_request(DiagnosticsQuery::TaskAgent));
    let codex = handler.handle(diagnostics_request(DiagnosticsQuery::CodexProvider));
    let completion = handler.handle(diagnostics_request(
        DiagnosticsQuery::LiveEvidenceCompletion,
    ));
    let completion_scm = handler.handle(diagnostics_request(
        DiagnosticsQuery::CompletionScmReadiness,
    ));
    let completion_capture =
        handler.handle(diagnostics_request(DiagnosticsQuery::CompletionScmCapture));
    let completion_preparation = handler.handle(diagnostics_request(
        DiagnosticsQuery::CompletionScmCapturePreparation,
    ));
    let scm_capture_dry_run =
        handler.handle(diagnostics_request(DiagnosticsQuery::ScmCaptureDryRun));
    let scm_capture_dry_run_execution = handler.handle(diagnostics_request(
        DiagnosticsQuery::ScmCaptureDryRunExecution,
    ));
    let git_dry_run_execution =
        handler.handle(diagnostics_request(DiagnosticsQuery::GitDryRunExecution));

    assert!(matches!(
        steward.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::Steward(_)
        ))
    ));
    assert!(matches!(
        effigy.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::Effigy(_)
        ))
    ));
    assert!(matches!(
        sync.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ManagementSync(_)
        ))
    ));
    assert!(matches!(
        scm.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmSession(_)
        ))
    ));
    assert!(matches!(
        task_agent.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::TaskAgent(_)
        ))
    ));
    assert!(matches!(
        codex.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CodexProvider(record)
        )) if !record.client_can_control_provider
            && !record.client_can_mutate_tasks
            && record.source_status == "empty"
    ));
    assert!(matches!(
        completion.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::LiveEvidenceCompletion(record)
        )) if record.timeline_entry_count == 0
            && !record.client_mutation_authority
            && !record.provider_authority_granted
            && !record.scm_authority_granted
    ));
    assert!(matches!(
        completion_scm.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmReadiness(record)
        )) if record.candidate_count == 0
            && record.repair_required
            && !record.scm_authority_granted
            && !record.forge_authority_granted
    ));
    assert!(matches!(
        completion_capture.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmCapture(record)
        )) if record.admission_count == 0
            && !record.scm_capture_executed
            && !record.provider_write_executed
    ));
    assert!(matches!(
        completion_preparation.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmCapturePreparation(record)
        )) if record.plan_count == 0
            && !record.scm_capture_authority_granted
            && !record.provider_authority_granted
    ));
    assert!(matches!(
        scm_capture_dry_run.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureDryRun(record)
        )) if record.plan_count == 0
            && !record.scm_dry_run_authority_granted
            && !record.scm_capture_authority_granted
            && !record.provider_authority_granted
    ));
    assert!(matches!(
        scm_capture_dry_run_execution.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureDryRunExecution(record)
        )) if record.receipt_count == 0
            && !record.scm_capture_executed
            && !record.provider_authority_granted
            && !record.raw_material_exposed
    ));
    assert!(matches!(
        git_dry_run_execution.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::GitDryRunExecution(record)
        )) if record.execution_count == 0
            && !record.commit_executed
            && !record.provider_write_executed
            && !record.raw_output_retained
    ));
}

#[test]
fn handler_reads_task_agent_diagnostics_from_persisted_task_history() {
    let (_temp_dir, mut handler) = handler(None);
    let source = persist_task_agent_source(&handler);

    let response = handler.handle(diagnostics_request(DiagnosticsQuery::TaskAgent));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::TaskAgent(record)
        )) if record.source_status == "records"
            && record.work_units.len() == 1
            && record.work_units[0].last_source_id == source.source_id.0
            && record.work_units[0].summary == source.summary
            && !record.client_can_mutate_work_units
            && !record.provider_execution_available
    ));
}

#[test]
fn handler_reads_codex_live_executor_diagnostics_from_persisted_outcomes() {
    let (_temp_dir, mut handler) = handler(None);
    for outcome in [
        live_executor_outcome(
            "completed",
            crate::CodexAppServerLiveExecutorOutcomeStatus::Completed,
        ),
        live_executor_outcome(
            "failed",
            crate::CodexAppServerLiveExecutorOutcomeStatus::Failed("provider exited".to_owned()),
        ),
        live_executor_outcome(
            "timeout",
            crate::CodexAppServerLiveExecutorOutcomeStatus::TimedOut,
        ),
    ] {
        crate::persist_codex_live_executor_outcome(
            handler.state(),
            crate::CodexAppServerLiveExecutorOutcomePersistenceInput { outcome },
        )
        .expect("persist live executor outcome");
    }

    let response = handler.handle(diagnostics_request(DiagnosticsQuery::CodexProvider));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CodexProvider(record)
        )) if record.source_status == "available"
            && record.live_executor.source_status == "records"
            && record.live_executor.attempts.len() == 3
            && record.live_executor.attempts[0].status == "completed"
            && record.live_executor.attempts[1].status == "failed"
            && record.live_executor.attempts[2].status == "timed_out"
            && !record.client_can_control_provider
            && !record.client_can_mutate_tasks
            && !record.live_executor.client_can_execute_provider_write
            && !record.live_executor.client_can_cancel_provider
            && !record.live_executor.client_can_resume_provider
            && !record.live_executor.client_can_mutate_tasks
    ));
}

#[test]
fn live_evidence_completion_handler_composition_reads_persisted_completions() {
    let (_temp_dir, mut handler) = handler(None);
    persist_live_evidence_completion(&handler);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::LiveEvidenceCompletion,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::LiveEvidenceCompletion(record)
        )) if record.timeline_entry_count == 1
            && record.completed_work_item_count == 1
            && record.repair_required_completion_ids.is_empty()
            && !record.client_mutation_authority
            && !record.provider_authority_granted
            && !record.scm_authority_granted
    ));
}

#[test]
fn live_evidence_completion_missing_state_routing_returns_empty_read_model() {
    let (_temp_dir, mut handler) = handler(None);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::LiveEvidenceCompletion,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::LiveEvidenceCompletion(record)
        )) if record.timeline_entry_count == 0
            && record.completed_work_item_count == 0
            && record.skipped_completion_ids.is_empty()
            && record.repair_required_completion_ids.is_empty()
            && !record.client_mutation_authority
    ));
}

#[test]
fn live_evidence_completion_handler_authority_keeps_diagnostics_read_only() {
    let (_temp_dir, mut handler) = handler(None);
    persist_live_evidence_completion(&handler);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::LiveEvidenceCompletion,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::LiveEvidenceCompletion(record)
        )) if !record.client_mutation_authority
            && !record.provider_authority_granted
            && !record.scm_authority_granted
            && !record.raw_provider_material_exposed
    ));
}

#[test]
fn completion_scm_handler_routing_returns_missing_state_repair_diagnostics() {
    let (_temp_dir, mut handler) = handler(None);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::CompletionScmReadiness,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmReadiness(record)
        )) if !record.source_history_available
            && record.repair_required
            && record.candidate_count == 0
            && record.readiness_count == 0
            && record.adapter_label == "unconfigured"
            && !record.scm_authority_granted
            && !record.forge_authority_granted
    ));
}

#[test]
fn completion_scm_persisted_history_source_returns_real_candidates() {
    let (_temp_dir, mut handler) = handler(None);
    persist_live_evidence_task_state_control(&handler);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::CompletionScmReadiness,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmReadiness(record)
        )) if record.source_history_available
            && record.candidate_count == 1
            && record.readiness_count == 1
            && record.repair_required_count == 1
            && record.repair_required
            && !record.scm_authority_granted
            && !record.forge_authority_granted
    ));
}

#[test]
fn completion_scm_handler_authority_keeps_diagnostics_read_only() {
    let (_temp_dir, mut handler) = handler(None);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::CompletionScmReadiness,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmReadiness(record)
        )) if !record.scm_authority_granted
            && !record.forge_authority_granted
            && !record.provider_authority_granted
            && !record.raw_material_exposed
    ));
}

#[test]
fn completion_scm_capture_handler_routing_reads_persisted_admissions() {
    let (_temp_dir, mut handler) = handler(None);
    persist_completion_scm_capture_admission(&handler);

    let response = handler.handle(diagnostics_request(DiagnosticsQuery::CompletionScmCapture));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmCapture(record)
        )) if record.admission_count == 1
            && record.admitted_count == 1
            && record.blocked_count == 0
            && !record.scm_capture_executed
            && !record.forge_change_request_created
    ));
}

#[test]
fn completion_scm_capture_control_authority_keeps_diagnostics_read_only() {
    let (_temp_dir, mut handler) = handler(None);
    persist_completion_scm_capture_admission(&handler);

    let response = handler.handle(diagnostics_request(DiagnosticsQuery::CompletionScmCapture));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmCapture(record)
        )) if !record.scm_capture_executed
            && !record.scm_publish_executed
            && !record.forge_change_request_created
            && !record.forge_merge_executed
            && !record.provider_write_executed
            && !record.callback_response_executed
            && !record.interruption_executed
            && !record.recovery_executed
            && !record.raw_material_exposed
    ));
}

#[test]
fn completion_scm_capture_preparation_handler_routing_reads_persisted_records() {
    let (_temp_dir, mut handler) = handler(None);
    persist_completion_scm_capture_preparation(&handler);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::CompletionScmCapturePreparation,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmCapturePreparation(record)
        )) if record.plan_count == 1
            && record.ready_plan_count == 1
            && record.unsupported_plan_count == 0
            && !record.scm_capture_authority_granted
            && !record.forge_authority_granted
    ));
}

#[test]
fn completion_scm_capture_preparation_control_authority_keeps_diagnostics_read_only() {
    let (_temp_dir, mut handler) = handler(None);
    persist_completion_scm_capture_preparation(&handler);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::CompletionScmCapturePreparation,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmCapturePreparation(record)
        )) if !record.scm_capture_authority_granted
            && !record.scm_publish_authority_granted
            && !record.forge_authority_granted
            && !record.provider_authority_granted
            && !record.raw_material_exposed
    ));
}

#[test]
fn scm_capture_dry_run_handler_routing_reads_persisted_records() {
    let (_temp_dir, mut handler) = handler(None);
    persist_scm_capture_dry_run_plan(&handler);

    let response = handler.handle(diagnostics_request(DiagnosticsQuery::ScmCaptureDryRun));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureDryRun(record)
        )) if record.plan_count == 1
            && record.ready_plan_count == 1
            && record.unsupported_plan_count == 0
            && !record.scm_dry_run_authority_granted
            && !record.scm_capture_authority_granted
            && !record.forge_authority_granted
    ));
}

#[test]
fn scm_capture_dry_run_control_authority_keeps_diagnostics_read_only() {
    let (_temp_dir, mut handler) = handler(None);
    persist_scm_capture_dry_run_plan(&handler);

    let response = handler.handle(diagnostics_request(DiagnosticsQuery::ScmCaptureDryRun));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureDryRun(record)
        )) if !record.scm_dry_run_authority_granted
            && !record.scm_capture_authority_granted
            && !record.scm_publish_authority_granted
            && !record.forge_authority_granted
            && !record.provider_authority_granted
            && !record.raw_material_exposed
    ));
}

#[test]
fn scm_capture_dry_run_execution_handler_routing_reads_persisted_receipts() {
    let (_temp_dir, mut handler) = handler(None);
    persist_scm_capture_dry_run_execution_receipt(&handler);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::ScmCaptureDryRunExecution,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureDryRunExecution(record)
        )) if record.receipt_count == 1
            && record.completed_count == 1
            && record.dry_run_executed_count == 1
            && !record.scm_capture_executed
            && !record.forge_authority_granted
    ));
}

#[test]
fn scm_capture_dry_run_execution_control_authority_keeps_diagnostics_read_only() {
    let (_temp_dir, mut handler) = handler(None);
    persist_scm_capture_dry_run_execution_receipt(&handler);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::ScmCaptureDryRunExecution,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureDryRunExecution(record)
        )) if !record.scm_capture_executed
            && !record.scm_publish_executed
            && !record.forge_authority_granted
            && !record.provider_authority_granted
            && !record.raw_material_exposed
    ));
}

#[test]
fn git_dry_run_execution_handler_routing_reads_persisted_records() {
    let (_temp_dir, mut handler) = handler(None);
    persist_git_dry_run_execution(&handler);

    let response = handler.handle(diagnostics_request(DiagnosticsQuery::GitDryRunExecution));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::GitDryRunExecution(record)
        )) if record.execution_count == 1
            && record.completed_count == 1
            && record.dry_run_executed_count == 1
            && !record.commit_executed
            && !record.forge_effect_executed
    ));
}

#[test]
fn git_dry_run_execution_control_authority_keeps_diagnostics_read_only() {
    let (_temp_dir, mut handler) = handler(None);
    persist_git_dry_run_execution(&handler);

    let before = crate::read_git_dry_run_executions(handler.state())
        .expect("read before")
        .len();
    let response = handler.handle(diagnostics_request(DiagnosticsQuery::GitDryRunExecution));
    let after = crate::read_git_dry_run_executions(handler.state())
        .expect("read after")
        .len();

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert_eq!(before, after);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::GitDryRunExecution(record)
        )) if !record.checkout_executed
            && !record.branch_mutation_executed
            && !record.commit_executed
            && !record.push_executed
            && !record.provider_write_executed
            && !record.raw_output_retained
    ));
}

fn diagnostics_request(query: DiagnosticsQuery) -> ServerControlRequest {
    ServerControlRequest {
        id: ServerControlRequestId("request:diagnostics".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:diagnostics".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Diagnostics(query),
        }),
    }
}

fn live_executor_outcome(
    suffix: &str,
    status: crate::CodexAppServerLiveExecutorOutcomeStatus,
) -> crate::CodexAppServerLiveExecutorOutcomeRecord {
    crate::codex_live_executor_outcome_record(crate::CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: "codex:local-default".to_owned(),
        write_attempt_id: format!("provider-transport-write:handler-{suffix}"),
        receipt_refs: vec![format!("receipt:handler-{suffix}")],
        thread_id: Some(format!("thread:handler-{suffix}")),
        turn_id: Some(format!("turn:handler-{suffix}")),
        final_turn_status: Some(live_executor_status_label(&status)),
        status,
        method_sequence: vec![
            crate::CodexAppServerLiveExecutorMethod::Initialize,
            crate::CodexAppServerLiveExecutorMethod::InitializedNotification,
            crate::CodexAppServerLiveExecutorMethod::ThreadStart,
            crate::CodexAppServerLiveExecutorMethod::TurnStart,
            crate::CodexAppServerLiveExecutorMethod::TurnCompleted,
            crate::CodexAppServerLiveExecutorMethod::Cleanup,
        ],
        notification_count: 1,
        server_request_count: 0,
        cleanup_status: crate::CodexAppServerLiveExecutorCleanupStatus::Completed,
        evidence_refs: vec![format!("evidence:handler-{suffix}")],
        provider_write_executed: true,
    })
}

fn live_executor_status_label(status: &crate::CodexAppServerLiveExecutorOutcomeStatus) -> String {
    match status {
        crate::CodexAppServerLiveExecutorOutcomeStatus::Accepted => "accepted",
        crate::CodexAppServerLiveExecutorOutcomeStatus::Completed => "completed",
        crate::CodexAppServerLiveExecutorOutcomeStatus::Failed(_) => "failed",
        crate::CodexAppServerLiveExecutorOutcomeStatus::TimedOut => "timed_out",
        crate::CodexAppServerLiveExecutorOutcomeStatus::Blocked(_) => "blocked",
        crate::CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(_) => "cleanup_required",
    }
    .to_owned()
}

fn persist_live_evidence_completion<B>(handler: &LocalControlRequestHandler<B>)
where
    B: nucleus_local_store::LocalStoreBackend + Clone,
{
    crate::persist_live_evidence_task_completion(
        handler.state(),
        crate::LiveEvidenceTaskCompletionPersistenceInput {
            admission: crate::LiveEvidenceTaskCompletionAdmissionRecord {
                admission_id: "completion-admission:handler".to_owned(),
                review_decision_id: "review-decision:handler".to_owned(),
                task_id: "task:handler".to_owned(),
                work_item_id: "work:handler".to_owned(),
                operator_ref: "operator:tom".to_owned(),
                evidence_refs: vec!["evidence:completion-handler".to_owned()],
                status: crate::LiveEvidenceTaskCompletionAdmissionStatus::Admitted,
                blockers: Vec::new(),
                task_completion_admitted: true,
                provider_write_permitted: false,
                callback_response_permitted: false,
                cancellation_permitted: false,
                resume_permitted: false,
                scm_mutation_permitted: false,
                raw_provider_material_retained: false,
                raw_stream_retained: false,
            },
            existing_completion_ids: Vec::new(),
            raw_provider_material_present: false,
            raw_stream_present: false,
            provider_write_requested: false,
            callback_response_requested: false,
            cancellation_requested: false,
            resume_requested: false,
            scm_mutation_requested: false,
        },
    )
    .expect("persist live evidence completion");
}

fn persist_live_evidence_task_state_control<B>(handler: &LocalControlRequestHandler<B>)
where
    B: nucleus_local_store::LocalStoreBackend + Clone,
{
    crate::persist_live_evidence_task_state_control(
        handler.state(),
        crate::LiveEvidenceTaskStateControlPersistenceInput {
            control: crate::LiveEvidenceTaskStateControlRecord {
                control_id: "control:handler".to_owned(),
                request_id: "request:handler".to_owned(),
                admission: crate::LiveEvidenceTaskStateTransitionAdmissionRecord {
                    admission_id: "admission:handler".to_owned(),
                    task_id: "task:handler".to_owned(),
                    work_item_id: "work:handler".to_owned(),
                    completion_id: "completion:handler".to_owned(),
                    operator_ref: "operator:tom".to_owned(),
                    evidence_refs: vec!["evidence:task-state-handler".to_owned()],
                    status: crate::LiveEvidenceTaskStateTransitionAdmissionStatus::Admitted,
                    blockers: Vec::new(),
                    task_state_transition_admitted: true,
                    provider_authority_granted: false,
                    callback_authority_granted: false,
                    interruption_authority_granted: false,
                    recovery_authority_granted: false,
                    scm_authority_granted: false,
                    raw_material_retained: false,
                },
                history: crate::LiveEvidenceTaskStateHistoryProjectionRecord {
                    projection_id: "history:handler".to_owned(),
                    entries: vec![crate::LiveEvidenceTaskStateHistoryEntry {
                        history_entry_id: "history:handler".to_owned(),
                        admission_id: "admission:handler".to_owned(),
                        task_id: "task:handler".to_owned(),
                        work_item_id: "work:handler".to_owned(),
                        completion_id: "completion:handler".to_owned(),
                        operator_ref: "operator:tom".to_owned(),
                        evidence_refs: vec!["evidence:task-state-handler".to_owned()],
                        task_state: "completed".to_owned(),
                    }],
                    skipped_admission_ids: Vec::new(),
                    provider_authority_granted: false,
                    scm_authority_granted: false,
                    raw_material_exposed: false,
                },
                task_state_mutation_requested: true,
                provider_authority_granted: false,
                callback_authority_granted: false,
                interruption_authority_granted: false,
                recovery_authority_granted: false,
                scm_authority_granted: false,
                raw_material_exposed: false,
            },
            existing_control_ids: Vec::new(),
            raw_material_present: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
            scm_mutation_requested: false,
        },
    )
    .expect("persist task-state control");
}

fn persist_completion_scm_capture_admission<B>(handler: &LocalControlRequestHandler<B>)
where
    B: nucleus_local_store::LocalStoreBackend + Clone,
{
    crate::persist_completion_scm_capture_admission(
        handler.state(),
        crate::CompletionScmCaptureAdmissionPersistenceInput {
            admission: crate::CompletionScmCaptureAdmissionRecord {
                admission_id: "admission:capture-handler".to_owned(),
                request_id: "request:capture-handler".to_owned(),
                readiness_id: "readiness:capture-handler".to_owned(),
                candidate_id: "candidate:capture-handler".to_owned(),
                task_id: "task:handler".to_owned(),
                work_item_id: Some("work:handler".to_owned()),
                completion_id: Some("completion:handler".to_owned()),
                operator_ref: "operator:tom".to_owned(),
                evidence_refs: vec!["evidence:capture-handler".to_owned()],
                status: crate::CompletionScmCaptureAdmissionStatus::Admitted,
                blockers: Vec::new(),
                capture_admitted: true,
                scm_capture_executed: false,
                scm_publish_executed: false,
                forge_change_request_created: false,
                forge_merge_executed: false,
                provider_write_executed: false,
                callback_response_executed: false,
                interruption_executed: false,
                recovery_executed: false,
                raw_material_exposed: false,
            },
            existing_admission_ids: Vec::new(),
            raw_material_present: false,
            scm_capture_requested: false,
            scm_publish_requested: false,
            forge_change_request_requested: false,
            forge_merge_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        },
    )
    .expect("persist completion scm capture admission");
}

fn persist_completion_scm_capture_preparation<B>(handler: &LocalControlRequestHandler<B>)
where
    B: nucleus_local_store::LocalStoreBackend + Clone,
{
    crate::persist_completion_scm_capture_preparation(
        handler.state(),
        crate::CompletionScmCapturePreparationPersistenceInput {
            plan_item: crate::CompletionScmCapturePlanItem {
                plan_item_id: "plan:handler".to_owned(),
                preparation_candidate_id: "prep:handler".to_owned(),
                task_id: "task:handler".to_owned(),
                work_item_id: Some("work:handler".to_owned()),
                completion_id: Some("completion:handler".to_owned()),
                adapter_label: "adapter:handler".to_owned(),
                workflow_label: "workflow:handler".to_owned(),
                status: crate::CompletionScmCapturePlanStatus::Ready,
                blockers: Vec::new(),
            },
            admission_id: "admission:handler".to_owned(),
            readiness_id: "readiness:handler".to_owned(),
            capture_candidate_id: "candidate:handler".to_owned(),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:preparation-handler".to_owned()],
            existing_preparation_ids: Vec::new(),
            raw_material_present: false,
            scm_capture_requested: false,
            scm_publish_requested: false,
            forge_change_request_requested: false,
            forge_merge_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        },
    )
    .expect("persist completion scm capture preparation");
}

fn persist_scm_capture_dry_run_plan<B>(handler: &LocalControlRequestHandler<B>)
where
    B: nucleus_local_store::LocalStoreBackend + Clone,
{
    crate::persist_scm_capture_dry_run_plan(
        handler.state(),
        crate::ScmCaptureDryRunPersistenceInput {
            plan_item: crate::ScmCaptureDryRunPlanItem {
                dry_run_plan_item_id: "dry-run-plan:handler".to_owned(),
                dry_run_candidate_id: "dry-run-candidate:handler".to_owned(),
                persisted_preparation_id: "persisted-preparation:handler".to_owned(),
                plan_item_id: "plan:handler".to_owned(),
                admission_id: "admission:handler".to_owned(),
                readiness_id: "readiness:handler".to_owned(),
                capture_candidate_id: "candidate:handler".to_owned(),
                task_id: "task:handler".to_owned(),
                work_item_id: Some("work:handler".to_owned()),
                completion_id: Some("completion:handler".to_owned()),
                operator_ref: "operator:tom".to_owned(),
                evidence_refs: vec!["evidence:dry-run-handler".to_owned()],
                adapter_label: "adapter:handler".to_owned(),
                workflow_label: "workflow:handler".to_owned(),
                status: crate::ScmCaptureDryRunPlanStatus::Ready,
                blockers: Vec::new(),
            },
            existing_dry_run_plan_ids: Vec::new(),
            raw_material_present: false,
            scm_dry_run_requested: false,
            scm_capture_requested: false,
            scm_publish_requested: false,
            forge_change_request_requested: false,
            forge_merge_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        },
    )
    .expect("persist scm capture dry-run plan");
}

fn persist_scm_capture_dry_run_execution_receipt<B>(handler: &LocalControlRequestHandler<B>)
where
    B: nucleus_local_store::LocalStoreBackend + Clone,
{
    crate::persist_scm_capture_dry_run_execution_receipt(
        handler.state(),
        crate::ScmCaptureDryRunExecutionPersistenceInput {
            receipt: crate::ScmCaptureDryRunReceiptRecord {
                receipt_id: "receipt:handler".to_owned(),
                capability_item_id: "capability:handler".to_owned(),
                admission_id: "admission:handler".to_owned(),
                persisted_dry_run_plan_id: "persisted-dry-run:handler".to_owned(),
                dry_run_plan_item_id: "dry-run-plan:handler".to_owned(),
                task_id: "task:handler".to_owned(),
                work_item_id: Some("work:handler".to_owned()),
                completion_id: Some("completion:handler".to_owned()),
                operator_ref: "operator:tom".to_owned(),
                adapter_label: "adapter:handler".to_owned(),
                workflow_label: "workflow:handler".to_owned(),
                outcome: crate::ScmCaptureDryRunReceiptStatus::Completed,
                blockers: Vec::new(),
                evidence_refs: vec!["evidence:dry-run-execution-handler".to_owned()],
                changed_path_count: 2,
                summary_line_count: 4,
                scm_dry_run_executed: true,
                scm_capture_executed: false,
                scm_publish_executed: false,
                forge_change_request_created: false,
                forge_merge_executed: false,
                provider_write_executed: false,
                callback_response_executed: false,
                interruption_executed: false,
                recovery_executed: false,
                raw_material_exposed: false,
            },
            existing_execution_receipt_ids: Vec::new(),
            raw_output_present: false,
            scm_capture_requested: false,
            scm_publish_requested: false,
            forge_change_request_requested: false,
            forge_merge_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        },
    )
    .expect("persist scm capture dry-run execution receipt");
}

fn persist_git_dry_run_execution<B>(handler: &LocalControlRequestHandler<B>)
where
    B: nucleus_local_store::LocalStoreBackend + Clone,
{
    crate::persist_git_dry_run_execution(
        handler.state(),
        crate::GitDryRunExecutionPersistenceInput {
            capture: crate::GitDryRunEvidenceCaptureRecord {
                capture_id: "capture:handler".to_owned(),
                handoff_id: "handoff:handler".to_owned(),
                request_id: "request:handler".to_owned(),
                descriptor_id: "git-dry-run-diff-stat".to_owned(),
                repo_id: "repo:handler".to_owned(),
                status: crate::GitDryRunEvidenceCaptureStatus::Completed,
                blockers: Vec::new(),
                exit_code: Some(0),
                changed_path_count: 3,
                staged_path_count: 1,
                unstaged_path_count: 1,
                untracked_path_count: 1,
                insertion_count: 12,
                deletion_count: 4,
                evidence_refs: vec!["evidence:git-dry-run-handler".to_owned()],
                git_dry_run_executed: true,
                git_mutation_executed: false,
                forge_effect_executed: false,
                provider_write_executed: false,
                callback_response_executed: false,
                interruption_executed: false,
                recovery_executed: false,
                raw_output_retained: false,
            },
            existing_execution_ids: Vec::new(),
            raw_stdout_present: false,
            raw_stderr_present: false,
            raw_diff_present: false,
            checkout_requested: false,
            branch_mutation_requested: false,
            commit_requested: false,
            push_requested: false,
            forge_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        },
    )
    .expect("persist git dry-run execution");
}
