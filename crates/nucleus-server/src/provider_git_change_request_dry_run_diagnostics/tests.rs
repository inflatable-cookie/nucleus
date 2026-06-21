use super::*;

#[test]
fn git_change_request_dry_run_diagnostics_count_runner_records() {
    let diagnostics = git_change_request_dry_run_diagnostics(input(true));

    assert_eq!(diagnostics.handoff_count, 2);
    assert_eq!(diagnostics.handoff_admitted_count, 2);
    assert_eq!(diagnostics.outcome_count, 2);
    assert_eq!(diagnostics.outcome_completed_count, 2);
    assert_eq!(diagnostics.evidence_count, 2);
    assert_eq!(diagnostics.evidence_reviewable_count, 2);
    assert_eq!(diagnostics.changed_path_count, 6);
    assert_eq!(diagnostics.insertion_count, 20);
    assert_eq!(diagnostics.deletion_count, 4);
    assert_eq!(diagnostics.blocker_count, 0);
}

#[test]
fn git_change_request_dry_run_diagnostics_grant_no_authority() {
    let diagnostics = git_change_request_dry_run_diagnostics(input(false));

    assert!(diagnostics.blocker_count > 0);
    assert!(!diagnostics.shell_execution_performed);
    assert!(!diagnostics.git_mutation_executed);
    assert!(!diagnostics.forge_effect_executed);
    assert!(!diagnostics.raw_output_retained);
}

fn input(ready: bool) -> GitChangeRequestDryRunDiagnosticsInput {
    let preflights = preflights(ready, ready, ready);
    let handoffs =
        crate::git_change_request_dry_run_handoff(crate::GitChangeRequestDryRunHandoffInput {
            preflights,
        });
    let outcomes = crate::git_change_request_dry_run_sanitized_outcomes(
        crate::GitChangeRequestDryRunSanitizedOutcomesInput {
            handoffs: handoffs.clone(),
            requested_status: crate::GitChangeRequestDryRunOutcomeStatus::Completed,
            changed_path_count: 3,
            insertion_count: 10,
            deletion_count: 2,
        },
    );
    let evidence =
        crate::git_change_request_dry_run_evidence(crate::GitChangeRequestDryRunEvidenceInput {
            outcomes: outcomes.clone(),
        });
    GitChangeRequestDryRunDiagnosticsInput {
        handoffs,
        outcomes,
        evidence,
    }
}

fn preflights(
    working_tree_available: bool,
    operator_confirmed: bool,
    dry_run_evidence_present: bool,
) -> crate::GitChangeRequestPreflightSet {
    let adapter_plans = crate::scm_change_request_adapter_plan_records(
        crate::ScmChangeRequestAdapterPlanRecordsInput {
            preparations: vec![preparation()],
        },
    );
    let git_plans =
        crate::scm_change_request_git_like_plan(crate::ScmChangeRequestGitLikePlanInput {
            adapter_plans,
        });
    let authorities = crate::git_change_request_execution_authority(
        crate::GitChangeRequestExecutionAuthorityInput {
            git_plans,
            branch_authority_requested: true,
            commit_authority_requested: true,
            push_authority_requested: false,
            pull_request_authority_requested: false,
        },
    );
    let descriptors = crate::git_change_request_command_descriptors(
        crate::GitChangeRequestCommandDescriptorsInput { authorities },
    );
    let requests = crate::git_change_request_command_request_records(
        crate::GitChangeRequestCommandRequestRecordsInput { descriptors },
    );
    crate::git_change_request_preflight_records(crate::GitChangeRequestPreflightRecordsInput {
        requests,
        working_tree_available,
        operator_confirmed,
        dry_run_evidence_present,
    })
}

fn preparation() -> crate::ScmChangeRequestPrepPersistenceRecord {
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
        adapter_label: "git".to_owned(),
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
