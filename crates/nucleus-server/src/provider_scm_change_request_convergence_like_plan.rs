//! Convergence-like SCM change-request plan records.

use serde::{Deserialize, Serialize};

use crate::{
    ScmChangeRequestAdapterPlanKind, ScmChangeRequestAdapterPlanRecord,
    ScmChangeRequestAdapterPlanRecordsRecord, ScmChangeRequestAdapterPlanStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmChangeRequestConvergenceLikePlanInput {
    pub adapter_plans: ScmChangeRequestAdapterPlanRecordsRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmChangeRequestConvergenceLikePlanRecord {
    pub plan_set_id: String,
    pub plans: Vec<ScmChangeRequestConvergenceLikePlanItem>,
    pub skipped_adapter_plan_ids: Vec<String>,
    pub snapshot_authority_granted: bool,
    pub publish_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmChangeRequestConvergenceLikePlanItem {
    pub convergence_plan_id: String,
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
    pub planned_snapshot_ref: String,
    pub planned_publish_ref: String,
    pub status: ScmChangeRequestConvergenceLikePlanStatus,
    pub blockers: Vec<ScmChangeRequestConvergenceLikePlanBlocker>,
    pub snapshot_created: bool,
    pub publish_executed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmChangeRequestConvergenceLikePlanStatus {
    Ready,
    Blocked,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmChangeRequestConvergenceLikePlanBlocker {
    AdapterPlanNotReady,
    NotConvergenceLikePlan,
}

pub fn scm_change_request_convergence_like_plan(
    input: ScmChangeRequestConvergenceLikePlanInput,
) -> ScmChangeRequestConvergenceLikePlanRecord {
    let mut plans = input
        .adapter_plans
        .plans
        .into_iter()
        .map(convergence_like_plan_item)
        .collect::<Vec<_>>();
    plans.sort_by(|left, right| left.convergence_plan_id.cmp(&right.convergence_plan_id));

    ScmChangeRequestConvergenceLikePlanRecord {
        plan_set_id: "scm-change-request-convergence-like-plan".to_owned(),
        skipped_adapter_plan_ids: plans
            .iter()
            .filter(|plan| plan.status != ScmChangeRequestConvergenceLikePlanStatus::Ready)
            .map(|plan| plan.adapter_plan_id.clone())
            .collect(),
        plans,
        snapshot_authority_granted: false,
        publish_authority_granted: false,
        provider_authority_granted: false,
        raw_output_retained: false,
    }
}

fn convergence_like_plan_item(
    adapter_plan: ScmChangeRequestAdapterPlanRecord,
) -> ScmChangeRequestConvergenceLikePlanItem {
    let blockers = blockers(&adapter_plan);
    let status = status(&blockers);
    let convergence_plan_id = format!(
        "scm-change-request-convergence-like-plan:{}",
        adapter_plan.adapter_plan_id
    );

    ScmChangeRequestConvergenceLikePlanItem {
        planned_snapshot_ref: format!(
            "convergence-snapshot-plan:{}",
            adapter_plan.persisted_preparation_id
        ),
        planned_publish_ref: format!(
            "convergence-publish-plan:{}",
            adapter_plan.persisted_preparation_id
        ),
        convergence_plan_id,
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
        snapshot_created: false,
        publish_executed: false,
    }
}

fn blockers(
    adapter_plan: &ScmChangeRequestAdapterPlanRecord,
) -> Vec<ScmChangeRequestConvergenceLikePlanBlocker> {
    let mut blockers = Vec::new();
    if adapter_plan.plan_kind != ScmChangeRequestAdapterPlanKind::SnapshotPublishChangeRequest {
        blockers.push(ScmChangeRequestConvergenceLikePlanBlocker::NotConvergenceLikePlan);
    }
    if adapter_plan.status != ScmChangeRequestAdapterPlanStatus::Ready {
        blockers.push(ScmChangeRequestConvergenceLikePlanBlocker::AdapterPlanNotReady);
    }
    blockers
}

fn status(
    blockers: &[ScmChangeRequestConvergenceLikePlanBlocker],
) -> ScmChangeRequestConvergenceLikePlanStatus {
    if blockers.is_empty() {
        ScmChangeRequestConvergenceLikePlanStatus::Ready
    } else if blockers.iter().any(|blocker| {
        blocker == &ScmChangeRequestConvergenceLikePlanBlocker::NotConvergenceLikePlan
    }) {
        ScmChangeRequestConvergenceLikePlanStatus::Unsupported
    } else {
        ScmChangeRequestConvergenceLikePlanStatus::Blocked
    }
}

#[cfg(test)]
mod tests;
