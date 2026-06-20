use super::*;

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
