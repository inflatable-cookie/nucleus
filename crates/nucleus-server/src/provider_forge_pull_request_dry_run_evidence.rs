//! Reviewable dry-run evidence for forge pull-request descriptors.

use serde::{Deserialize, Serialize};

use crate::{
    ForgePullRequestDescriptorRecord, ForgePullRequestDescriptorSet,
    ForgePullRequestDescriptorStatus, ForgePullRequestProvider, ForgePullRequestTextSource,
    GitPushRemoteTarget,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgePullRequestDryRunEvidenceInput {
    pub descriptors: ForgePullRequestDescriptorSet,
    pub changed_path_count: usize,
    pub review_comment_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgePullRequestDryRunEvidenceSet {
    pub evidence_set_id: String,
    pub evidence: Vec<ForgePullRequestDryRunEvidenceRecord>,
    pub skipped_descriptor_ids: Vec<String>,
    pub pull_request_creation_authority_granted: bool,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgePullRequestDryRunEvidenceRecord {
    pub evidence_id: String,
    pub descriptor_id: String,
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
    pub status: ForgePullRequestDryRunEvidenceStatus,
    pub blockers: Vec<ForgePullRequestDryRunEvidenceBlocker>,
    pub changed_path_count: usize,
    pub review_comment_count: usize,
    pub pull_request_creation_authority_granted: bool,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgePullRequestDryRunEvidenceStatus {
    Reviewable,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgePullRequestDryRunEvidenceBlocker {
    DescriptorNotReady,
}

pub fn forge_pull_request_dry_run_evidence(
    input: ForgePullRequestDryRunEvidenceInput,
) -> ForgePullRequestDryRunEvidenceSet {
    let summary = ForgePullRequestDryRunEvidenceSummary {
        changed_path_count: input.changed_path_count,
        review_comment_count: input.review_comment_count,
    };
    let mut evidence = input
        .descriptors
        .descriptors
        .into_iter()
        .map(|descriptor| evidence_record(&summary, descriptor))
        .collect::<Vec<_>>();
    evidence.sort_by(|left, right| left.evidence_id.cmp(&right.evidence_id));

    ForgePullRequestDryRunEvidenceSet {
        evidence_set_id: "forge-pull-request-dry-run-evidence".to_owned(),
        skipped_descriptor_ids: evidence
            .iter()
            .filter(|record| record.status != ForgePullRequestDryRunEvidenceStatus::Reviewable)
            .map(|record| record.descriptor_id.clone())
            .collect(),
        evidence,
        pull_request_creation_authority_granted: false,
        pull_request_created: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        raw_output_retained: false,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ForgePullRequestDryRunEvidenceSummary {
    changed_path_count: usize,
    review_comment_count: usize,
}

fn evidence_record(
    summary: &ForgePullRequestDryRunEvidenceSummary,
    descriptor: ForgePullRequestDescriptorRecord,
) -> ForgePullRequestDryRunEvidenceRecord {
    let blockers = blockers(&descriptor);
    let status = if blockers.is_empty() {
        ForgePullRequestDryRunEvidenceStatus::Reviewable
    } else {
        ForgePullRequestDryRunEvidenceStatus::Blocked
    };

    ForgePullRequestDryRunEvidenceRecord {
        evidence_id: format!(
            "forge-pull-request-dry-run-evidence:{}",
            descriptor.descriptor_id
        ),
        descriptor_id: descriptor.descriptor_id,
        push_preflight_id: descriptor.push_preflight_id,
        push_descriptor_id: descriptor.push_descriptor_id,
        push_admission_id: descriptor.push_admission_id,
        commit_preflight_id: descriptor.commit_preflight_id,
        commit_descriptor_id: descriptor.commit_descriptor_id,
        commit_admission_id: descriptor.commit_admission_id,
        branch_worktree_evidence_id: descriptor.branch_worktree_evidence_id,
        request_id: descriptor.request_id,
        authority_id: descriptor.authority_id,
        git_plan_id: descriptor.git_plan_id,
        task_id: descriptor.task_id,
        repo_id: descriptor.repo_id,
        operator_ref: descriptor.operator_ref,
        remote_target: descriptor.remote_target,
        forge_provider: descriptor.forge_provider,
        base_branch: descriptor.base_branch,
        head_branch: descriptor.head_branch,
        title_source: descriptor.title_source,
        body_source: descriptor.body_source,
        status,
        blockers,
        changed_path_count: summary.changed_path_count,
        review_comment_count: summary.review_comment_count,
        pull_request_creation_authority_granted: false,
        pull_request_created: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        raw_output_retained: false,
    }
}

fn blockers(
    descriptor: &ForgePullRequestDescriptorRecord,
) -> Vec<ForgePullRequestDryRunEvidenceBlocker> {
    let mut blockers = Vec::new();
    if descriptor.status != ForgePullRequestDescriptorStatus::Ready {
        blockers.push(ForgePullRequestDryRunEvidenceBlocker::DescriptorNotReady);
    }
    blockers
}

#[cfg(test)]
mod tests;
