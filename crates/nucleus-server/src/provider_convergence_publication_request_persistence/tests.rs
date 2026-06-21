use super::*;

#[test]
fn convergence_publication_request_persistence_preserves_request_refs() {
    let set = convergence_publication_request_persistence(input("convergence", Vec::new(), false));

    assert_eq!(set.records.len(), 1);
    assert_eq!(
        set.records[0].status,
        ConvergencePublicationRequestPersistenceStatus::Persisted
    );
    assert!(set.records[0]
        .persisted_request_id
        .starts_with("convergence-publication-request:"));
    assert_eq!(set.records[0].snapshot_stage_refs.len(), 1);
    assert_eq!(set.records[0].publish_stage_refs.len(), 1);
    assert_eq!(set.records[0].publication_review_stage_refs.len(), 1);
}

#[test]
fn convergence_publication_request_persistence_records_duplicate_noops() {
    let first =
        convergence_publication_request_persistence(input("convergence", Vec::new(), false));
    let key = first.records[0].idempotency_key.clone();
    let duplicate =
        convergence_publication_request_persistence(input("convergence", vec![key.clone()], false));

    assert_eq!(duplicate.duplicate_idempotency_keys, vec![key]);
    assert_eq!(
        duplicate.records[0].status,
        ConvergencePublicationRequestPersistenceStatus::DuplicateNoop
    );
    assert!(duplicate.records[0].duplicate_idempotency_detected);
}

#[test]
fn convergence_publication_request_persistence_keeps_blocked_requests_visible() {
    let set = convergence_publication_request_persistence(input("git", Vec::new(), false));

    assert_eq!(
        set.records[0].status,
        ConvergencePublicationRequestPersistenceStatus::Blocked
    );
    assert!(set.records[0]
        .blockers
        .contains(&ConvergencePublicationRequestPersistenceBlocker::RequestNotStopped));
    assert_eq!(set.blocked_request_ids.len(), 1);
}

#[test]
fn convergence_publication_request_persistence_blocks_effect_requests() {
    let set = convergence_publication_request_persistence(input("convergence", Vec::new(), true));

    assert_eq!(
        set.records[0].status,
        ConvergencePublicationRequestPersistenceStatus::Blocked
    );
    assert!(set.records[0]
        .blockers
        .contains(&ConvergencePublicationRequestPersistenceBlocker::ProviderHandoffRequested));
    assert!(set.records[0]
        .blockers
        .contains(&ConvergencePublicationRequestPersistenceBlocker::PublishRequested));
    assert!(!set.provider_handoff_permitted);
    assert!(!set.snapshot_creation_permitted);
    assert!(!set.publish_permitted);
    assert!(!set.publication_review_permitted);
    assert!(!set.provider_write_permitted);
    assert!(!set.task_mutation_permitted);
    assert!(!set.raw_material_retained);
}

fn input(
    adapter_label: &str,
    existing_idempotency_keys: Vec<String>,
    request_effects: bool,
) -> ConvergencePublicationRequestPersistenceInput {
    ConvergencePublicationRequestPersistenceInput {
        requests: crate::convergence_publication_stopped_requests(
            crate::ConvergencePublicationStoppedRequestsInput {
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
                                operator_confirmed: true,
                                destination_ready: true,
                                publication_review_ready: true,
                            },
                        ),
                    },
                ),
            },
        ),
        existing_idempotency_keys,
        raw_material_present: request_effects,
        provider_handoff_requested: request_effects,
        snapshot_creation_requested: request_effects,
        publish_requested: request_effects,
        publication_review_requested: request_effects,
        provider_write_requested: request_effects,
        task_mutation_requested: request_effects,
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
