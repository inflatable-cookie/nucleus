//! Read-only diagnostics for Git branch/worktree gates.

use serde::{Deserialize, Serialize};

use crate::{
    GitBranchWorktreeAdmissionSet, GitBranchWorktreeAdmissionStatus,
    GitBranchWorktreeCommandDescriptorSet, GitBranchWorktreeCommandDescriptorStatus,
    GitBranchWorktreeMode, GitBranchWorktreePreflightSet, GitBranchWorktreePreflightStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreeDiagnosticsInput {
    pub admissions: GitBranchWorktreeAdmissionSet,
    pub descriptors: GitBranchWorktreeCommandDescriptorSet,
    pub preflights: GitBranchWorktreePreflightSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitBranchWorktreeDiagnosticsRecord {
    pub diagnostics_id: String,
    pub admission_count: usize,
    pub admission_admitted_count: usize,
    pub descriptor_count: usize,
    pub descriptor_ready_count: usize,
    pub preflight_count: usize,
    pub preflight_ready_count: usize,
    pub primary_tree_count: usize,
    pub isolated_worktree_count: usize,
    pub blocker_count: usize,
    pub checkout_executed: bool,
    pub branch_created: bool,
    pub worktree_created: bool,
    pub forge_effect_executed: bool,
    pub raw_output_retained: bool,
}

pub fn git_branch_worktree_diagnostics(
    input: GitBranchWorktreeDiagnosticsInput,
) -> GitBranchWorktreeDiagnosticsRecord {
    GitBranchWorktreeDiagnosticsRecord {
        diagnostics_id: "git-branch-worktree-diagnostics".to_owned(),
        admission_count: input.admissions.admissions.len(),
        admission_admitted_count: input
            .admissions
            .admissions
            .iter()
            .filter(|admission| admission.status == GitBranchWorktreeAdmissionStatus::Admitted)
            .count(),
        descriptor_count: input.descriptors.descriptors.len(),
        descriptor_ready_count: input
            .descriptors
            .descriptors
            .iter()
            .filter(|descriptor| {
                descriptor.status == GitBranchWorktreeCommandDescriptorStatus::Ready
            })
            .count(),
        preflight_count: input.preflights.preflights.len(),
        preflight_ready_count: input
            .preflights
            .preflights
            .iter()
            .filter(|preflight| preflight.status == GitBranchWorktreePreflightStatus::Ready)
            .count(),
        primary_tree_count: input
            .admissions
            .admissions
            .iter()
            .filter(|admission| admission.worktree_mode == GitBranchWorktreeMode::PrimaryTree)
            .count(),
        isolated_worktree_count: input
            .admissions
            .admissions
            .iter()
            .filter(|admission| admission.worktree_mode == GitBranchWorktreeMode::IsolatedWorktree)
            .count(),
        blocker_count: input
            .admissions
            .admissions
            .iter()
            .map(|admission| admission.blockers.len())
            .sum::<usize>()
            + input
                .descriptors
                .descriptors
                .iter()
                .map(|descriptor| descriptor.blockers.len())
                .sum::<usize>()
            + input
                .preflights
                .preflights
                .iter()
                .map(|preflight| preflight.blockers.len())
                .sum::<usize>(),
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
        forge_effect_executed: false,
        raw_output_retained: false,
    }
}

#[cfg(test)]
mod tests;
