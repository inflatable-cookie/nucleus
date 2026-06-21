use super::*;

#[test]
fn convergence_publication_runner_proof_records_ready_persisted_requests() {
    let set = convergence_publication_runner_proof(input("convergence", false, false));

    assert_eq!(set.proofs.len(), 1);
    assert_eq!(
        set.proofs[0].status,
        ConvergencePublicationRunnerProofStatus::Ready
    );
    assert!(set.proofs[0]
        .idempotency_key
        .starts_with("convergence-publication:"));
    assert_eq!(set.proofs[0].publish_stage_refs.len(), 1);
    assert!(!set.proofs[0].runner_invoked);
}

#[test]
fn convergence_publication_runner_proof_blocks_duplicate_and_blocked_persistence() {
    let duplicate = convergence_publication_runner_proof(input("convergence", true, false));
    let blocked = convergence_publication_runner_proof(input("git", false, false));

    assert!(duplicate.proofs[0]
        .blockers
        .contains(&ConvergencePublicationRunnerProofBlocker::RequestPersistenceNotReady));
    assert!(duplicate.proofs[0]
        .blockers
        .contains(&ConvergencePublicationRunnerProofBlocker::DuplicateRequest));
    assert!(blocked.proofs[0]
        .blockers
        .contains(&ConvergencePublicationRunnerProofBlocker::RequestPersistenceNotReady));
}

#[test]
fn convergence_publication_runner_proof_executes_no_effects() {
    let set = convergence_publication_runner_proof(input("convergence", false, false));

    assert!(!set.runner_invoked);
    assert!(!set.provider_handoff_created);
    assert!(!set.snapshot_creation_executed);
    assert!(!set.publish_executed);
    assert!(!set.publication_review_executed);
    assert!(!set.provider_write_executed);
    assert!(!set.task_mutation_executed);
    assert!(!set.raw_output_retained);
}

fn input(
    adapter_label: &str,
    duplicate: bool,
    request_effects: bool,
) -> ConvergencePublicationRunnerProofInput {
    let persistence = crate::convergence_publication_request_persistence(
        request_persistence_input(adapter_label, Vec::new(), request_effects),
    );
    let duplicate_keys = duplicate
        .then_some(persistence.records[0].idempotency_key.clone())
        .into_iter()
        .collect();
    ConvergencePublicationRunnerProofInput {
        persisted_requests: crate::convergence_publication_request_persistence(
            request_persistence_input(adapter_label, duplicate_keys, request_effects),
        ),
    }
}

fn request_persistence_input(
    adapter_label: &str,
    existing_idempotency_keys: Vec<String>,
    request_effects: bool,
) -> crate::ConvergencePublicationRequestPersistenceInput {
    crate::ConvergencePublicationRequestPersistenceInput {
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
