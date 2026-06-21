use super::*;

#[test]
fn git_change_request_diagnostics_count_gate_state() {
    let diagnostics = git_change_request_diagnostics(input(true, true, true));

    assert_eq!(diagnostics.authority_count, 1);
    assert_eq!(diagnostics.authority_ready_count, 1);
    assert_eq!(diagnostics.descriptor_count, 2);
    assert_eq!(diagnostics.descriptor_ready_count, 2);
    assert_eq!(diagnostics.request_count, 2);
    assert_eq!(diagnostics.request_admitted_count, 2);
    assert_eq!(diagnostics.preflight_count, 2);
    assert_eq!(diagnostics.preflight_ready_count, 2);
    assert_eq!(diagnostics.branch_authority_requested_count, 1);
    assert_eq!(diagnostics.commit_authority_requested_count, 1);
    assert_eq!(diagnostics.blocker_count, 0);
}

#[test]
fn git_change_request_diagnostics_grant_no_authority() {
    let diagnostics = git_change_request_diagnostics(input(false, false, false));

    assert!(diagnostics.blocker_count > 0);
    assert!(!diagnostics.command_execution_enabled);
    assert!(!diagnostics.shell_command_created);
    assert!(!diagnostics.forge_request_created);
    assert!(!diagnostics.raw_output_retained);
}

fn input(
    working_tree_available: bool,
    operator_confirmed: bool,
    dry_run_evidence_present: bool,
) -> GitChangeRequestDiagnosticsInput {
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
        crate::GitChangeRequestCommandDescriptorsInput {
            authorities: authorities.clone(),
        },
    );
    let requests = crate::git_change_request_command_request_records(
        crate::GitChangeRequestCommandRequestRecordsInput {
            descriptors: descriptors.clone(),
        },
    );
    let preflights =
        crate::git_change_request_preflight_records(crate::GitChangeRequestPreflightRecordsInput {
            requests: requests.clone(),
            working_tree_available,
            operator_confirmed,
            dry_run_evidence_present,
        });
    GitChangeRequestDiagnosticsInput {
        authorities,
        descriptors,
        requests,
        preflights,
    }
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
