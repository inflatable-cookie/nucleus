//! Data-only command descriptors for admitted Git commit records.

use serde::{Deserialize, Serialize};

use crate::{
    GitBranchWorktreeMode, GitCommitAdmissionRecord, GitCommitAdmissionSet,
    GitCommitAdmissionStatus, GitCommitMessageSource,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommitCommandDescriptorsInput {
    pub admissions: GitCommitAdmissionSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitCommitCommandDescriptorSet {
    pub descriptor_set_id: String,
    pub descriptors: Vec<GitCommitCommandDescriptorRecord>,
    pub skipped_admission_ids: Vec<String>,
    pub executable_argv_created: bool,
    pub shell_handoff_created: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    pub pull_request_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitCommitCommandDescriptorRecord {
    pub descriptor_id: String,
    pub admission_id: String,
    pub branch_worktree_evidence_id: String,
    pub branch_worktree_outcome_id: String,
    pub branch_worktree_handoff_id: String,
    pub branch_worktree_preflight_id: String,
    pub branch_worktree_descriptor_id: String,
    pub branch_worktree_admission_id: String,
    pub dry_run_evidence_id: String,
    pub dry_run_outcome_id: String,
    pub dry_run_handoff_id: String,
    pub request_id: String,
    pub authority_id: String,
    pub git_plan_id: String,
    pub task_id: String,
    pub repo_id: String,
    pub operator_ref: String,
    pub worktree_mode: GitBranchWorktreeMode,
    pub command_kind: GitCommitCommandKind,
    pub commit_message_source: Option<GitCommitMessageSource>,
    pub status: GitCommitCommandDescriptorStatus,
    pub blockers: Vec<GitCommitCommandDescriptorBlocker>,
    pub executable_argv_created: bool,
    pub shell_handoff_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitCommitCommandKind {
    CreateCommit,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitCommitCommandDescriptorStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitCommitCommandDescriptorBlocker {
    AdmissionNotAdmitted,
}

pub fn git_commit_command_descriptors(
    input: GitCommitCommandDescriptorsInput,
) -> GitCommitCommandDescriptorSet {
    let mut descriptors = input
        .admissions
        .admissions
        .into_iter()
        .map(descriptor_record)
        .collect::<Vec<_>>();
    descriptors.sort_by(|left, right| left.descriptor_id.cmp(&right.descriptor_id));

    GitCommitCommandDescriptorSet {
        descriptor_set_id: "git-commit-command-descriptors".to_owned(),
        skipped_admission_ids: descriptors
            .iter()
            .filter(|descriptor| descriptor.status != GitCommitCommandDescriptorStatus::Ready)
            .map(|descriptor| descriptor.admission_id.clone())
            .collect(),
        descriptors,
        executable_argv_created: false,
        shell_handoff_created: false,
        commit_created: false,
        push_executed: false,
        pull_request_created: false,
    }
}

fn descriptor_record(admission: GitCommitAdmissionRecord) -> GitCommitCommandDescriptorRecord {
    let blockers = blockers(&admission);
    let status = if blockers.is_empty() {
        GitCommitCommandDescriptorStatus::Ready
    } else {
        GitCommitCommandDescriptorStatus::Blocked
    };

    GitCommitCommandDescriptorRecord {
        descriptor_id: format!("git-commit-command-descriptor:{}", admission.admission_id),
        admission_id: admission.admission_id,
        branch_worktree_evidence_id: admission.branch_worktree_evidence_id,
        branch_worktree_outcome_id: admission.branch_worktree_outcome_id,
        branch_worktree_handoff_id: admission.branch_worktree_handoff_id,
        branch_worktree_preflight_id: admission.branch_worktree_preflight_id,
        branch_worktree_descriptor_id: admission.branch_worktree_descriptor_id,
        branch_worktree_admission_id: admission.branch_worktree_admission_id,
        dry_run_evidence_id: admission.dry_run_evidence_id,
        dry_run_outcome_id: admission.dry_run_outcome_id,
        dry_run_handoff_id: admission.dry_run_handoff_id,
        request_id: admission.request_id,
        authority_id: admission.authority_id,
        git_plan_id: admission.git_plan_id,
        task_id: admission.task_id,
        repo_id: admission.repo_id,
        operator_ref: admission.operator_ref,
        worktree_mode: admission.worktree_mode,
        command_kind: GitCommitCommandKind::CreateCommit,
        commit_message_source: admission.commit_message_source,
        status,
        blockers,
        executable_argv_created: false,
        shell_handoff_created: false,
    }
}

fn blockers(admission: &GitCommitAdmissionRecord) -> Vec<GitCommitCommandDescriptorBlocker> {
    let mut blockers = Vec::new();
    if admission.status != GitCommitAdmissionStatus::Admitted {
        blockers.push(GitCommitCommandDescriptorBlocker::AdmissionNotAdmitted);
    }
    blockers
}

#[cfg(test)]
mod tests;
