use super::*;

#[test]
fn git_change_request_dry_run_sanitized_outcomes_keep_counts_only() {
    let record = git_change_request_dry_run_sanitized_outcomes(input(
        true,
        true,
        true,
        GitChangeRequestDryRunOutcomeStatus::Completed,
    ));

    assert_eq!(record.outcomes.len(), 2);
    assert!(record.outcomes.iter().all(|outcome| {
        outcome.status == GitChangeRequestDryRunOutcomeStatus::Completed
            && outcome.changed_path_count == 3
            && outcome.insertion_count == 10
            && outcome.deletion_count == 2
            && !outcome.git_mutation_executed
            && !outcome.forge_effect_executed
            && !outcome.raw_output_retained
    }));
    assert!(!record.raw_output_retained);
}

#[test]
fn git_change_request_dry_run_sanitized_outcomes_block_failed_handoffs() {
    let record = git_change_request_dry_run_sanitized_outcomes(input(
        false,
        false,
        false,
        GitChangeRequestDryRunOutcomeStatus::Completed,
    ));

    assert_eq!(record.outcomes.len(), 2);
    assert_eq!(record.skipped_handoff_ids.len(), 2);
    assert!(record.outcomes.iter().all(|outcome| {
        outcome.status == GitChangeRequestDryRunOutcomeStatus::Blocked
            && outcome
                .blockers
                .contains(&GitChangeRequestDryRunOutcomeBlocker::HandoffNotAdmitted)
    }));
}

fn input(
    working_tree_available: bool,
    operator_confirmed: bool,
    dry_run_evidence_present: bool,
    requested_status: GitChangeRequestDryRunOutcomeStatus,
) -> GitChangeRequestDryRunSanitizedOutcomesInput {
    GitChangeRequestDryRunSanitizedOutcomesInput {
        handoffs: crate::git_change_request_dry_run_handoff(
            crate::GitChangeRequestDryRunHandoffInput {
                preflights: preflights(
                    working_tree_available,
                    operator_confirmed,
                    dry_run_evidence_present,
                ),
            },
        ),
        requested_status,
        changed_path_count: 3,
        insertion_count: 10,
        deletion_count: 2,
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
