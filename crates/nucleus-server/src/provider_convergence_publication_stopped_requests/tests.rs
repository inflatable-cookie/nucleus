use super::*;

#[test]
fn convergence_publication_stopped_requests_preserve_refs_and_idempotency() {
    let set = convergence_publication_stopped_requests(input("convergence"));

    assert_eq!(set.requests.len(), 1);
    assert_eq!(
        set.requests[0].status,
        ConvergencePublicationStoppedRequestStatus::Stopped
    );
    assert!(set.requests[0]
        .idempotency_key
        .starts_with("convergence-publication:"));
    assert_eq!(set.requests[0].snapshot_stage_refs.len(), 1);
    assert_eq!(set.requests[0].publish_stage_refs.len(), 1);
    assert_eq!(set.requests[0].publication_review_stage_refs.len(), 1);
}

#[test]
fn convergence_publication_stopped_requests_block_non_ready_descriptors() {
    let set = convergence_publication_stopped_requests(input("git"));

    assert_eq!(
        set.requests[0].status,
        ConvergencePublicationStoppedRequestStatus::Blocked
    );
    assert!(set.requests[0]
        .blockers
        .contains(&ConvergencePublicationStoppedRequestBlocker::DescriptorNotReady));
    assert_eq!(set.skipped_descriptor_ids.len(), 1);
}

#[test]
fn convergence_publication_stopped_requests_execute_no_effects() {
    let set = convergence_publication_stopped_requests(input("convergence"));

    assert!(!set.provider_handoff_created);
    assert!(!set.snapshot_creation_executed);
    assert!(!set.publish_executed);
    assert!(!set.publication_review_executed);
    assert!(!set.provider_write_executed);
    assert!(!set.task_mutation_executed);
    assert!(!set.raw_output_retained);
}

fn input(adapter_label: &str) -> ConvergencePublicationStoppedRequestsInput {
    ConvergencePublicationStoppedRequestsInput {
        descriptors: crate::convergence_publication_command_descriptors(
            crate::ConvergencePublicationCommandDescriptorsInput {
                preflights: crate::convergence_publication_preflight(
                    crate::ConvergencePublicationPreflightInput {
                        admissions: crate::convergence_publication_admission(
                            crate::ConvergencePublicationAdmissionInput {
                                persisted_chains:
                                    crate::adapter_neutral_change_request_chain_persistence(
                                        crate::AdapterNeutralChangeRequestChainPersistenceInput {
                                            projections: vec![
                                                crate::adapter_neutral_change_request_chain_projection(
                                                    crate::AdapterNeutralChangeRequestChainInput {
                                                        adapter_plans:
                                                            crate::scm_change_request_adapter_plan_records(
                                                                crate::ScmChangeRequestAdapterPlanRecordsInput {
                                                                    preparations: vec![
                                                                        preparation(adapter_label),
                                                                    ],
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
                        operator_confirmed: true,
                        destination_ready: true,
                        publication_review_ready: true,
                    },
                ),
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
