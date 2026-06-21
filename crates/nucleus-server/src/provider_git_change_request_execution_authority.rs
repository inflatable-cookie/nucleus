//! Git change-request execution authority records.

use serde::{Deserialize, Serialize};

use crate::{
    ScmChangeRequestGitLikePlanItem, ScmChangeRequestGitLikePlanRecord,
    ScmChangeRequestGitLikePlanStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitChangeRequestExecutionAuthorityInput {
    pub git_plans: ScmChangeRequestGitLikePlanRecord,
    pub branch_authority_requested: bool,
    pub commit_authority_requested: bool,
    pub push_authority_requested: bool,
    pub pull_request_authority_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitChangeRequestExecutionAuthoritySet {
    pub authority_set_id: String,
    pub authorities: Vec<GitChangeRequestExecutionAuthorityRecord>,
    pub skipped_git_plan_ids: Vec<String>,
    pub branch_authority_granted: bool,
    pub commit_authority_granted: bool,
    pub push_authority_granted: bool,
    pub pull_request_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitChangeRequestExecutionAuthorityRecord {
    pub authority_id: String,
    pub git_plan_id: String,
    pub adapter_plan_id: String,
    pub persisted_preparation_id: String,
    pub admission_id: String,
    pub workflow_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub repo_id: String,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub branch_authority_requested: bool,
    pub commit_authority_requested: bool,
    pub push_authority_requested: bool,
    pub pull_request_authority_requested: bool,
    pub status: GitChangeRequestExecutionAuthorityStatus,
    pub blockers: Vec<GitChangeRequestExecutionAuthorityBlocker>,
    pub branch_authority_granted: bool,
    pub commit_authority_granted: bool,
    pub push_authority_granted: bool,
    pub pull_request_authority_granted: bool,
    pub branch_created: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    pub pull_request_created: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeRequestExecutionAuthorityStatus {
    Ready,
    Blocked,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeRequestExecutionAuthorityBlocker {
    GitPlanNotReady,
    NoAuthorityRequested,
    MissingEvidenceRef,
}

pub fn git_change_request_execution_authority(
    input: GitChangeRequestExecutionAuthorityInput,
) -> GitChangeRequestExecutionAuthoritySet {
    let requested_authority = GitChangeRequestRequestedAuthority {
        branch_authority_requested: input.branch_authority_requested,
        commit_authority_requested: input.commit_authority_requested,
        push_authority_requested: input.push_authority_requested,
        pull_request_authority_requested: input.pull_request_authority_requested,
    };
    let mut authorities = input
        .git_plans
        .plans
        .into_iter()
        .map(|plan| authority_record(&requested_authority, plan))
        .collect::<Vec<_>>();
    authorities.sort_by(|left, right| left.authority_id.cmp(&right.authority_id));

    GitChangeRequestExecutionAuthoritySet {
        authority_set_id: "git-change-request-execution-authority".to_owned(),
        skipped_git_plan_ids: authorities
            .iter()
            .filter(|authority| authority.status != GitChangeRequestExecutionAuthorityStatus::Ready)
            .map(|authority| authority.git_plan_id.clone())
            .collect(),
        authorities,
        branch_authority_granted: false,
        commit_authority_granted: false,
        push_authority_granted: false,
        pull_request_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        raw_output_retained: false,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GitChangeRequestRequestedAuthority {
    branch_authority_requested: bool,
    commit_authority_requested: bool,
    push_authority_requested: bool,
    pull_request_authority_requested: bool,
}

fn authority_record(
    requested_authority: &GitChangeRequestRequestedAuthority,
    plan: ScmChangeRequestGitLikePlanItem,
) -> GitChangeRequestExecutionAuthorityRecord {
    let blockers = blockers(requested_authority, &plan);
    let status = status(&blockers);

    GitChangeRequestExecutionAuthorityRecord {
        authority_id: format!(
            "git-change-request-execution-authority:{}",
            plan.git_plan_id
        ),
        git_plan_id: plan.git_plan_id,
        adapter_plan_id: plan.adapter_plan_id,
        persisted_preparation_id: plan.persisted_preparation_id,
        admission_id: plan.admission_id,
        workflow_id: plan.workflow_id,
        task_id: plan.task_id,
        work_item_id: plan.work_item_id,
        completion_id: plan.completion_id,
        repo_id: plan.repo_id,
        operator_ref: plan.operator_ref,
        evidence_refs: plan.evidence_refs,
        branch_authority_requested: requested_authority.branch_authority_requested,
        commit_authority_requested: requested_authority.commit_authority_requested,
        push_authority_requested: requested_authority.push_authority_requested,
        pull_request_authority_requested: requested_authority.pull_request_authority_requested,
        status,
        blockers,
        branch_authority_granted: false,
        commit_authority_granted: false,
        push_authority_granted: false,
        pull_request_authority_granted: false,
        branch_created: false,
        commit_created: false,
        push_executed: false,
        pull_request_created: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        raw_output_retained: false,
    }
}

fn blockers(
    requested_authority: &GitChangeRequestRequestedAuthority,
    plan: &ScmChangeRequestGitLikePlanItem,
) -> Vec<GitChangeRequestExecutionAuthorityBlocker> {
    let mut blockers = Vec::new();
    if plan.status != ScmChangeRequestGitLikePlanStatus::Ready {
        blockers.push(GitChangeRequestExecutionAuthorityBlocker::GitPlanNotReady);
    }
    if !requested_authority.branch_authority_requested
        && !requested_authority.commit_authority_requested
        && !requested_authority.push_authority_requested
        && !requested_authority.pull_request_authority_requested
    {
        blockers.push(GitChangeRequestExecutionAuthorityBlocker::NoAuthorityRequested);
    }
    if plan.evidence_refs.is_empty() {
        blockers.push(GitChangeRequestExecutionAuthorityBlocker::MissingEvidenceRef);
    }
    blockers
}

fn status(
    blockers: &[GitChangeRequestExecutionAuthorityBlocker],
) -> GitChangeRequestExecutionAuthorityStatus {
    if blockers.is_empty() {
        GitChangeRequestExecutionAuthorityStatus::Ready
    } else if blockers
        .iter()
        .any(|blocker| blocker == &GitChangeRequestExecutionAuthorityBlocker::MissingEvidenceRef)
    {
        GitChangeRequestExecutionAuthorityStatus::RepairRequired
    } else {
        GitChangeRequestExecutionAuthorityStatus::Blocked
    }
}

#[cfg(test)]
mod tests;
