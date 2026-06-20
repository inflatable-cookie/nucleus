//! Adapter-specific SCM change-request plan records.

use serde::{Deserialize, Serialize};

use crate::{ScmChangeRequestPrepPersistenceRecord, ScmChangeRequestPrepPersistenceStatus};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmChangeRequestAdapterPlanRecordsInput {
    pub preparations: Vec<ScmChangeRequestPrepPersistenceRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmChangeRequestAdapterPlanRecordsRecord {
    pub plan_set_id: String,
    pub plans: Vec<ScmChangeRequestAdapterPlanRecord>,
    pub blocked_preparation_ids: Vec<String>,
    pub unsupported_preparation_ids: Vec<String>,
    pub branch_or_snapshot_authority_granted: bool,
    pub commit_or_publish_authority_granted: bool,
    pub push_or_remote_publish_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmChangeRequestAdapterPlanRecord {
    pub adapter_plan_id: String,
    pub persisted_preparation_id: String,
    pub admission_id: String,
    pub decision_id: String,
    pub readiness_id: String,
    pub workflow_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub repo_id: String,
    pub operator_ref: String,
    pub adapter_label: String,
    pub workflow_label: String,
    pub evidence_refs: Vec<String>,
    pub plan_kind: ScmChangeRequestAdapterPlanKind,
    pub status: ScmChangeRequestAdapterPlanStatus,
    pub blockers: Vec<ScmChangeRequestAdapterPlanBlocker>,
    pub branch_or_snapshot_authority_granted: bool,
    pub commit_or_publish_authority_granted: bool,
    pub push_or_remote_publish_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmChangeRequestAdapterPlanKind {
    GitBranchChangeRequest,
    SnapshotPublishChangeRequest,
    UnsupportedAdapter,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmChangeRequestAdapterPlanStatus {
    Ready,
    Blocked,
    Unsupported,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmChangeRequestAdapterPlanBlocker {
    PreparationNotPersisted,
    AdapterLabelMissing,
    WorkflowLabelMissing,
    UnsupportedAdapter,
    BranchOrSnapshotAuthorityAlreadyGranted,
    CommitOrPublishAuthorityAlreadyGranted,
    PushOrRemotePublishAuthorityAlreadyGranted,
    ForgeAuthorityAlreadyGranted,
    ProviderAuthorityAlreadyGranted,
    CallbackAuthorityAlreadyGranted,
    InterruptionAuthorityAlreadyGranted,
    RecoveryAuthorityAlreadyGranted,
    RawOutputRetained,
}

pub fn scm_change_request_adapter_plan_records(
    input: ScmChangeRequestAdapterPlanRecordsInput,
) -> ScmChangeRequestAdapterPlanRecordsRecord {
    let mut plans = input
        .preparations
        .into_iter()
        .map(adapter_plan_record)
        .collect::<Vec<_>>();
    plans.sort_by(|left, right| left.adapter_plan_id.cmp(&right.adapter_plan_id));

    ScmChangeRequestAdapterPlanRecordsRecord {
        plan_set_id: "scm-change-request-adapter-plan-records".to_owned(),
        blocked_preparation_ids: plans
            .iter()
            .filter(|plan| plan.status == ScmChangeRequestAdapterPlanStatus::Blocked)
            .map(|plan| plan.persisted_preparation_id.clone())
            .collect(),
        unsupported_preparation_ids: plans
            .iter()
            .filter(|plan| plan.status == ScmChangeRequestAdapterPlanStatus::Unsupported)
            .map(|plan| plan.persisted_preparation_id.clone())
            .collect(),
        plans,
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

fn adapter_plan_record(
    preparation: ScmChangeRequestPrepPersistenceRecord,
) -> ScmChangeRequestAdapterPlanRecord {
    let plan_kind = plan_kind(&preparation.adapter_label);
    let blockers = blockers(&preparation, &plan_kind);
    let status = status(&blockers);

    ScmChangeRequestAdapterPlanRecord {
        adapter_plan_id: format!(
            "scm-change-request-adapter-plan:{}",
            preparation.persisted_preparation_id
        ),
        persisted_preparation_id: preparation.persisted_preparation_id,
        admission_id: preparation.admission_id,
        decision_id: preparation.decision_id,
        readiness_id: preparation.readiness_id,
        workflow_id: preparation.workflow_id,
        task_id: preparation.task_id,
        work_item_id: preparation.work_item_id,
        completion_id: preparation.completion_id,
        repo_id: preparation.repo_id,
        operator_ref: preparation.operator_ref,
        adapter_label: preparation.adapter_label,
        workflow_label: preparation.workflow_label,
        evidence_refs: unique_sorted(preparation.evidence_refs),
        plan_kind,
        status,
        blockers,
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

fn blockers(
    preparation: &ScmChangeRequestPrepPersistenceRecord,
    plan_kind: &ScmChangeRequestAdapterPlanKind,
) -> Vec<ScmChangeRequestAdapterPlanBlocker> {
    let mut blockers = Vec::new();
    if preparation.status != ScmChangeRequestPrepPersistenceStatus::Persisted {
        blockers.push(ScmChangeRequestAdapterPlanBlocker::PreparationNotPersisted);
    }
    if preparation.adapter_label.trim().is_empty() {
        blockers.push(ScmChangeRequestAdapterPlanBlocker::AdapterLabelMissing);
    }
    if preparation.workflow_label.trim().is_empty() {
        blockers.push(ScmChangeRequestAdapterPlanBlocker::WorkflowLabelMissing);
    }
    if plan_kind == &ScmChangeRequestAdapterPlanKind::UnsupportedAdapter {
        blockers.push(ScmChangeRequestAdapterPlanBlocker::UnsupportedAdapter);
    }
    if preparation.branch_or_snapshot_authority_granted {
        blockers.push(ScmChangeRequestAdapterPlanBlocker::BranchOrSnapshotAuthorityAlreadyGranted);
    }
    if preparation.commit_or_publish_authority_granted {
        blockers.push(ScmChangeRequestAdapterPlanBlocker::CommitOrPublishAuthorityAlreadyGranted);
    }
    if preparation.push_or_remote_publish_authority_granted {
        blockers
            .push(ScmChangeRequestAdapterPlanBlocker::PushOrRemotePublishAuthorityAlreadyGranted);
    }
    if preparation.forge_authority_granted {
        blockers.push(ScmChangeRequestAdapterPlanBlocker::ForgeAuthorityAlreadyGranted);
    }
    if preparation.provider_authority_granted {
        blockers.push(ScmChangeRequestAdapterPlanBlocker::ProviderAuthorityAlreadyGranted);
    }
    if preparation.callback_authority_granted {
        blockers.push(ScmChangeRequestAdapterPlanBlocker::CallbackAuthorityAlreadyGranted);
    }
    if preparation.interruption_authority_granted {
        blockers.push(ScmChangeRequestAdapterPlanBlocker::InterruptionAuthorityAlreadyGranted);
    }
    if preparation.recovery_authority_granted {
        blockers.push(ScmChangeRequestAdapterPlanBlocker::RecoveryAuthorityAlreadyGranted);
    }
    if preparation.raw_output_retained {
        blockers.push(ScmChangeRequestAdapterPlanBlocker::RawOutputRetained);
    }
    blockers
}

fn status(blockers: &[ScmChangeRequestAdapterPlanBlocker]) -> ScmChangeRequestAdapterPlanStatus {
    if blockers.is_empty() {
        ScmChangeRequestAdapterPlanStatus::Ready
    } else if blockers
        .iter()
        .any(|blocker| blocker == &ScmChangeRequestAdapterPlanBlocker::UnsupportedAdapter)
    {
        ScmChangeRequestAdapterPlanStatus::Unsupported
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ScmChangeRequestAdapterPlanBlocker::AdapterLabelMissing
                | ScmChangeRequestAdapterPlanBlocker::WorkflowLabelMissing
        )
    }) {
        ScmChangeRequestAdapterPlanStatus::RepairRequired
    } else {
        ScmChangeRequestAdapterPlanStatus::Blocked
    }
}

fn plan_kind(adapter_label: &str) -> ScmChangeRequestAdapterPlanKind {
    let normalized = adapter_label.trim().to_ascii_lowercase();
    if normalized == "git" || normalized == "adapter:git" {
        ScmChangeRequestAdapterPlanKind::GitBranchChangeRequest
    } else if normalized == "convergence" || normalized == "adapter:convergence" {
        ScmChangeRequestAdapterPlanKind::SnapshotPublishChangeRequest
    } else {
        ScmChangeRequestAdapterPlanKind::UnsupportedAdapter
    }
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests;
