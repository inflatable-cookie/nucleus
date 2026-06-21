use super::*;

#[test]
fn convergence_publication_diagnostics_summarize_ready_lane() {
    let admissions = crate::convergence_publication_admission(admission_input("convergence"));
    let preflights =
        crate::convergence_publication_preflight(crate::ConvergencePublicationPreflightInput {
            admissions: admissions.clone(),
            operator_confirmed: true,
            destination_ready: true,
            publication_review_ready: true,
        });
    let diagnostics = convergence_publication_diagnostics(admissions, preflights);

    assert_eq!(diagnostics.admission_count, 1);
    assert_eq!(diagnostics.admitted_count, 1);
    assert_eq!(diagnostics.ready_preflight_count, 1);
    assert_eq!(diagnostics.admission_blocker_count, 0);
    assert_eq!(diagnostics.preflight_blocker_count, 0);
}

#[test]
fn convergence_publication_diagnostics_summarize_blocked_lane() {
    let admissions = crate::convergence_publication_admission(admission_input("git"));
    let preflights =
        crate::convergence_publication_preflight(crate::ConvergencePublicationPreflightInput {
            admissions: admissions.clone(),
            operator_confirmed: false,
            destination_ready: false,
            publication_review_ready: false,
        });
    let diagnostics = convergence_publication_diagnostics(admissions, preflights);

    assert_eq!(diagnostics.admission_count, 1);
    assert_eq!(diagnostics.blocked_admission_count, 1);
    assert_eq!(diagnostics.blocked_preflight_count, 1);
    assert!(diagnostics.admission_blocker_count >= 1);
    assert!(diagnostics.preflight_blocker_count >= 1);
    assert!(!diagnostics.publish_permitted);
    assert!(!diagnostics.provider_write_permitted);
    assert!(!diagnostics.raw_output_retained);
}

fn admission_input(adapter_label: &str) -> crate::ConvergencePublicationAdmissionInput {
    crate::ConvergencePublicationAdmissionInput {
        persisted_chains: crate::adapter_neutral_change_request_chain_persistence(
            crate::AdapterNeutralChangeRequestChainPersistenceInput {
                projections: vec![crate::adapter_neutral_change_request_chain_projection(
                    crate::AdapterNeutralChangeRequestChainInput {
                        adapter_plans: crate::scm_change_request_adapter_plan_records(
                            crate::ScmChangeRequestAdapterPlanRecordsInput {
                                preparations: vec![preparation(adapter_label)],
                            },
                        ),
                    },
                )],
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
