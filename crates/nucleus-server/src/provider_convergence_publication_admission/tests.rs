use super::*;

#[test]
fn convergence_publication_admission_admits_persisted_convergence_chain() {
    let set = convergence_publication_admission(input(vec!["convergence"], false, false));

    assert_eq!(set.admissions.len(), 1);
    assert_eq!(
        set.admissions[0].status,
        ConvergencePublicationAdmissionStatus::Admitted
    );
    assert_eq!(set.admissions[0].snapshot_stage_refs.len(), 1);
    assert_eq!(set.admissions[0].publish_stage_refs.len(), 1);
    assert_eq!(set.admissions[0].publication_review_stage_refs.len(), 1);
    assert!(!set.admissions[0].snapshot_creation_permitted);
    assert!(!set.admissions[0].publish_permitted);
    assert!(!set.admissions[0].publication_review_permitted);
}

#[test]
fn convergence_publication_admission_blocks_git_like_chains() {
    let set = convergence_publication_admission(input(vec!["git"], false, false));

    assert_eq!(
        set.admissions[0].status,
        ConvergencePublicationAdmissionStatus::Blocked
    );
    assert!(set.admissions[0]
        .blockers
        .contains(&ConvergencePublicationAdmissionBlocker::GitLikeStagePresent));
    assert!(set.admissions[0]
        .blockers
        .contains(&ConvergencePublicationAdmissionBlocker::MissingSnapshotStage));
    assert_eq!(set.skipped_persisted_projection_ids.len(), 1);
}

#[test]
fn convergence_publication_admission_blocks_duplicate_and_blocked_persistence() {
    let duplicate = convergence_publication_admission(input(vec!["convergence"], true, false));
    let blocked = convergence_publication_admission(input(vec!["convergence"], false, true));

    assert!(duplicate.admissions[0]
        .blockers
        .contains(&ConvergencePublicationAdmissionBlocker::PersistenceNotReady));
    assert!(duplicate.admissions[0]
        .blockers
        .contains(&ConvergencePublicationAdmissionBlocker::DuplicateProjection));
    assert!(blocked.admissions[0]
        .blockers
        .contains(&ConvergencePublicationAdmissionBlocker::PersistenceNotReady));
}

#[test]
fn convergence_publication_admission_executes_no_effects() {
    let set = convergence_publication_admission(input(vec!["convergence"], false, false));

    assert!(!set.snapshot_creation_permitted);
    assert!(!set.publish_permitted);
    assert!(!set.publication_review_permitted);
    assert!(!set.provider_write_permitted);
    assert!(!set.task_mutation_permitted);
    assert!(!set.callback_response_permitted);
    assert!(!set.interruption_permitted);
    assert!(!set.recovery_permitted);
    assert!(!set.raw_output_retained);
}

fn input(
    adapter_labels: Vec<&str>,
    duplicate: bool,
    blocked: bool,
) -> ConvergencePublicationAdmissionInput {
    let projection = crate::adapter_neutral_change_request_chain_projection(
        crate::AdapterNeutralChangeRequestChainInput {
            adapter_plans: crate::scm_change_request_adapter_plan_records(
                crate::ScmChangeRequestAdapterPlanRecordsInput {
                    preparations: adapter_labels
                        .into_iter()
                        .enumerate()
                        .map(|(index, adapter_label)| preparation(index + 1, adapter_label))
                        .collect(),
                },
            ),
        },
    );
    let duplicate_id = duplicate.then_some(format!(
        "adapter-neutral-change-request-chain-persistence:{}",
        projection.projection_id
    ));
    ConvergencePublicationAdmissionInput {
        persisted_chains: crate::adapter_neutral_change_request_chain_persistence(
            crate::AdapterNeutralChangeRequestChainPersistenceInput {
                projections: vec![projection],
                existing_projection_ids: duplicate_id.into_iter().collect(),
                raw_material_present: blocked,
                scm_execution_requested: blocked,
                forge_execution_requested: blocked,
                provider_write_requested: blocked,
                task_mutation_requested: blocked,
                callback_response_requested: blocked,
                interruption_requested: blocked,
                recovery_requested: blocked,
            },
        ),
    }
}

fn preparation(index: usize, adapter_label: &str) -> crate::ScmChangeRequestPrepPersistenceRecord {
    crate::ScmChangeRequestPrepPersistenceRecord {
        persisted_preparation_id: format!("prep:{index}"),
        admission_id: format!("admission:{index}"),
        decision_id: format!("decision:{index}"),
        readiness_id: format!("readiness:{index}"),
        workflow_id: format!("workflow:{index}"),
        task_id: format!("task:{index}"),
        work_item_id: Some(format!("work:{index}")),
        completion_id: Some(format!("completion:{index}")),
        repo_id: format!("repo:{index}"),
        operator_ref: "operator:tom".to_owned(),
        adapter_label: adapter_label.to_owned(),
        workflow_label: "change-request".to_owned(),
        evidence_refs: vec![format!("evidence:{index}")],
        admission_status: crate::ScmChangeRequestPrepAdmissionStatus::Admitted,
        admission_blockers: Vec::new(),
        status: crate::ScmChangeRequestPrepPersistenceStatus::Persisted,
        blockers: Vec::new(),
        duplicate_preparation_detected: false,
        branch_or_snapshot_authority_granted: false,
        commit_or_publish_authority_granted: false,
        push_or_remote_publish_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        raw_output_retained: false,
    }
}
