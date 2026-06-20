use super::*;
use nucleus_local_store::SqliteBackend;

#[test]
fn scm_capture_review_decision_records_accept_ready_readiness() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));

    let record =
        persist_scm_capture_review_decision(&state, input(ready())).expect("persist decision");

    assert_eq!(
        record.status,
        ScmCaptureReviewDecisionPersistenceStatus::Persisted
    );
    assert_eq!(record.decision, ScmCaptureReviewDecision::Accept);
    assert_eq!(record.readiness_id, "readiness:1");
    assert_eq!(record.workflow_id, "workflow:1");
    assert_eq!(record.evidence_refs, vec!["evidence:1"]);
    assert!(!record.change_request_authority_granted);
    assert!(!record.scm_mutation_authority_granted);
    assert!(!record.raw_output_retained);
}

#[test]
fn scm_capture_review_decision_persistence_survives_reopen() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));

    let record =
        persist_scm_capture_review_decision(&state, input(ready())).expect("persist decision");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_scm_capture_review_decisions(&reopened).expect("read persisted decisions");

    assert_eq!(records, vec![record]);
    assert_eq!(records[0].decision, ScmCaptureReviewDecision::Accept);
    assert!(!records[0].change_request_authority_granted);
    assert!(!records[0].raw_output_retained);
}

#[test]
fn scm_capture_review_decision_duplicate_blocked_is_noop() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let readiness = ready();
    let mut input = input(readiness.clone());
    input.existing_decision_ids.push(decision_id(&readiness));

    let record = persist_scm_capture_review_decision(&state, input).expect("duplicate noop");

    assert_eq!(
        record.status,
        ScmCaptureReviewDecisionPersistenceStatus::DuplicateNoop
    );
    assert!(record.duplicate_decision_detected);
}

#[test]
fn scm_capture_review_decision_duplicate_blocked_rejects_accepting_blocked_readiness() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));

    let record =
        persist_scm_capture_review_decision(&state, input(blocked())).expect("blocked accept");

    assert_eq!(
        record.status,
        ScmCaptureReviewDecisionPersistenceStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&ScmCaptureReviewDecisionPersistenceBlocker::ReadinessNotReady));
    assert!(!record.scm_mutation_authority_granted);
}

#[test]
fn scm_capture_review_decision_records_preserve_non_accepting_blocked_decisions() {
    for decision in [
        ScmCaptureReviewDecision::Reject("wrong files".to_owned()),
        ScmCaptureReviewDecision::NeedsChanges("refresh evidence".to_owned()),
        ScmCaptureReviewDecision::Abandon("superseded".to_owned()),
    ] {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut input = input(blocked());
        input.decision = decision.clone();

        let record = persist_scm_capture_review_decision(&state, input)
            .expect("persist non-accepting decision");

        assert_eq!(
            record.status,
            ScmCaptureReviewDecisionPersistenceStatus::Persisted
        );
        assert_eq!(record.decision, decision);
    }
}

#[test]
fn scm_capture_review_decision_diagnostics_count_statuses_without_authority() {
    let diagnostics = scm_capture_review_decision_diagnostics(vec![
        decision_record(
            input(ready()),
            "decision:accepted".to_owned(),
            ScmCaptureReviewDecisionPersistenceStatus::Persisted,
            Vec::new(),
            false,
        ),
        decision_record(
            {
                let mut input = input(blocked());
                input.decision = ScmCaptureReviewDecision::NeedsChanges("tests".to_owned());
                input
            },
            "decision:changes".to_owned(),
            ScmCaptureReviewDecisionPersistenceStatus::Blocked,
            vec![ScmCaptureReviewDecisionPersistenceBlocker::ReadinessNotReady],
            false,
        ),
        decision_record(
            {
                let mut input = input(ready());
                input.decision = ScmCaptureReviewDecision::Abandon("old".to_owned());
                input
            },
            "decision:duplicate".to_owned(),
            ScmCaptureReviewDecisionPersistenceStatus::DuplicateNoop,
            Vec::new(),
            true,
        ),
    ]);

    assert_eq!(diagnostics.decision_count, 3);
    assert_eq!(diagnostics.persisted_decision_count, 1);
    assert_eq!(diagnostics.duplicate_decision_count, 1);
    assert_eq!(diagnostics.blocked_decision_count, 1);
    assert_eq!(diagnostics.accepted_count, 1);
    assert_eq!(diagnostics.needs_changes_count, 1);
    assert_eq!(diagnostics.abandoned_count, 1);
    assert_eq!(diagnostics.blocker_count, 1);
    assert!(!diagnostics.change_request_authority_granted);
    assert!(!diagnostics.scm_mutation_authority_granted);
    assert!(!diagnostics.raw_output_retained);
}

#[test]
fn scm_capture_review_decision_authority_closeout_blocks_external_effects() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut input = input(ready());
    input.raw_output_present = true;
    input.change_request_requested = true;
    input.scm_mutation_requested = true;
    input.forge_effect_requested = true;
    input.provider_write_requested = true;
    input.callback_response_requested = true;
    input.interruption_requested = true;
    input.recovery_requested = true;

    let record = persist_scm_capture_review_decision(&state, input).expect("blocked");

    assert_eq!(
        record.status,
        ScmCaptureReviewDecisionPersistenceStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&ScmCaptureReviewDecisionPersistenceBlocker::ChangeRequestRequested));
    assert!(record
        .blockers
        .contains(&ScmCaptureReviewDecisionPersistenceBlocker::ScmMutationRequested));
    assert!(!record.change_request_authority_granted);
    assert!(!record.scm_mutation_authority_granted);
    assert!(!record.forge_authority_granted);
    assert!(!record.provider_authority_granted);
    assert!(!record.callback_authority_granted);
    assert!(!record.interruption_authority_granted);
    assert!(!record.recovery_authority_granted);
    assert!(!record.raw_output_retained);
}

fn input(readiness: ScmCaptureReviewReadinessRecord) -> ScmCaptureReviewDecisionPersistenceInput {
    ScmCaptureReviewDecisionPersistenceInput {
        readiness,
        decision: ScmCaptureReviewDecision::Accept,
        existing_decision_ids: Vec::new(),
        raw_output_present: false,
        change_request_requested: false,
        scm_mutation_requested: false,
        forge_effect_requested: false,
        provider_write_requested: false,
        callback_response_requested: false,
        interruption_requested: false,
        recovery_requested: false,
    }
}

fn ready() -> ScmCaptureReviewReadinessRecord {
    ScmCaptureReviewReadinessRecord {
        readiness_id: "readiness:1".to_owned(),
        workflow_id: "workflow:1".to_owned(),
        task_id: "task:1".to_owned(),
        work_item_id: Some("work:1".to_owned()),
        completion_id: Some("completion:1".to_owned()),
        repo_id: "repo:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        status: ScmCaptureReviewReadinessStatus::Ready,
        blockers: Vec::new(),
        evidence_refs: vec!["evidence:1".to_owned()],
        review_ready: true,
        change_request_authority_granted: false,
        scm_mutation_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        raw_output_retained: false,
    }
}

fn blocked() -> ScmCaptureReviewReadinessRecord {
    ScmCaptureReviewReadinessRecord {
        status: ScmCaptureReviewReadinessStatus::Blocked,
        review_ready: false,
        blockers: vec![crate::ScmCaptureReviewReadinessBlocker::WorkflowNotReady],
        ..ready()
    }
}
