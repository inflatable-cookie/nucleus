use super::*;

#[test]
fn management_projection_capture_prep_is_not_provider_execution() {
    let mut plan = ManagementProjectionSyncPlan::capture_preparation(
        ManagementProjectionSyncPlanId("sync-plan:capture".to_owned()),
        vec![
            ManagementProjectionFileRef::project(),
            ManagementProjectionFileRef::task("task:1"),
        ],
        vec![EngineRuntimeReceiptRecordId(
            "receipt:projection:1".to_owned(),
        )],
    );
    plan.status = ManagementProjectionSyncPlanStatus::Ready;
    plan.summary = Some("prepare projection files for later SCM capture".to_owned());

    let prep = ManagementProjectionCapturePrepRecord::from_sync_plan(
        ManagementProjectionCapturePrepId("capture-prep:1".to_owned()),
        &plan,
        vec!["sync-assist:1".to_owned()],
    );

    assert!(!prep.is_execution());
    assert_eq!(prep.status, ManagementProjectionCapturePrepStatus::Draft);
    assert!(prep.cites_projection_files_and_receipts());
    assert_eq!(prep.plan_id, plan.plan_id);
    assert_eq!(prep.assistance_refs, vec!["sync-assist:1".to_owned()]);
}

#[test]
fn management_capture_command_admits_provider_neutral_capture_prep() {
    let command = capture_command(vec![
        ManagementProjectionCapturePolicyGate::ProjectionApplied,
        ManagementProjectionCapturePolicyGate::ExpectedRevisionSatisfied,
        ManagementProjectionCapturePolicyGate::EvidenceSanitized,
    ]);
    let admission = command.admit();
    let prep = ManagementProjectionCapturePrepRecord::from_admitted_command(
        ManagementProjectionCapturePrepId("capture-prep:accepted".to_owned()),
        &command,
        &admission,
    );

    assert!(admission.is_accepted());
    assert!(!admission.provider_mutation_allowed);
    assert!(!command.mutates_provider());
    assert!(!command.is_share_or_publish());
    assert_eq!(
        prep.share_readiness(),
        ManagementProjectionCaptureShareReadiness::ReadyForReviewBoundary
    );
    assert_eq!(
        prep.file_refs,
        vec![
            ManagementProjectionFileRef::project(),
            ManagementProjectionFileRef::task("task:1")
        ]
    );
}

#[test]
fn management_capture_command_blocks_missing_or_unsafe_evidence() {
    let mut missing_evidence = capture_command(Vec::new());
    missing_evidence.evidence.apply_receipt_ids.clear();
    let missing_admission = missing_evidence.admit();

    assert!(!missing_admission.is_accepted());
    assert!(matches!(
        missing_admission.status,
        ManagementProjectionCaptureAdmissionStatus::Blocked(_)
    ));

    let mut unsafe_file = capture_command(Vec::new());
    unsafe_file.requested_file_refs = vec![ManagementProjectionFileRef(
        ".nucleus/tasks/task:1.toml".to_owned(),
    )];
    let unsafe_admission = unsafe_file.admit();

    assert!(!unsafe_admission.is_accepted());
    assert!(matches!(
        unsafe_admission.status,
        ManagementProjectionCaptureAdmissionStatus::Blocked(_)
    ));
}

#[test]
fn management_capture_command_blocks_policy_gates() {
    let command = capture_command(vec![ManagementProjectionCapturePolicyGate::Blocked(
        "conflict review is incomplete".to_owned(),
    )]);
    let admission = command.admit();
    let prep = ManagementProjectionCapturePrepRecord::from_admitted_command(
        ManagementProjectionCapturePrepId("capture-prep:blocked".to_owned()),
        &command,
        &admission,
    );

    assert!(!admission.is_accepted());
    assert_eq!(
        prep.share_readiness(),
        ManagementProjectionCaptureShareReadiness::Blocked(
            "capture command has blocking policy gates".to_owned()
        )
    );
}

#[test]
fn management_capture_records_allow_git_and_convergence_mappings_without_core_terms() {
    let git = capture_command(vec![ManagementProjectionCapturePolicyGate::ProjectionApplied]);
    let convergence = ManagementProjectionCaptureCommand {
        repository_id: Some(ScmRepositoryRefId("scm-repo:convergence".to_owned())),
        reason: ManagementProjectionCaptureReason::StewardRecommended,
        ..capture_command(vec![ManagementProjectionCapturePolicyGate::ProjectionApplied])
    };
    let debug = format!("{git:?}{convergence:?}");

    for forbidden in [
        "commit",
        "push",
        "pull request",
        "branch",
        "snap",
        "publication",
        "provider credential",
        "raw_stdout",
        "raw_stderr",
    ] {
        assert!(
            !debug.to_lowercase().contains(forbidden),
            "capture records leaked provider term {forbidden}"
        );
    }
    assert!(git.admit().is_accepted());
    assert!(convergence.admit().is_accepted());
}
