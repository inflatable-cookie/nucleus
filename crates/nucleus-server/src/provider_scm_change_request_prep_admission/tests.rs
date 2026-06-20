use super::*;

#[test]
fn scm_change_request_prep_admission_records_admit_accepted_decisions() {
    let record = scm_change_request_prep_admission(input(review_decision(
        ScmCaptureReviewDecisionPersistenceStatus::Persisted,
        ScmCaptureReviewDecision::Accept,
    )));

    assert_eq!(record.status, ScmChangeRequestPrepAdmissionStatus::Admitted);
    assert!(record.preparation_admitted);
    assert_eq!(record.adapter_label, "adapter:scm".to_owned());
    assert_eq!(record.workflow_label, "change-request".to_owned());
    assert_eq!(record.repo_id, "repo:1".to_owned());
    assert_eq!(record.evidence_refs, vec!["evidence:1"]);
    assert!(!record.branch_or_snapshot_authority_granted);
    assert!(!record.forge_authority_granted);
}

#[test]
fn scm_change_request_prep_decision_blockers_reject_non_accepted_decisions() {
    for decision in [
        ScmCaptureReviewDecision::Reject("wrong".to_owned()),
        ScmCaptureReviewDecision::NeedsChanges("tests".to_owned()),
        ScmCaptureReviewDecision::Abandon("old".to_owned()),
    ] {
        let record = scm_change_request_prep_admission(input(decision_record(decision)));

        assert_eq!(record.status, ScmChangeRequestPrepAdmissionStatus::Blocked);
        assert!(record
            .blockers
            .contains(&ScmChangeRequestPrepAdmissionBlocker::DecisionNotAccepted));
        assert!(!record.preparation_admitted);
    }
}

#[test]
fn scm_change_request_prep_decision_blockers_reject_duplicate_or_blocked_records() {
    for status in [
        ScmCaptureReviewDecisionPersistenceStatus::DuplicateNoop,
        ScmCaptureReviewDecisionPersistenceStatus::Blocked,
    ] {
        let record = scm_change_request_prep_admission(input(review_decision(
            status,
            ScmCaptureReviewDecision::Accept,
        )));

        assert_eq!(record.status, ScmChangeRequestPrepAdmissionStatus::Blocked);
        assert!(record
            .blockers
            .contains(&ScmChangeRequestPrepAdmissionBlocker::DecisionNotPersisted));
    }
}

#[test]
fn scm_change_request_prep_adapter_neutrality_keeps_generic_labels() {
    let mut input = input(review_decision(
        ScmCaptureReviewDecisionPersistenceStatus::Persisted,
        ScmCaptureReviewDecision::Accept,
    ));
    input.adapter_label = "adapter:convergence".to_owned();
    input.workflow_label = "publish-request".to_owned();

    let record = scm_change_request_prep_admission(input);

    assert_eq!(record.status, ScmChangeRequestPrepAdmissionStatus::Admitted);
    assert_eq!(record.adapter_label, "adapter:convergence");
    assert_eq!(record.workflow_label, "publish-request");
    assert!(!record.commit_or_publish_authority_granted);
    assert!(!record.push_or_remote_publish_authority_granted);
}

#[test]
fn scm_change_request_prep_diagnostics_summarize_without_authority() {
    let admitted = scm_change_request_prep_admission(input(review_decision(
        ScmCaptureReviewDecisionPersistenceStatus::Persisted,
        ScmCaptureReviewDecision::Accept,
    )));
    let blocked = scm_change_request_prep_admission(input(decision_record(
        ScmCaptureReviewDecision::NeedsChanges("tests".to_owned()),
    )));
    let mut repair_input = input(review_decision(
        ScmCaptureReviewDecisionPersistenceStatus::Persisted,
        ScmCaptureReviewDecision::Accept,
    ));
    repair_input.adapter_label.clear();
    let repair = scm_change_request_prep_admission(repair_input);

    let diagnostics = scm_change_request_prep_diagnostics(vec![admitted, blocked, repair]);

    assert_eq!(diagnostics.admission_count, 3);
    assert_eq!(diagnostics.admitted_count, 1);
    assert_eq!(diagnostics.blocked_count, 1);
    assert_eq!(diagnostics.repair_required_count, 1);
    assert!(diagnostics.blocker_count > 0);
    assert!(diagnostics.adapter_neutral);
    assert!(!diagnostics.forge_authority_granted);
    assert!(!diagnostics.raw_output_retained);
}

#[test]
fn scm_change_request_prep_authority_closeout_blocks_external_effects() {
    let mut input = input(review_decision(
        ScmCaptureReviewDecisionPersistenceStatus::Persisted,
        ScmCaptureReviewDecision::Accept,
    ));
    input.branch_or_snapshot_requested = true;
    input.commit_or_publish_requested = true;
    input.push_or_remote_publish_requested = true;
    input.forge_effect_requested = true;
    input.provider_write_requested = true;
    input.callback_response_requested = true;
    input.interruption_requested = true;
    input.recovery_requested = true;
    input.raw_output_present = true;

    let record = scm_change_request_prep_admission(input);

    assert_eq!(record.status, ScmChangeRequestPrepAdmissionStatus::Blocked);
    assert!(record
        .blockers
        .contains(&ScmChangeRequestPrepAdmissionBlocker::BranchOrSnapshotRequested));
    assert!(record
        .blockers
        .contains(&ScmChangeRequestPrepAdmissionBlocker::ForgeEffectRequested));
    assert!(!record.branch_or_snapshot_authority_granted);
    assert!(!record.commit_or_publish_authority_granted);
    assert!(!record.push_or_remote_publish_authority_granted);
    assert!(!record.forge_authority_granted);
    assert!(!record.provider_authority_granted);
    assert!(!record.callback_authority_granted);
    assert!(!record.interruption_authority_granted);
    assert!(!record.recovery_authority_granted);
    assert!(!record.raw_output_retained);
}

fn input(decision: ScmCaptureReviewDecisionRecord) -> ScmChangeRequestPrepAdmissionInput {
    ScmChangeRequestPrepAdmissionInput {
        decision,
        adapter_label: "adapter:scm".to_owned(),
        workflow_label: "change-request".to_owned(),
        branch_or_snapshot_requested: false,
        commit_or_publish_requested: false,
        push_or_remote_publish_requested: false,
        forge_effect_requested: false,
        provider_write_requested: false,
        callback_response_requested: false,
        interruption_requested: false,
        recovery_requested: false,
        raw_output_present: false,
    }
}

fn decision_record(decision: ScmCaptureReviewDecision) -> ScmCaptureReviewDecisionRecord {
    review_decision(
        ScmCaptureReviewDecisionPersistenceStatus::Persisted,
        decision,
    )
}

fn review_decision(
    status: ScmCaptureReviewDecisionPersistenceStatus,
    decision: ScmCaptureReviewDecision,
) -> ScmCaptureReviewDecisionRecord {
    ScmCaptureReviewDecisionRecord {
        decision_id: "decision:1".to_owned(),
        readiness_id: "readiness:1".to_owned(),
        workflow_id: "workflow:1".to_owned(),
        task_id: "task:1".to_owned(),
        work_item_id: Some("work:1".to_owned()),
        completion_id: Some("completion:1".to_owned()),
        repo_id: "repo:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        decision,
        evidence_refs: vec!["evidence:1".to_owned()],
        readiness_status: crate::ScmCaptureReviewReadinessStatus::Ready,
        status,
        blockers: Vec::new(),
        duplicate_decision_detected: false,
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
