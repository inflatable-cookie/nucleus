use super::*;

#[test]
fn git_capture_plan_maps_neutral_capture_without_execution() {
    let command = capture_command(vec![
        ManagementProjectionCapturePolicyGate::ProjectionApplied,
    ]);
    let admission = command.admit();
    let plan = GitManagementCapturePlan::from_capture_admission(
        GitManagementCapturePlanId("git-capture-plan:1".to_owned()),
        &command,
        &admission,
    );

    assert_eq!(
        plan.status,
        GitManagementCapturePlanStatus::NeedsDryRunEvidence
    );
    assert_eq!(plan.descriptor.local_capture_label, "commit");
    assert_eq!(plan.descriptor.share_label, "push_or_review_request");
    assert!(!plan.mutates_git());
    assert_eq!(plan.candidate_file_refs.len(), 2);
}

#[test]
fn git_capture_plan_blocks_missing_capture_admission_or_repo_ref() {
    let mut missing_repo = capture_command(Vec::new());
    missing_repo.repository_id = None;
    let missing_repo_plan = GitManagementCapturePlan::from_capture_admission(
        GitManagementCapturePlanId("git-capture-plan:missing-repo".to_owned()),
        &missing_repo,
        &missing_repo.admit(),
    );

    assert!(matches!(
        missing_repo_plan.status,
        GitManagementCapturePlanStatus::Blocked(_)
    ));

    let mut missing_evidence = capture_command(Vec::new());
    missing_evidence.evidence.apply_receipt_ids.clear();
    let blocked_admission = missing_evidence.admit();
    let blocked_plan = GitManagementCapturePlan::from_capture_admission(
        GitManagementCapturePlanId("git-capture-plan:blocked".to_owned()),
        &missing_evidence,
        &blocked_admission,
    );

    assert!(matches!(
        blocked_plan.status,
        GitManagementCapturePlanStatus::Blocked(_)
    ));
}

#[test]
fn git_capture_dry_run_envelope_admits_only_read_only_checks() {
    let command = capture_command(Vec::new());
    let plan = GitManagementCapturePlan::from_capture_admission(
        GitManagementCapturePlanId("git-capture-plan:1".to_owned()),
        &command,
        &command.admit(),
    );
    let accepted = GitCaptureDryRunEnvelope::from_plan(
        GitCaptureDryRunEnvelopeId("git-capture-dry-run:1".to_owned()),
        &plan,
        vec![
            GitCaptureDryRunCheck::StatusPorcelainV2,
            GitCaptureDryRunCheck::DiffNameOnly,
            GitCaptureDryRunCheck::DiffStat,
        ],
    )
    .admit();
    let blocked = GitCaptureDryRunEnvelope::from_plan(
        GitCaptureDryRunEnvelopeId("git-capture-dry-run:blocked".to_owned()),
        &plan,
        vec![GitCaptureDryRunCheck::MutatingProviderCommand(
            "git commit".to_owned(),
        )],
    )
    .admit();

    assert_eq!(accepted.status, GitCaptureDryRunAdmissionStatus::Accepted);
    assert!(!accepted.provider_mutation_allowed);
    assert!(matches!(
        blocked.status,
        GitCaptureDryRunAdmissionStatus::Blocked(_)
    ));
    assert!(!blocked.provider_mutation_allowed);
}

#[test]
fn git_capture_status_and_diff_evidence_makes_plan_review_ready() {
    let command = capture_command(Vec::new());
    let plan = GitManagementCapturePlan::from_capture_admission(
        GitManagementCapturePlanId("git-capture-plan:1".to_owned()),
        &command,
        &command.admit(),
    );
    let inspection = GitStatusSnapshot {
        repository_id: ScmRepositoryRefId("scm-repo:nucleus".to_owned()),
        worktree_id: None,
        branch_name: Some("main".to_owned()),
        head_oid: Some("abc123".to_owned()),
        detached_head: false,
        upstream_name: Some("origin/main".to_owned()),
        entries: vec![GitStatusEntry {
            path: "nucleus/tasks/task:1.toml".to_owned(),
            original_path: None,
            kind: GitStatusEntryKind::Modified,
        }],
    }
    .into_working_copy_inspection();
    let evidence = GitManagementCaptureEvidence {
        status_evidence_refs: vec![EngineRuntimeReceiptRef::CommandEvidenceId(
            "evidence:git-status".to_owned(),
        )],
        diff_summary_refs: vec![EngineRuntimeReceiptRef::Artifact(
            "artifact:git-diff-summary".to_owned(),
        )],
        inspection: Some(inspection),
        blocked_reasons: Vec::new(),
    };
    let ready = plan.with_evidence(evidence);

    assert_eq!(ready.status, GitManagementCapturePlanStatus::ReadyForReview);
    assert!(!ready.mutates_git());
}
