use super::*;

#[test]
fn adapter_neutral_chain_diagnostics_count_stage_families() {
    let diagnostics =
        adapter_neutral_change_request_chain_diagnostics(projection(vec!["git", "convergence"]));

    assert_eq!(diagnostics.stage_count, 7);
    assert_eq!(diagnostics.ready_count, 7);
    assert_eq!(diagnostics.isolated_work_area_count, 1);
    assert_eq!(diagnostics.local_revision_count, 2);
    assert_eq!(diagnostics.remote_share_count, 2);
    assert_eq!(diagnostics.review_request_count, 2);
    assert_eq!(diagnostics.unsupported_stage_count, 0);
}

#[test]
fn adapter_neutral_chain_diagnostics_count_provider_refs() {
    let diagnostics = adapter_neutral_change_request_chain_diagnostics(projection(vec![
        "git",
        "convergence",
        "unsupported",
    ]));

    assert_eq!(diagnostics.git_like_provider_ref_count, 4);
    assert_eq!(diagnostics.convergence_like_provider_ref_count, 3);
    assert_eq!(diagnostics.unsupported_provider_ref_count, 1);
    assert_eq!(diagnostics.unsupported_count, 1);
    assert_eq!(diagnostics.blocker_count, 2);
}

#[test]
fn adapter_neutral_chain_diagnostics_grant_no_authority() {
    let diagnostics = adapter_neutral_change_request_chain_diagnostics(projection(vec!["git"]));

    assert!(!diagnostics.branch_or_snapshot_authority_granted);
    assert!(!diagnostics.local_revision_authority_granted);
    assert!(!diagnostics.remote_share_authority_granted);
    assert!(!diagnostics.review_request_authority_granted);
    assert!(!diagnostics.provider_authority_granted);
    assert!(!diagnostics.callback_authority_granted);
    assert!(!diagnostics.interruption_authority_granted);
    assert!(!diagnostics.recovery_authority_granted);
    assert!(!diagnostics.task_mutation_executed);
    assert!(!diagnostics.raw_output_retained);
}

fn projection(adapter_labels: Vec<&str>) -> crate::AdapterNeutralChangeRequestChainProjection {
    crate::adapter_neutral_change_request_chain_projection(
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
    )
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
