use super::*;

mod completion;
mod scm;

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
            && snapshot.scm_capture_workflow.workflow_count == 0
            && snapshot.scm_capture_workflow.replay_only
            && !snapshot.scm_capture_workflow.scm_mutation_authority_granted
            && !snapshot.scm_capture_workflow.raw_output_retained
            && snapshot.scm_capture_review.readiness_count == 0
            && !snapshot.scm_capture_review.operator_decision_created
            && !snapshot.scm_capture_review.scm_mutation_authority_granted
            && !snapshot.scm_capture_review.raw_output_retained
            && snapshot.scm_capture_review_decision.decision_count == 0
            && !snapshot
                .scm_capture_review_decision
                .change_request_authority_granted
            && !snapshot
                .scm_capture_review_decision
                .scm_mutation_authority_granted
            && !snapshot.scm_capture_review_decision.raw_output_retained
            && snapshot.scm_change_request_preparation.admission_count == 0
            && snapshot.scm_change_request_preparation.adapter_neutral
            && !snapshot
                .scm_change_request_preparation
                .branch_or_snapshot_authority_granted
            && !snapshot.scm_change_request_preparation.forge_authority_granted
            && !snapshot.scm_change_request_preparation.raw_output_retained
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
    let scm_capture_workflow =
        handler.handle(diagnostics_request(DiagnosticsQuery::ScmCaptureWorkflow));
    let scm_capture_review =
        handler.handle(diagnostics_request(DiagnosticsQuery::ScmCaptureReview));
    let scm_capture_review_decision = handler.handle(diagnostics_request(
        DiagnosticsQuery::ScmCaptureReviewDecision,
    ));
    let scm_change_request_preparation = handler.handle(diagnostics_request(
        DiagnosticsQuery::ScmChangeRequestPreparation,
    ));

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
    assert!(matches!(
        scm_capture_workflow.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureWorkflow(record)
        )) if record.workflow_count == 0
            && record.replay_only
            && !record.scm_mutation_authority_granted
            && !record.raw_output_retained
    ));
    assert!(matches!(
        scm_capture_review.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureReview(record)
        )) if record.readiness_count == 0
            && !record.operator_decision_created
            && !record.change_request_authority_granted
            && !record.scm_mutation_authority_granted
            && !record.raw_output_retained
    ));
    assert!(matches!(
        scm_capture_review_decision.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureReviewDecision(record)
        )) if record.decision_count == 0
            && !record.change_request_authority_granted
            && !record.scm_mutation_authority_granted
            && !record.raw_output_retained
    ));
    assert!(matches!(
        scm_change_request_preparation.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmChangeRequestPreparation(record)
        )) if record.admission_count == 0
            && record.adapter_neutral
            && !record.branch_or_snapshot_authority_granted
            && !record.forge_authority_granted
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
