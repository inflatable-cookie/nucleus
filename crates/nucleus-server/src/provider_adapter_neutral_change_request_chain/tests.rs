use super::*;

#[test]
fn adapter_neutral_chain_keeps_git_terms_in_provider_refs() {
    let projection = adapter_neutral_change_request_chain_projection(input(vec!["git"]));

    assert_eq!(projection.stages.len(), 4);
    assert_eq!(
        projection
            .stages
            .iter()
            .map(|stage| &stage.neutral_stage)
            .collect::<Vec<_>>(),
        vec![
            &AdapterNeutralChangeRequestStageKind::IsolatedWorkArea,
            &AdapterNeutralChangeRequestStageKind::LocalRevision,
            &AdapterNeutralChangeRequestStageKind::RemoteShare,
            &AdapterNeutralChangeRequestStageKind::ReviewRequest,
        ]
    );
    assert!(projection.stages.iter().all(|stage| matches!(
        stage.provider_ref,
        AdapterNeutralChangeRequestProviderStageRef::GitLike { .. }
    )));
    assert!(projection.stages.iter().any(|stage| matches!(
        stage.provider_ref,
        AdapterNeutralChangeRequestProviderStageRef::GitLike {
            stage_kind: GitLikeChangeRequestProviderStageKind::Commit,
            ..
        }
    )));
}

#[test]
fn adapter_neutral_chain_represents_convergence_publication_first_class() {
    let projection = adapter_neutral_change_request_chain_projection(input(vec!["convergence"]));

    assert_eq!(projection.stages.len(), 3);
    assert!(projection.stages.iter().any(|stage| matches!(
        stage.provider_ref,
        AdapterNeutralChangeRequestProviderStageRef::ConvergenceLike {
            stage_kind: ConvergenceLikeChangeRequestProviderStageKind::Publish,
            ..
        }
    )));
    assert!(projection.stages.iter().any(|stage| matches!(
        stage.provider_ref,
        AdapterNeutralChangeRequestProviderStageRef::ConvergenceLike {
            stage_kind: ConvergenceLikeChangeRequestProviderStageKind::PublicationReview,
            ..
        }
    )));
    assert!(projection.stages.iter().all(|stage| {
        stage.status == AdapterNeutralChangeRequestChainStageStatus::Ready
            && !stage.effect_executed
            && !stage.provider_effect_executed
            && !stage.task_mutation_executed
            && !stage.raw_output_retained
    }));
}

#[test]
fn adapter_neutral_chain_keeps_unsupported_adapter_visible() {
    let projection = adapter_neutral_change_request_chain_projection(input(vec!["fossil"]));

    assert_eq!(projection.stages.len(), 1);
    assert_eq!(
        projection.stages[0].neutral_stage,
        AdapterNeutralChangeRequestStageKind::Unsupported
    );
    assert_eq!(
        projection.stages[0].status,
        AdapterNeutralChangeRequestChainStageStatus::Unsupported
    );
    assert_eq!(
        projection.skipped_adapter_plan_ids,
        vec!["scm-change-request-adapter-plan:prep:1"]
    );
    assert!(matches!(
        projection.stages[0].provider_ref,
        AdapterNeutralChangeRequestProviderStageRef::Unsupported { .. }
    ));
}

#[test]
fn adapter_neutral_chain_executes_no_effects() {
    let projection =
        adapter_neutral_change_request_chain_projection(input(vec!["git", "convergence"]));

    assert!(!projection.branch_or_snapshot_authority_granted);
    assert!(!projection.local_revision_authority_granted);
    assert!(!projection.remote_share_authority_granted);
    assert!(!projection.review_request_authority_granted);
    assert!(!projection.provider_authority_granted);
    assert!(!projection.callback_authority_granted);
    assert!(!projection.interruption_authority_granted);
    assert!(!projection.recovery_authority_granted);
    assert!(!projection.task_mutation_executed);
    assert!(!projection.raw_output_retained);
    assert!(projection.stages.iter().all(|stage| {
        !stage.effect_executed
            && !stage.provider_effect_executed
            && !stage.task_mutation_executed
            && !stage.raw_output_retained
    }));
}

fn input(adapter_labels: Vec<&str>) -> AdapterNeutralChangeRequestChainInput {
    let preparations = adapter_labels
        .into_iter()
        .enumerate()
        .map(|(index, adapter_label)| preparation(index + 1, adapter_label))
        .collect();
    AdapterNeutralChangeRequestChainInput {
        adapter_plans: crate::scm_change_request_adapter_plan_records(
            crate::ScmChangeRequestAdapterPlanRecordsInput { preparations },
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
