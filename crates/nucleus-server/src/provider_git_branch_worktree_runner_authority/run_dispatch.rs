//! Run-dispatch handoff lane: the admitted execution handoff chain one run
//! dispatch drives through the branch/worktree runner authority.
//!
//! One dispatch = one isolated-worktree target. The lane composes the
//! generic change-request record chain (preparation -> adapter plans ->
//! git-like plan -> execution authority -> descriptors -> requests ->
//! preflights -> dry-run handoff/outcomes/evidence) with run-scoped
//! identities, then feeds that evidence through the branch/worktree lane
//! (admission -> descriptors -> preflights -> execution handoff) and trims
//! the set to the single isolated-worktree handoff the run confirms. The
//! runner authority stays stopped-by-default: the durable operator effect
//! intent plus approved target refs are required before anything spawns.

use crate::{
    git_branch_worktree_admission_records, git_branch_worktree_command_descriptors,
    git_branch_worktree_execution_handoff, git_branch_worktree_preflight_records,
    git_change_request_command_descriptors, git_change_request_command_request_records,
    git_change_request_dry_run_evidence, git_change_request_dry_run_handoff,
    git_change_request_dry_run_sanitized_outcomes, git_change_request_execution_authority,
    git_change_request_preflight_records, scm_change_request_adapter_plan_records,
    scm_change_request_git_like_plan, GitBranchWorktreeExecutionHandoffSet,
    GitBranchWorktreeExecutionHandoffStatus, GitBranchWorktreeMode,
    GitBranchWorktreePreflightInput, GitBranchWorktreeRunnerTargetRef,
    GitChangeRequestDryRunOutcomeStatus, GitChangeRequestDryRunSanitizedOutcomesInput,
    ScmChangeRequestPrepPersistenceRecord, ScmChangeRequestPrepPersistenceStatus,
};

/// One run dispatch's handoff lane identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunDispatchLaneInput {
    /// Run id (`run:<slug>`); scopes every chain record id.
    pub run_id: String,
    /// Operator identity confirming the dispatch.
    pub operator_ref: String,
}

/// The admitted isolated-worktree handoff lane for one dispatch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunDispatchLane {
    /// Handoff set trimmed to the single isolated-worktree handoff.
    pub handoffs: GitBranchWorktreeExecutionHandoffSet,
    /// The confirmed handoff id (drives the target ref and the durable
    /// operator effect intent record).
    pub handoff_id: String,
}

/// Build the run-dispatch handoff lane.
pub fn run_dispatch_handoff_lane(input: RunDispatchLaneInput) -> RunDispatchLane {
    let preparation = preparation(&input);
    let adapter_plans = scm_change_request_adapter_plan_records(
        crate::ScmChangeRequestAdapterPlanRecordsInput {
            preparations: vec![preparation],
        },
    );
    let git_plans =
        scm_change_request_git_like_plan(crate::ScmChangeRequestGitLikePlanInput { adapter_plans });
    let authorities = git_change_request_execution_authority(
        crate::GitChangeRequestExecutionAuthorityInput {
            git_plans,
            branch_authority_requested: true,
            commit_authority_requested: false,
            push_authority_requested: false,
            pull_request_authority_requested: false,
        },
    );
    let descriptors =
        git_change_request_command_descriptors(crate::GitChangeRequestCommandDescriptorsInput {
            authorities,
        });
    let requests = git_change_request_command_request_records(
        crate::GitChangeRequestCommandRequestRecordsInput { descriptors },
    );
    let preflights = git_change_request_preflight_records(
        crate::GitChangeRequestPreflightRecordsInput {
            requests,
            working_tree_available: true,
            operator_confirmed: true,
            dry_run_evidence_present: true,
        },
    );
    let handoffs =
        git_change_request_dry_run_handoff(crate::GitChangeRequestDryRunHandoffInput { preflights });
    let outcomes = git_change_request_dry_run_sanitized_outcomes(
        GitChangeRequestDryRunSanitizedOutcomesInput {
            handoffs,
            requested_status: GitChangeRequestDryRunOutcomeStatus::Completed,
            changed_path_count: 0,
            insertion_count: 0,
            deletion_count: 0,
        },
    );
    let evidence =
        git_change_request_dry_run_evidence(crate::GitChangeRequestDryRunEvidenceInput { outcomes });

    let admissions = git_branch_worktree_admission_records(
        crate::GitBranchWorktreeAdmissionInput {
            evidence,
            worktree_mode: GitBranchWorktreeMode::IsolatedWorktree,
        },
    );
    let descriptors = git_branch_worktree_command_descriptors(
        crate::GitBranchWorktreeCommandDescriptorsInput { admissions },
    );
    let preflights = git_branch_worktree_preflight_records(GitBranchWorktreePreflightInput {
        descriptors,
        operator_confirmed: true,
        working_tree_clean: true,
        isolated_target_available: true,
    });
    let mut handoffs = git_branch_worktree_execution_handoff(
        crate::GitBranchWorktreeExecutionHandoffInput { preflights },
    );

    // One dispatch = one isolated-worktree target: keep only the admitted
    // handoff and trim the generic chain's extra branch/commit-prep records.
    handoffs.handoffs.retain(|handoff| {
        handoff.worktree_mode == GitBranchWorktreeMode::IsolatedWorktree
            && handoff.status == GitBranchWorktreeExecutionHandoffStatus::Admitted
    });
    let handoff_id = handoffs
        .handoffs
        .first()
        .map(|handoff| handoff.handoff_id.clone())
        .unwrap_or_else(|| format!("git-branch-worktree-execution-handoff:run:{}", input.run_id));

    RunDispatchLane { handoffs, handoff_id }
}

/// Build the target refs for the lane's single handoff.
pub fn run_dispatch_target_refs(
    lane: &RunDispatchLane,
    branch_ref: &str,
    worktree_location_ref: &str,
) -> Vec<GitBranchWorktreeRunnerTargetRef> {
    vec![GitBranchWorktreeRunnerTargetRef {
        handoff_id: lane.handoff_id.clone(),
        branch_ref: Some(branch_ref.to_owned()),
        worktree_location_ref: Some(worktree_location_ref.to_owned()),
    }]
}

fn preparation(input: &RunDispatchLaneInput) -> ScmChangeRequestPrepPersistenceRecord {
    ScmChangeRequestPrepPersistenceRecord {
        persisted_preparation_id: format!("prep:run:{}", input.run_id),
        admission_id: format!("admission:run:{}", input.run_id),
        decision_id: format!("decision:run:{}", input.run_id),
        readiness_id: format!("readiness:run:{}", input.run_id),
        workflow_id: format!("workflow:run:{}", input.run_id),
        task_id: format!("task:run:{}", input.run_id),
        work_item_id: Some(format!("work:run:{}", input.run_id)),
        completion_id: Some(format!("completion:run:{}", input.run_id)),
        repo_id: format!("repo:run:{}", input.run_id),
        operator_ref: input.operator_ref.clone(),
        adapter_label: "git".to_owned(),
        workflow_label: "change-request".to_owned(),
        evidence_refs: vec![format!("evidence:run:{}", input.run_id)],
        admission_status: crate::ScmChangeRequestPrepAdmissionStatus::Admitted,
        admission_blockers: Vec::new(),
        status: ScmChangeRequestPrepPersistenceStatus::Persisted,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_dispatch_lane_yields_one_admitted_isolated_worktree_handoff() {
        let lane = run_dispatch_handoff_lane(RunDispatchLaneInput {
            run_id: "run:fixture".to_owned(),
            operator_ref: "operator:tom".to_owned(),
        });
        assert_eq!(lane.handoffs.handoffs.len(), 1);
        assert_eq!(
            lane.handoffs.handoffs[0].worktree_mode,
            GitBranchWorktreeMode::IsolatedWorktree
        );
        assert_eq!(
            lane.handoffs.handoffs[0].status,
            GitBranchWorktreeExecutionHandoffStatus::Admitted
        );
        assert_eq!(lane.handoff_id, lane.handoffs.handoffs[0].handoff_id);
        assert!(lane.handoff_id.contains("run:fixture"));
    }

    #[test]
    fn run_dispatch_target_refs_match_the_lane_handoff() {
        let lane = run_dispatch_handoff_lane(RunDispatchLaneInput {
            run_id: "run:fixture".to_owned(),
            operator_ref: "operator:tom".to_owned(),
        });
        let refs = run_dispatch_target_refs(&lane, "run/fixture", "../nucleus-wt/fixture");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].handoff_id, lane.handoff_id);
        assert_eq!(refs[0].branch_ref.as_deref(), Some("run/fixture"));
        assert_eq!(
            refs[0].worktree_location_ref.as_deref(),
            Some("../nucleus-wt/fixture")
        );
    }
}
