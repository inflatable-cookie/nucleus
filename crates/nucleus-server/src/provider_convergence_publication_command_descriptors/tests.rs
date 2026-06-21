use super::*;

#[test]
fn convergence_publication_command_descriptors_build_provider_refs_from_ready_preflight() {
    let set = convergence_publication_command_descriptors(input("convergence", true));

    assert_eq!(set.descriptors.len(), 1);
    assert_eq!(
        set.descriptors[0].status,
        ConvergencePublicationCommandDescriptorStatus::Ready
    );
    assert!(set.descriptors[0].snapshot_descriptor_ref.is_some());
    assert!(set.descriptors[0].publish_descriptor_ref.is_some());
    assert!(set.descriptors[0]
        .publication_review_descriptor_ref
        .is_some());
    assert!(!set.descriptors[0].executable_argv_built);
}

#[test]
fn convergence_publication_command_descriptors_skip_blocked_preflight() {
    let set = convergence_publication_command_descriptors(input("git", true));

    assert_eq!(
        set.descriptors[0].status,
        ConvergencePublicationCommandDescriptorStatus::Blocked
    );
    assert!(set.descriptors[0]
        .blockers
        .contains(&ConvergencePublicationCommandDescriptorBlocker::PreflightNotReady));
    assert_eq!(set.skipped_preflight_ids.len(), 1);
}

#[test]
fn convergence_publication_command_descriptors_execute_no_effects() {
    let set = convergence_publication_command_descriptors(input("convergence", true));

    assert!(!set.executable_argv_built);
    assert!(!set.snapshot_creation_permitted);
    assert!(!set.publish_permitted);
    assert!(!set.publication_review_permitted);
    assert!(!set.provider_write_permitted);
    assert!(!set.task_mutation_permitted);
    assert!(!set.raw_output_retained);
}

fn input(adapter_label: &str, ready_flags: bool) -> ConvergencePublicationCommandDescriptorsInput {
    ConvergencePublicationCommandDescriptorsInput {
        preflights: crate::convergence_publication_preflight(
            crate::ConvergencePublicationPreflightInput {
                admissions: crate::convergence_publication_admission(
                    crate::ConvergencePublicationAdmissionInput {
                        persisted_chains: crate::adapter_neutral_change_request_chain_persistence(
                            crate::AdapterNeutralChangeRequestChainPersistenceInput {
                                projections: vec![
                                    crate::adapter_neutral_change_request_chain_projection(
                                        crate::AdapterNeutralChangeRequestChainInput {
                                            adapter_plans:
                                                crate::scm_change_request_adapter_plan_records(
                                                    crate::ScmChangeRequestAdapterPlanRecordsInput {
                                                        preparations: vec![preparation(
                                                            adapter_label,
                                                        )],
                                                    },
                                                ),
                                        },
                                    ),
                                ],
                                existing_projection_ids: Vec::new(),
                                raw_material_present: false,
                                scm_execution_requested: false,
                                forge_execution_requested: false,
                                provider_write_requested: false,
                                task_mutation_requested: false,
                                callback_response_requested: false,
                                interruption_requested: false,
                                recovery_requested: false,
                            },
                        ),
                    },
                ),
                operator_confirmed: ready_flags,
                destination_ready: ready_flags,
                publication_review_ready: ready_flags,
            },
        ),
    }
}

fn preparation(adapter_label: &str) -> crate::ScmChangeRequestPrepPersistenceRecord {
    crate::ScmChangeRequestPrepPersistenceRecord {
        persisted_preparation_id: "prep:1".to_owned(),
        admission_id: "admission:1".to_owned(),
        decision_id: "decision:1".to_owned(),
        readiness_id: "readiness:1".to_owned(),
        workflow_id: "workflow:1".to_owned(),
        task_id: "task:1".to_owned(),
        work_item_id: Some("work:1".to_owned()),
        completion_id: Some("completion:1".to_owned()),
        repo_id: "repo:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        adapter_label: adapter_label.to_owned(),
        workflow_label: "change-request".to_owned(),
        evidence_refs: vec!["evidence:1".to_owned()],
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
