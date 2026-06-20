use super::*;

#[test]
fn scm_capture_workflow_handler_routing_reads_persisted_git_execution_records() {
    let (_temp_dir, mut handler) = handler(None);
    persist_git_dry_run_execution(&handler);

    let response = handler.handle(diagnostics_request(DiagnosticsQuery::ScmCaptureWorkflow));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureWorkflow(record)
        )) if record.workflow_count == 1
            && record.completed_stage_count > 0
            && record.missing_stage_count > 0
            && record.evidence_ref_count == 1
            && !record.scm_mutation_authority_granted
            && !record.raw_output_retained
    ));
}

#[test]
fn scm_capture_workflow_control_authority_keeps_diagnostics_read_only() {
    let (_temp_dir, mut handler) = handler(None);
    persist_git_dry_run_execution(&handler);

    let before = crate::read_git_dry_run_executions(handler.state())
        .expect("read before")
        .len();
    let response = handler.handle(diagnostics_request(DiagnosticsQuery::ScmCaptureWorkflow));
    let after = crate::read_git_dry_run_executions(handler.state())
        .expect("read after")
        .len();

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert_eq!(before, after);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureWorkflow(record)
        )) if record.replay_only
            && !record.scm_mutation_authority_granted
            && !record.forge_authority_granted
            && !record.provider_authority_granted
            && !record.callback_authority_granted
            && !record.interruption_authority_granted
            && !record.recovery_authority_granted
            && !record.raw_output_retained
    ));
}

#[test]
fn scm_capture_review_handler_routing_reads_persisted_git_execution_records() {
    let (_temp_dir, mut handler) = handler(None);
    persist_git_dry_run_execution(&handler);

    let response = handler.handle(diagnostics_request(DiagnosticsQuery::ScmCaptureReview));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureReview(record)
        )) if record.readiness_count == 1
            && record.blocked_count == 1
            && record.blocker_count > 0
            && record.evidence_ref_count == 1
            && !record.operator_decision_created
            && !record.scm_mutation_authority_granted
            && !record.raw_output_retained
    ));
}

#[test]
fn scm_capture_review_control_authority_keeps_diagnostics_read_only() {
    let (_temp_dir, mut handler) = handler(None);
    persist_git_dry_run_execution(&handler);

    let before = crate::read_git_dry_run_executions(handler.state())
        .expect("read before")
        .len();
    let response = handler.handle(diagnostics_request(DiagnosticsQuery::ScmCaptureReview));
    let after = crate::read_git_dry_run_executions(handler.state())
        .expect("read after")
        .len();

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert_eq!(before, after);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureReview(record)
        )) if !record.operator_decision_created
            && !record.change_request_authority_granted
            && !record.scm_mutation_authority_granted
            && !record.forge_authority_granted
            && !record.provider_authority_granted
            && !record.callback_authority_granted
            && !record.interruption_authority_granted
            && !record.recovery_authority_granted
            && !record.raw_output_retained
    ));
}
