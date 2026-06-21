//! Stopped-by-default execution admissions for forge pull-request creation.

use serde::{Deserialize, Serialize};

use crate::{
    ForgePullRequestDryRunEvidenceRecord, ForgePullRequestDryRunEvidenceSet,
    ForgePullRequestDryRunEvidenceStatus, ForgePullRequestProvider, ForgePullRequestTextSource,
    GitPushRemoteTarget,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgePullRequestExecutionAdmissionInput {
    pub evidence: ForgePullRequestDryRunEvidenceSet,
    pub operator_approved: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgePullRequestExecutionAdmissionSet {
    pub admission_set_id: String,
    pub admissions: Vec<ForgePullRequestExecutionAdmissionRecord>,
    pub skipped_evidence_ids: Vec<String>,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgePullRequestExecutionAdmissionRecord {
    pub admission_id: String,
    pub pr_evidence_id: String,
    pub pr_descriptor_id: String,
    pub push_preflight_id: String,
    pub push_descriptor_id: String,
    pub push_admission_id: String,
    pub commit_preflight_id: String,
    pub commit_descriptor_id: String,
    pub commit_admission_id: String,
    pub branch_worktree_evidence_id: String,
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
    pub operator_approved: bool,
    pub status: ForgePullRequestExecutionAdmissionStatus,
    pub blockers: Vec<ForgePullRequestExecutionAdmissionBlocker>,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgePullRequestExecutionAdmissionStatus {
    Admitted,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgePullRequestExecutionAdmissionBlocker {
    EvidenceNotReviewable,
    OperatorApprovalMissing,
}

pub fn forge_pull_request_execution_admission(
    input: ForgePullRequestExecutionAdmissionInput,
) -> ForgePullRequestExecutionAdmissionSet {
    let mut admissions = input
        .evidence
        .evidence
        .into_iter()
        .map(|evidence| admission_record(input.operator_approved, evidence))
        .collect::<Vec<_>>();
    admissions.sort_by(|left, right| left.admission_id.cmp(&right.admission_id));

    ForgePullRequestExecutionAdmissionSet {
        admission_set_id: "forge-pull-request-execution-admission".to_owned(),
        skipped_evidence_ids: admissions
            .iter()
            .filter(|admission| {
                admission.status != ForgePullRequestExecutionAdmissionStatus::Admitted
            })
            .map(|admission| admission.pr_evidence_id.clone())
            .collect(),
        admissions,
        pull_request_created: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}

fn admission_record(
    operator_approved: bool,
    evidence: ForgePullRequestDryRunEvidenceRecord,
) -> ForgePullRequestExecutionAdmissionRecord {
    let blockers = blockers(operator_approved, &evidence);
    let status = if blockers.is_empty() {
        ForgePullRequestExecutionAdmissionStatus::Admitted
    } else {
        ForgePullRequestExecutionAdmissionStatus::Blocked
    };

    ForgePullRequestExecutionAdmissionRecord {
        admission_id: format!(
            "forge-pull-request-execution-admission:{}",
            evidence.evidence_id
        ),
        pr_evidence_id: evidence.evidence_id,
        pr_descriptor_id: evidence.descriptor_id,
        push_preflight_id: evidence.push_preflight_id,
        push_descriptor_id: evidence.push_descriptor_id,
        push_admission_id: evidence.push_admission_id,
        commit_preflight_id: evidence.commit_preflight_id,
        commit_descriptor_id: evidence.commit_descriptor_id,
        commit_admission_id: evidence.commit_admission_id,
        branch_worktree_evidence_id: evidence.branch_worktree_evidence_id,
        request_id: evidence.request_id,
        authority_id: evidence.authority_id,
        git_plan_id: evidence.git_plan_id,
        task_id: evidence.task_id,
        repo_id: evidence.repo_id,
        operator_ref: evidence.operator_ref,
        remote_target: evidence.remote_target,
        forge_provider: evidence.forge_provider,
        base_branch: evidence.base_branch,
        head_branch: evidence.head_branch,
        title_source: evidence.title_source,
        body_source: evidence.body_source,
        operator_approved,
        status,
        blockers,
        pull_request_created: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}

fn blockers(
    operator_approved: bool,
    evidence: &ForgePullRequestDryRunEvidenceRecord,
) -> Vec<ForgePullRequestExecutionAdmissionBlocker> {
    let mut blockers = Vec::new();
    if evidence.status != ForgePullRequestDryRunEvidenceStatus::Reviewable {
        blockers.push(ForgePullRequestExecutionAdmissionBlocker::EvidenceNotReviewable);
    }
    if !operator_approved {
        blockers.push(ForgePullRequestExecutionAdmissionBlocker::OperatorApprovalMissing);
    }
    blockers
}

#[cfg(test)]
mod tests;
