use super::*;

#[test]
fn adapter_neutral_chain_persistence_preserves_stage_and_provider_refs() {
    let set = adapter_neutral_change_request_chain_persistence(input(
        vec!["git", "convergence"],
        Vec::new(),
        false,
    ));

    assert_eq!(set.records.len(), 1);
    assert_eq!(set.records[0].stage_count, 7);
    assert_eq!(set.records[0].ready_stage_count, 7);
    assert!(set.records[0].stages.iter().any(|stage| matches!(
        stage.provider_ref,
        crate::AdapterNeutralChangeRequestProviderStageRef::GitLike { .. }
    )));
    assert!(set.records[0].stages.iter().any(|stage| matches!(
        stage.provider_ref,
        crate::AdapterNeutralChangeRequestProviderStageRef::ConvergenceLike { .. }
    )));
}

#[test]
fn adapter_neutral_chain_persistence_records_duplicate_noops() {
    let projection_id = "adapter-neutral-change-request-chain";
    let persisted_id = format!("adapter-neutral-change-request-chain-persistence:{projection_id}");
    let set = adapter_neutral_change_request_chain_persistence(input(
        vec!["git"],
        vec![persisted_id.clone()],
        false,
    ));

    assert_eq!(set.duplicate_projection_ids, vec![persisted_id]);
    assert_eq!(
        set.records[0].status,
        AdapterNeutralChangeRequestChainPersistenceStatus::DuplicateNoop
    );
    assert!(set.records[0].duplicate_projection_detected);
}

#[test]
fn adapter_neutral_chain_persistence_keeps_unsupported_stages_inspectable() {
    let set = adapter_neutral_change_request_chain_persistence(input(
        vec!["unsupported"],
        Vec::new(),
        false,
    ));

    assert_eq!(set.records[0].unsupported_stage_count, 1);
    assert_eq!(
        set.records[0].status,
        AdapterNeutralChangeRequestChainPersistenceStatus::Persisted
    );
    assert_eq!(
        set.records[0].stages[0].status,
        crate::AdapterNeutralChangeRequestChainStageStatus::Unsupported
    );
}

#[test]
fn adapter_neutral_chain_persistence_blocks_effect_requests() {
    let set =
        adapter_neutral_change_request_chain_persistence(input(vec!["git"], Vec::new(), true));

    assert_eq!(
        set.records[0].status,
        AdapterNeutralChangeRequestChainPersistenceStatus::Blocked
    );
    assert!(set.records[0]
        .blockers
        .contains(&AdapterNeutralChangeRequestChainPersistenceBlocker::RawMaterialPresent));
    assert!(set.records[0]
        .blockers
        .contains(&AdapterNeutralChangeRequestChainPersistenceBlocker::ScmExecutionRequested));
    assert!(!set.scm_execution_permitted);
    assert!(!set.forge_execution_permitted);
    assert!(!set.provider_write_permitted);
    assert!(!set.task_mutation_permitted);
    assert!(!set.callback_response_permitted);
    assert!(!set.interruption_permitted);
    assert!(!set.recovery_permitted);
    assert!(!set.raw_material_retained);
}

fn input(
    adapter_labels: Vec<&str>,
    existing_projection_ids: Vec<String>,
    request_effects: bool,
) -> AdapterNeutralChangeRequestChainPersistenceInput {
    AdapterNeutralChangeRequestChainPersistenceInput {
        projections: vec![crate::adapter_neutral_change_request_chain_projection(
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
        )],
        existing_projection_ids,
        raw_material_present: request_effects,
        scm_execution_requested: request_effects,
        forge_execution_requested: request_effects,
        provider_write_requested: request_effects,
        task_mutation_requested: request_effects,
        callback_response_requested: request_effects,
        interruption_requested: request_effects,
        recovery_requested: request_effects,
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
