use super::*;

#[test]
fn scm_capture_review_decision_handler_routing_reads_persisted_records() {
    let (_temp_dir, mut handler) = handler(None);
    persist_scm_capture_review_decision(&handler);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::ScmCaptureReviewDecision,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureReviewDecision(record)
        )) if record.decision_count == 1
            && record.persisted_decision_count == 1
            && record.accepted_count == 1
            && !record.change_request_authority_granted
            && !record.scm_mutation_authority_granted
            && !record.raw_output_retained
    ));
}

#[test]
fn scm_capture_review_decision_control_authority_keeps_diagnostics_read_only() {
    let (_temp_dir, mut handler) = handler(None);
    persist_scm_capture_review_decision(&handler);

    let before = crate::read_scm_capture_review_decisions(handler.state())
        .expect("read before")
        .len();
    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::ScmCaptureReviewDecision,
    ));
    let after = crate::read_scm_capture_review_decisions(handler.state())
        .expect("read after")
        .len();

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert_eq!(before, after);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureReviewDecision(record)
        )) if !record.change_request_authority_granted
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
fn scm_change_request_prep_handler_routing_reads_persisted_records() {
    let (_temp_dir, mut handler) = handler(None);
    persist_scm_change_request_prep(&handler);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::ScmChangeRequestPreparation,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmChangeRequestPreparation(record)
        )) if record.admission_count == 1
            && record.admitted_count == 1
            && record.adapter_neutral
            && !record.branch_or_snapshot_authority_granted
            && !record.forge_authority_granted
            && !record.raw_output_retained
    ));
}

#[test]
fn scm_change_request_prep_control_authority_keeps_diagnostics_read_only() {
    let (_temp_dir, mut handler) = handler(None);
    persist_scm_change_request_prep(&handler);

    let before = crate::read_scm_change_request_prep_records(handler.state())
        .expect("read before")
        .len();
    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::ScmChangeRequestPreparation,
    ));
    let after = crate::read_scm_change_request_prep_records(handler.state())
        .expect("read after")
        .len();

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert_eq!(before, after);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmChangeRequestPreparation(record)
        )) if !record.branch_or_snapshot_authority_granted
            && !record.commit_or_publish_authority_granted
            && !record.push_or_remote_publish_authority_granted
            && !record.forge_authority_granted
            && !record.provider_authority_granted
            && !record.callback_authority_granted
            && !record.interruption_authority_granted
            && !record.recovery_authority_granted
            && !record.raw_output_retained
    ));
}
