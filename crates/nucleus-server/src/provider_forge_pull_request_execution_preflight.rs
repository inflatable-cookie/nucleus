//! Preflight records for forge pull-request execution admissions.

use serde::{Deserialize, Serialize};

use crate::{
    ForgePullRequestExecutionAdmissionRecord, ForgePullRequestExecutionAdmissionSet,
    ForgePullRequestExecutionAdmissionStatus, ForgePullRequestProvider, ForgePullRequestTextSource,
    GitPushRemoteTarget,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgePullRequestExecutionPreflightInput {
    pub admissions: ForgePullRequestExecutionAdmissionSet,
    pub forge_credential_ready: bool,
    pub remote_branch_visible: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgePullRequestExecutionPreflightSet {
    pub preflight_set_id: String,
    pub preflights: Vec<ForgePullRequestExecutionPreflightRecord>,
    pub skipped_admission_ids: Vec<String>,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgePullRequestExecutionPreflightRecord {
    pub preflight_id: String,
    pub admission_id: String,
    pub pr_evidence_id: String,
    pub pr_descriptor_id: String,
    pub push_preflight_id: String,
    pub request_id: String,
    pub authority_id: String,
    pub git_plan_id: String,
    pub task_id: String,
    pub repo_id: String,
    pub operator_ref: String,
    pub remote_target: Option<GitPushRemoteTarget>,
    pub forge_provider: Option<ForgePullRequestProvider>,
    pub base_branch: Option<String>,
    pub head_branch: Option<String>,
    pub title_source: Option<ForgePullRequestTextSource>,
    pub body_source: Option<ForgePullRequestTextSource>,
    pub status: ForgePullRequestExecutionPreflightStatus,
    pub blockers: Vec<ForgePullRequestExecutionPreflightBlocker>,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgePullRequestExecutionPreflightStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgePullRequestExecutionPreflightBlocker {
    AdmissionNotAdmitted,
    ForgeCredentialNotReady,
    RemoteBranchNotVisible,
}

pub fn forge_pull_request_execution_preflight(
    input: ForgePullRequestExecutionPreflightInput,
) -> ForgePullRequestExecutionPreflightSet {
    let checks = ForgePullRequestExecutionPreflightChecks {
        forge_credential_ready: input.forge_credential_ready,
        remote_branch_visible: input.remote_branch_visible,
    };
    let mut preflights = input
        .admissions
        .admissions
        .into_iter()
        .map(|admission| preflight_record(&checks, admission))
        .collect::<Vec<_>>();
    preflights.sort_by(|left, right| left.preflight_id.cmp(&right.preflight_id));

    ForgePullRequestExecutionPreflightSet {
        preflight_set_id: "forge-pull-request-execution-preflight".to_owned(),
        skipped_admission_ids: preflights
            .iter()
            .filter(|preflight| preflight.status != ForgePullRequestExecutionPreflightStatus::Ready)
            .map(|preflight| preflight.admission_id.clone())
            .collect(),
        preflights,
        pull_request_created: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        raw_output_retained: false,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ForgePullRequestExecutionPreflightChecks {
    forge_credential_ready: bool,
    remote_branch_visible: bool,
}

fn preflight_record(
    checks: &ForgePullRequestExecutionPreflightChecks,
    admission: ForgePullRequestExecutionAdmissionRecord,
) -> ForgePullRequestExecutionPreflightRecord {
    let blockers = blockers(checks, &admission);
    let status = if blockers.is_empty() {
        ForgePullRequestExecutionPreflightStatus::Ready
    } else {
        ForgePullRequestExecutionPreflightStatus::Blocked
    };

    ForgePullRequestExecutionPreflightRecord {
        preflight_id: format!(
            "forge-pull-request-execution-preflight:{}",
            admission.admission_id
        ),
        admission_id: admission.admission_id,
        pr_evidence_id: admission.pr_evidence_id,
        pr_descriptor_id: admission.pr_descriptor_id,
        push_preflight_id: admission.push_preflight_id,
        request_id: admission.request_id,
        authority_id: admission.authority_id,
        git_plan_id: admission.git_plan_id,
        task_id: admission.task_id,
        repo_id: admission.repo_id,
        operator_ref: admission.operator_ref,
        remote_target: admission.remote_target,
        forge_provider: admission.forge_provider,
        base_branch: admission.base_branch,
        head_branch: admission.head_branch,
        title_source: admission.title_source,
        body_source: admission.body_source,
        status,
        blockers,
        pull_request_created: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        raw_output_retained: false,
    }
}

fn blockers(
    checks: &ForgePullRequestExecutionPreflightChecks,
    admission: &ForgePullRequestExecutionAdmissionRecord,
) -> Vec<ForgePullRequestExecutionPreflightBlocker> {
    let mut blockers = Vec::new();
    if admission.status != ForgePullRequestExecutionAdmissionStatus::Admitted {
        blockers.push(ForgePullRequestExecutionPreflightBlocker::AdmissionNotAdmitted);
    }
    if !checks.forge_credential_ready {
        blockers.push(ForgePullRequestExecutionPreflightBlocker::ForgeCredentialNotReady);
    }
    if !checks.remote_branch_visible {
        blockers.push(ForgePullRequestExecutionPreflightBlocker::RemoteBranchNotVisible);
    }
    blockers
}

#[cfg(test)]
mod tests;
