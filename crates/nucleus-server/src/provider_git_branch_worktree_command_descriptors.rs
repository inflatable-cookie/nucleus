//! Data-only command descriptors for Git branch/worktree admission.

use serde::{Deserialize, Serialize};

use crate::{
    GitBranchWorktreeAdmissionRecord, GitBranchWorktreeAdmissionSet,
    GitBranchWorktreeAdmissionStatus, GitBranchWorktreeMode,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreeCommandDescriptorsInput {
    pub admissions: GitBranchWorktreeAdmissionSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitBranchWorktreeCommandDescriptorSet {
    pub descriptor_set_id: String,
    pub descriptors: Vec<GitBranchWorktreeCommandDescriptorRecord>,
    pub skipped_admission_ids: Vec<String>,
    pub executable_argv_created: bool,
    pub shell_handoff_created: bool,
    pub checkout_executed: bool,
    pub branch_created: bool,
    pub worktree_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitBranchWorktreeCommandDescriptorRecord {
    pub descriptor_id: String,
    pub admission_id: String,
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
    pub command_kind: GitBranchWorktreeCommandKind,
    pub status: GitBranchWorktreeCommandDescriptorStatus,
    pub blockers: Vec<GitBranchWorktreeCommandDescriptorBlocker>,
    pub executable_argv_created: bool,
    pub shell_handoff_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeCommandKind {
    CheckoutTemporaryBranch,
    CreateIsolatedWorktree,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeCommandDescriptorStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeCommandDescriptorBlocker {
    AdmissionNotAdmitted,
}

pub fn git_branch_worktree_command_descriptors(
    input: GitBranchWorktreeCommandDescriptorsInput,
) -> GitBranchWorktreeCommandDescriptorSet {
    let mut descriptors = input
        .admissions
        .admissions
        .into_iter()
        .map(descriptor_record)
        .collect::<Vec<_>>();
    descriptors.sort_by(|left, right| left.descriptor_id.cmp(&right.descriptor_id));

    GitBranchWorktreeCommandDescriptorSet {
        descriptor_set_id: "git-branch-worktree-command-descriptors".to_owned(),
        skipped_admission_ids: descriptors
            .iter()
            .filter(|descriptor| {
                descriptor.status != GitBranchWorktreeCommandDescriptorStatus::Ready
            })
            .map(|descriptor| descriptor.admission_id.clone())
            .collect(),
        descriptors,
        executable_argv_created: false,
        shell_handoff_created: false,
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
    }
}

fn descriptor_record(
    admission: GitBranchWorktreeAdmissionRecord,
) -> GitBranchWorktreeCommandDescriptorRecord {
    let blockers = blockers(&admission);
    let status = if blockers.is_empty() {
        GitBranchWorktreeCommandDescriptorStatus::Ready
    } else {
        GitBranchWorktreeCommandDescriptorStatus::Blocked
    };
    let command_kind = match admission.worktree_mode {
        GitBranchWorktreeMode::PrimaryTree => GitBranchWorktreeCommandKind::CheckoutTemporaryBranch,
        GitBranchWorktreeMode::IsolatedWorktree => {
            GitBranchWorktreeCommandKind::CreateIsolatedWorktree
        }
    };

    GitBranchWorktreeCommandDescriptorRecord {
        descriptor_id: format!(
            "git-branch-worktree-command-descriptor:{}",
            admission.admission_id
        ),
        admission_id: admission.admission_id,
        dry_run_evidence_id: admission.dry_run_evidence_id,
        dry_run_outcome_id: admission.outcome_id,
        dry_run_handoff_id: admission.handoff_id,
        request_id: admission.request_id,
        authority_id: admission.authority_id,
        git_plan_id: admission.git_plan_id,
        task_id: admission.task_id,
        repo_id: admission.repo_id,
        operator_ref: admission.operator_ref,
        worktree_mode: admission.worktree_mode,
        command_kind,
        status,
        blockers,
        executable_argv_created: false,
        shell_handoff_created: false,
    }
}

fn blockers(
    admission: &GitBranchWorktreeAdmissionRecord,
) -> Vec<GitBranchWorktreeCommandDescriptorBlocker> {
    let mut blockers = Vec::new();
    if admission.status != GitBranchWorktreeAdmissionStatus::Admitted {
        blockers.push(GitBranchWorktreeCommandDescriptorBlocker::AdmissionNotAdmitted);
    }
    blockers
}

#[cfg(test)]
mod tests;
