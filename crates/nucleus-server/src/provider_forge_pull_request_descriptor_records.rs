//! Forge pull-request descriptor records from ready Git push preflight records.

use crate::provider_no_effects::ForgeScmNoEffects;
use serde::{Deserialize, Serialize};

use crate::{
    GitPushPreflightRecord, GitPushPreflightSet, GitPushPreflightStatus, GitPushRemoteTarget,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgePullRequestDescriptorInput {
    pub preflights: GitPushPreflightSet,
    pub forge_provider: Option<ForgePullRequestProvider>,
    pub base_branch: Option<String>,
    pub head_branch: Option<String>,
    pub title_source: Option<ForgePullRequestTextSource>,
    pub body_source: Option<ForgePullRequestTextSource>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgePullRequestDescriptorSet {
    pub descriptor_set_id: String,
    pub descriptors: Vec<ForgePullRequestDescriptorRecord>,
    pub skipped_preflight_ids: Vec<String>,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgePullRequestDescriptorRecord {
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
    pub status: ForgePullRequestDescriptorStatus,
    pub blockers: Vec<ForgePullRequestDescriptorBlocker>,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgePullRequestProvider {
    GitHub,
    GitLab,
    GenericForge,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgePullRequestTextSource {
    OperatorProvided,
    AgentSuggested,
    GeneratedFromEvidence,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgePullRequestDescriptorStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgePullRequestDescriptorBlocker {
    PushPreflightNotReady,
    ForgeProviderMissing,
    BaseBranchMissing,
    HeadBranchMissing,
    TitleSourceMissing,
    BodySourceMissing,
}

pub fn forge_pull_request_descriptor_records(
    input: ForgePullRequestDescriptorInput,
) -> ForgePullRequestDescriptorSet {
    let context = ForgePullRequestDescriptorContext {
        forge_provider: input.forge_provider,
        base_branch: input.base_branch,
        head_branch: input.head_branch,
        title_source: input.title_source,
        body_source: input.body_source,
    };
    let mut descriptors = input
        .preflights
        .preflights
        .into_iter()
        .map(|preflight| descriptor_record(&context, preflight))
        .collect::<Vec<_>>();
    descriptors.sort_by(|left, right| left.descriptor_id.cmp(&right.descriptor_id));

    ForgePullRequestDescriptorSet {
        descriptor_set_id: "forge-pull-request-descriptor-records".to_owned(),
        skipped_preflight_ids: descriptors
            .iter()
            .filter(|descriptor| descriptor.status != ForgePullRequestDescriptorStatus::Ready)
            .map(|descriptor| descriptor.push_preflight_id.clone())
            .collect(),
        descriptors,
        no_effects: ForgeScmNoEffects::none(),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ForgePullRequestDescriptorContext {
    forge_provider: Option<ForgePullRequestProvider>,
    base_branch: Option<String>,
    head_branch: Option<String>,
    title_source: Option<ForgePullRequestTextSource>,
    body_source: Option<ForgePullRequestTextSource>,
}

fn descriptor_record(
    context: &ForgePullRequestDescriptorContext,
    preflight: GitPushPreflightRecord,
) -> ForgePullRequestDescriptorRecord {
    let blockers = blockers(context, &preflight);
    let status = if blockers.is_empty() {
        ForgePullRequestDescriptorStatus::Ready
    } else {
        ForgePullRequestDescriptorStatus::Blocked
    };

    ForgePullRequestDescriptorRecord {
        descriptor_id: format!("forge-pull-request-descriptor:{}", preflight.preflight_id),
        push_preflight_id: preflight.preflight_id,
        push_descriptor_id: preflight.descriptor_id,
        push_admission_id: preflight.admission_id,
        commit_preflight_id: preflight.commit_preflight_id,
        commit_descriptor_id: preflight.commit_descriptor_id,
        commit_admission_id: preflight.commit_admission_id,
        branch_worktree_evidence_id: preflight.branch_worktree_evidence_id,
        request_id: preflight.request_id,
        authority_id: preflight.authority_id,
        git_plan_id: preflight.git_plan_id,
        task_id: preflight.task_id,
        repo_id: preflight.repo_id,
        operator_ref: preflight.operator_ref,
        remote_target: preflight.remote_target,
        forge_provider: context.forge_provider.clone(),
        base_branch: context.base_branch.clone(),
        head_branch: context.head_branch.clone(),
        title_source: context.title_source.clone(),
        body_source: context.body_source.clone(),
        status,
        blockers,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn blockers(
    context: &ForgePullRequestDescriptorContext,
    preflight: &GitPushPreflightRecord,
) -> Vec<ForgePullRequestDescriptorBlocker> {
    let mut blockers = Vec::new();
    if preflight.status != GitPushPreflightStatus::Ready {
        blockers.push(ForgePullRequestDescriptorBlocker::PushPreflightNotReady);
    }
    if context.forge_provider.is_none() {
        blockers.push(ForgePullRequestDescriptorBlocker::ForgeProviderMissing);
    }
    if context.base_branch.is_none() {
        blockers.push(ForgePullRequestDescriptorBlocker::BaseBranchMissing);
    }
    if context.head_branch.is_none() {
        blockers.push(ForgePullRequestDescriptorBlocker::HeadBranchMissing);
    }
    if context.title_source.is_none() {
        blockers.push(ForgePullRequestDescriptorBlocker::TitleSourceMissing);
    }
    if context.body_source.is_none() {
        blockers.push(ForgePullRequestDescriptorBlocker::BodySourceMissing);
    }
    blockers
}

#[cfg(test)]
mod tests;
