//! Data-only command descriptors for Git change-request execution.

use serde::{Deserialize, Serialize};

use crate::{
    GitChangeRequestExecutionAuthorityRecord, GitChangeRequestExecutionAuthoritySet,
    GitChangeRequestExecutionAuthorityStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitChangeRequestCommandDescriptorsInput {
    pub authorities: GitChangeRequestExecutionAuthoritySet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitChangeRequestCommandDescriptorSet {
    pub descriptor_set_id: String,
    pub descriptors: Vec<GitChangeRequestCommandDescriptorRecord>,
    pub skipped_authority_ids: Vec<String>,
    pub shell_command_created: bool,
    pub forge_request_created: bool,
    pub branch_created: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    pub pull_request_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitChangeRequestCommandDescriptorRecord {
    pub descriptor_id: String,
    pub authority_id: String,
    pub git_plan_id: String,
    pub task_id: String,
    pub repo_id: String,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub command_kind: GitChangeRequestCommandKind,
    pub status: GitChangeRequestCommandDescriptorStatus,
    pub blockers: Vec<GitChangeRequestCommandDescriptorBlocker>,
    pub shell_command_created: bool,
    pub forge_request_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeRequestCommandKind {
    BranchPreparation,
    CommitCreation,
    PushBranch,
    PullRequestCreation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeRequestCommandDescriptorStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeRequestCommandDescriptorBlocker {
    AuthorityNotReady,
}

pub fn git_change_request_command_descriptors(
    input: GitChangeRequestCommandDescriptorsInput,
) -> GitChangeRequestCommandDescriptorSet {
    let mut descriptors = input
        .authorities
        .authorities
        .iter()
        .flat_map(descriptors_for_authority)
        .collect::<Vec<_>>();
    descriptors.sort_by(|left, right| left.descriptor_id.cmp(&right.descriptor_id));

    GitChangeRequestCommandDescriptorSet {
        descriptor_set_id: "git-change-request-command-descriptors".to_owned(),
        skipped_authority_ids: descriptors
            .iter()
            .filter(|descriptor| {
                descriptor.status != GitChangeRequestCommandDescriptorStatus::Ready
            })
            .map(|descriptor| descriptor.authority_id.clone())
            .collect(),
        descriptors,
        shell_command_created: false,
        forge_request_created: false,
        branch_created: false,
        commit_created: false,
        push_executed: false,
        pull_request_created: false,
    }
}

fn descriptors_for_authority(
    authority: &GitChangeRequestExecutionAuthorityRecord,
) -> Vec<GitChangeRequestCommandDescriptorRecord> {
    let mut descriptors = Vec::new();
    if authority.branch_authority_requested {
        descriptors.push(descriptor(
            authority,
            GitChangeRequestCommandKind::BranchPreparation,
        ));
    }
    if authority.commit_authority_requested {
        descriptors.push(descriptor(
            authority,
            GitChangeRequestCommandKind::CommitCreation,
        ));
    }
    if authority.push_authority_requested {
        descriptors.push(descriptor(
            authority,
            GitChangeRequestCommandKind::PushBranch,
        ));
    }
    if authority.pull_request_authority_requested {
        descriptors.push(descriptor(
            authority,
            GitChangeRequestCommandKind::PullRequestCreation,
        ));
    }
    descriptors
}

fn descriptor(
    authority: &GitChangeRequestExecutionAuthorityRecord,
    command_kind: GitChangeRequestCommandKind,
) -> GitChangeRequestCommandDescriptorRecord {
    let blockers = blockers(authority);
    let status = if blockers.is_empty() {
        GitChangeRequestCommandDescriptorStatus::Ready
    } else {
        GitChangeRequestCommandDescriptorStatus::Blocked
    };

    GitChangeRequestCommandDescriptorRecord {
        descriptor_id: format!(
            "git-change-request-command-descriptor:{}:{}",
            authority.authority_id,
            command_kind_suffix(&command_kind)
        ),
        authority_id: authority.authority_id.clone(),
        git_plan_id: authority.git_plan_id.clone(),
        task_id: authority.task_id.clone(),
        repo_id: authority.repo_id.clone(),
        operator_ref: authority.operator_ref.clone(),
        evidence_refs: authority.evidence_refs.clone(),
        command_kind,
        status,
        blockers,
        shell_command_created: false,
        forge_request_created: false,
    }
}

fn blockers(
    authority: &GitChangeRequestExecutionAuthorityRecord,
) -> Vec<GitChangeRequestCommandDescriptorBlocker> {
    let mut blockers = Vec::new();
    if authority.status != GitChangeRequestExecutionAuthorityStatus::Ready {
        blockers.push(GitChangeRequestCommandDescriptorBlocker::AuthorityNotReady);
    }
    blockers
}

fn command_kind_suffix(command_kind: &GitChangeRequestCommandKind) -> &'static str {
    match command_kind {
        GitChangeRequestCommandKind::BranchPreparation => "branch-preparation",
        GitChangeRequestCommandKind::CommitCreation => "commit-creation",
        GitChangeRequestCommandKind::PushBranch => "push-branch",
        GitChangeRequestCommandKind::PullRequestCreation => "pull-request-creation",
    }
}

#[cfg(test)]
mod tests;
