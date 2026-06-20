//! Git-like SCM change-request plan records.

use serde::{Deserialize, Serialize};

use crate::{
    ScmChangeRequestAdapterPlanKind, ScmChangeRequestAdapterPlanRecord,
    ScmChangeRequestAdapterPlanRecordsRecord, ScmChangeRequestAdapterPlanStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmChangeRequestGitLikePlanInput {
    pub adapter_plans: ScmChangeRequestAdapterPlanRecordsRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmChangeRequestGitLikePlanRecord {
    pub plan_set_id: String,
    pub plans: Vec<ScmChangeRequestGitLikePlanItem>,
    pub skipped_adapter_plan_ids: Vec<String>,
    pub branch_authority_granted: bool,
    pub commit_authority_granted: bool,
    pub push_authority_granted: bool,
    pub pull_request_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmChangeRequestGitLikePlanItem {
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
    pub adapter_label: String,
    pub workflow_label: String,
    pub evidence_refs: Vec<String>,
    pub planned_branch_ref: String,
    pub planned_commit_ref: String,
    pub planned_push_ref: String,
    pub planned_pull_request_ref: String,
    pub status: ScmChangeRequestGitLikePlanStatus,
    pub blockers: Vec<ScmChangeRequestGitLikePlanBlocker>,
    pub branch_created: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    pub pull_request_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmChangeRequestGitLikePlanStatus {
    Ready,
    Blocked,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmChangeRequestGitLikePlanBlocker {
    AdapterPlanNotReady,
    NotGitLikePlan,
}

pub fn scm_change_request_git_like_plan(
    input: ScmChangeRequestGitLikePlanInput,
) -> ScmChangeRequestGitLikePlanRecord {
    let mut plans = input
        .adapter_plans
        .plans
        .into_iter()
        .map(git_like_plan_item)
        .collect::<Vec<_>>();
    plans.sort_by(|left, right| left.git_plan_id.cmp(&right.git_plan_id));

    ScmChangeRequestGitLikePlanRecord {
        plan_set_id: "scm-change-request-git-like-plan".to_owned(),
        skipped_adapter_plan_ids: plans
            .iter()
            .filter(|plan| plan.status != ScmChangeRequestGitLikePlanStatus::Ready)
            .map(|plan| plan.adapter_plan_id.clone())
            .collect(),
        plans,
        branch_authority_granted: false,
        commit_authority_granted: false,
        push_authority_granted: false,
        pull_request_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_output_retained: false,
    }
}

fn git_like_plan_item(
    adapter_plan: ScmChangeRequestAdapterPlanRecord,
) -> ScmChangeRequestGitLikePlanItem {
    let blockers = blockers(&adapter_plan);
    let status = status(&blockers);
    let git_plan_id = format!(
        "scm-change-request-git-like-plan:{}",
        adapter_plan.adapter_plan_id
    );

    ScmChangeRequestGitLikePlanItem {
        planned_branch_ref: format!("git-branch-plan:{}", adapter_plan.persisted_preparation_id),
        planned_commit_ref: format!("git-commit-plan:{}", adapter_plan.persisted_preparation_id),
        planned_push_ref: format!("git-push-plan:{}", adapter_plan.persisted_preparation_id),
        planned_pull_request_ref: format!("git-pr-plan:{}", adapter_plan.persisted_preparation_id),
        git_plan_id,
        adapter_plan_id: adapter_plan.adapter_plan_id,
        persisted_preparation_id: adapter_plan.persisted_preparation_id,
        admission_id: adapter_plan.admission_id,
        workflow_id: adapter_plan.workflow_id,
        task_id: adapter_plan.task_id,
        work_item_id: adapter_plan.work_item_id,
        completion_id: adapter_plan.completion_id,
        repo_id: adapter_plan.repo_id,
        operator_ref: adapter_plan.operator_ref,
        adapter_label: adapter_plan.adapter_label,
        workflow_label: adapter_plan.workflow_label,
        evidence_refs: adapter_plan.evidence_refs,
        status,
        blockers,
        branch_created: false,
        commit_created: false,
        push_executed: false,
        pull_request_created: false,
    }
}

fn blockers(
    adapter_plan: &ScmChangeRequestAdapterPlanRecord,
) -> Vec<ScmChangeRequestGitLikePlanBlocker> {
    let mut blockers = Vec::new();
    if adapter_plan.plan_kind != ScmChangeRequestAdapterPlanKind::GitBranchChangeRequest {
        blockers.push(ScmChangeRequestGitLikePlanBlocker::NotGitLikePlan);
    }
    if adapter_plan.status != ScmChangeRequestAdapterPlanStatus::Ready {
        blockers.push(ScmChangeRequestGitLikePlanBlocker::AdapterPlanNotReady);
    }
    blockers
}

fn status(blockers: &[ScmChangeRequestGitLikePlanBlocker]) -> ScmChangeRequestGitLikePlanStatus {
    if blockers.is_empty() {
        ScmChangeRequestGitLikePlanStatus::Ready
    } else if blockers
        .iter()
        .any(|blocker| blocker == &ScmChangeRequestGitLikePlanBlocker::NotGitLikePlan)
    {
        ScmChangeRequestGitLikePlanStatus::Unsupported
    } else {
        ScmChangeRequestGitLikePlanStatus::Blocked
    }
}

#[cfg(test)]
mod tests;
