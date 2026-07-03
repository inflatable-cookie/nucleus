use super::*;

#[test]
fn planning_capture_publication_admits_stopped_request_without_publication_effects() {
    let set = planning_capture_publication_admission(input(
        target(
            PlanningCapturePublicationAdapterFamily::SnapshotPublicationLike,
            PlanningCapturePublicationOperation::Publish,
        ),
        vec![preparation("1")],
    ));

    assert_eq!(set.admissions.len(), 1);
    assert_eq!(
        set.admissions[0].status,
        PlanningCapturePublicationAdmissionStatus::Admitted
    );
    assert!(set.admissions[0].stopped_request_admitted);
    assert_eq!(set.stopped_request_admitted_count, 1);
    assert!(!set.commit_permitted);
    assert!(!set.snapshot_permitted);
    assert!(!set.publish_permitted);
    assert!(!set.push_permitted);
    assert!(!set.forge_share_permitted);
    assert!(!set.projection_import_permitted);
    assert!(!set.task_promotion_permitted);
}

#[test]
fn planning_capture_publication_keeps_git_terms_as_adapter_specific_target() {
    let set = planning_capture_publication_admission(input(
        target(
            PlanningCapturePublicationAdapterFamily::GitLike,
            PlanningCapturePublicationOperation::Commit,
        ),
        vec![preparation("git")],
    ));

    assert_eq!(
        set.admissions[0].adapter_family,
        PlanningCapturePublicationAdapterFamily::GitLike
    );
    assert_eq!(
        set.admissions[0].operation,
        PlanningCapturePublicationOperation::Commit
    );
    assert!(set.admissions[0].stopped_request_admitted);
    assert!(!set.admissions[0].commit_permitted);
}

#[test]
fn planning_capture_publication_blocks_unready_or_unsafe_inputs() {
    let mut blocked = preparation("blocked");
    blocked.plan_status = CompletionScmCapturePlanStatus::Unsupported;
    blocked.evidence_refs.clear();
    let mut input = input(
        PlanningCapturePublicationTarget {
            adapter_supported: false,
            management_file_refs: vec![
                "../secret".to_owned(),
                "nucleus/tasks/task-1.toml".to_owned(),
            ],
            ..target(
                PlanningCapturePublicationAdapterFamily::Manual,
                PlanningCapturePublicationOperation::ManualShare,
            )
        },
        vec![blocked],
    );
    input.approval_ref = None;
    input.raw_payload_present = true;
    input.scm_or_snapshot_mutation_requested = true;
    input.projection_import_requested = true;

    let set = planning_capture_publication_admission(input);

    assert_eq!(
        set.admissions[0].status,
        PlanningCapturePublicationAdmissionStatus::Blocked
    );
    assert!(set.admissions[0]
        .blockers
        .contains(&PlanningCapturePublicationAdmissionBlocker::PreparationPlanNotReady));
    assert!(set.admissions[0]
        .blockers
        .contains(&PlanningCapturePublicationAdmissionBlocker::MissingEvidenceRef));
    assert!(set.admissions[0]
        .blockers
        .contains(&PlanningCapturePublicationAdmissionBlocker::MissingApprovalRef));
    assert!(set.admissions[0]
        .blockers
        .contains(&PlanningCapturePublicationAdmissionBlocker::AdapterUnsupported));
    assert!(set.admissions[0]
        .blockers
        .contains(&PlanningCapturePublicationAdmissionBlocker::UnsafeManagementFileRef));
    assert!(set.admissions[0]
        .blockers
        .contains(&PlanningCapturePublicationAdmissionBlocker::NonPlanningManagementFileRef));
    assert!(set.admissions[0]
        .blockers
        .contains(&PlanningCapturePublicationAdmissionBlocker::RawPayloadPresent));
    assert!(set.admissions[0]
        .blockers
        .contains(&PlanningCapturePublicationAdmissionBlocker::ScmOrSnapshotMutationRequested));
    assert!(set.admissions[0]
        .blockers
        .contains(&PlanningCapturePublicationAdmissionBlocker::ProjectionImportRequested));
    assert!(!set.admissions[0].stopped_request_admitted);
}

#[test]
fn planning_capture_publication_duplicate_is_noop() {
    let mut input = input(
        target(
            PlanningCapturePublicationAdapterFamily::SnapshotPublicationLike,
            PlanningCapturePublicationOperation::Snapshot,
        ),
        vec![preparation("1")],
    );
    input
        .existing_admission_ids
        .push("planning-capture-publication-admission:snapshot:persisted:1".to_owned());

    let set = planning_capture_publication_admission(input);

    assert_eq!(
        set.admissions[0].status,
        PlanningCapturePublicationAdmissionStatus::DuplicateNoop
    );
    assert!(set.admissions[0].duplicate_admission_detected);
    assert!(!set.admissions[0].stopped_request_admitted);
}

fn input(
    target: PlanningCapturePublicationTarget,
    preparations: Vec<CompletionScmCapturePreparationPersistenceRecord>,
) -> PlanningCapturePublicationAdmissionInput {
    PlanningCapturePublicationAdmissionInput {
        preparations,
        target,
        approval_ref: Some("approval:operator-reviewed".to_owned()),
        existing_admission_ids: Vec::new(),
        raw_payload_present: false,
        scm_or_snapshot_mutation_requested: false,
        remote_share_requested: false,
        forge_mutation_requested: false,
        provider_write_requested: false,
        projection_import_requested: false,
        task_promotion_requested: false,
        callback_response_requested: false,
        interruption_requested: false,
        recovery_requested: false,
    }
}

fn target(
    adapter_family: PlanningCapturePublicationAdapterFamily,
    operation: PlanningCapturePublicationOperation,
) -> PlanningCapturePublicationTarget {
    PlanningCapturePublicationTarget {
        adapter_family,
        operation,
        adapter_label: "adapter".to_owned(),
        workflow_label: "planning-management-capture".to_owned(),
        management_file_refs: vec![
            "nucleus/planning/artifact-1.toml".to_owned(),
            "nucleus/planning/task-seeds/seed-1.toml".to_owned(),
        ],
        adapter_supported: true,
    }
}

fn preparation(id: &str) -> CompletionScmCapturePreparationPersistenceRecord {
    CompletionScmCapturePreparationPersistenceRecord {
        persisted_preparation_id: format!("persisted:{id}"),
        plan_item_id: format!("plan:{id}"),
        preparation_candidate_id: format!("prep:{id}"),
        admission_id: "admission:1".to_owned(),
        readiness_id: "readiness:1".to_owned(),
        capture_candidate_id: "candidate:1".to_owned(),
        task_id: "task:1".to_owned(),
        work_item_id: Some("work:1".to_owned()),
        completion_id: Some("completion:1".to_owned()),
        operator_ref: "operator:tom".to_owned(),
        evidence_refs: vec!["evidence:planning-write".to_owned()],
        adapter_label: "adapter".to_owned(),
        workflow_label: "planning-management-capture".to_owned(),
        plan_status: CompletionScmCapturePlanStatus::Ready,
        plan_blockers: Vec::new(),
        status: CompletionScmCapturePreparationPersistenceStatus::Persisted,
        blockers: Vec::new(),
        duplicate_preparation_detected: false,
        scm_capture_permitted: false,
        scm_publish_permitted: false,
        forge_change_request_permitted: false,
        forge_merge_permitted: false,
        provider_write_permitted: false,
        callback_response_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        raw_material_retained: false,
    }
}
