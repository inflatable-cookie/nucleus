//! Data-only Git dry-run command descriptors.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitDryRunCommandDescriptorSet {
    pub descriptor_set_id: String,
    pub descriptors: Vec<GitDryRunCommandDescriptor>,
    pub commit_authority_granted: bool,
    pub branch_mutation_authority_granted: bool,
    pub push_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub raw_output_retention_granted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitDryRunCommandDescriptor {
    pub descriptor_id: String,
    pub label: String,
    pub argv: Vec<String>,
    pub stdout_limit_bytes: usize,
    pub stderr_limit_bytes: usize,
    pub expected_summary_kind: GitDryRunSummaryKind,
    pub mutates_working_tree: bool,
    pub mutates_index: bool,
    pub creates_commit: bool,
    pub pushes_refs: bool,
    pub raw_output_retention_granted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitDryRunSummaryKind {
    PorcelainStatus,
    DiffStat,
}

pub fn git_dry_run_command_descriptors() -> GitDryRunCommandDescriptorSet {
    GitDryRunCommandDescriptorSet {
        descriptor_set_id: "git-dry-run-command-descriptors".to_owned(),
        descriptors: vec![
            descriptor(
                "git-dry-run-status-porcelain",
                "status-porcelain",
                vec!["git", "status", "--porcelain=v1", "-z"],
                GitDryRunSummaryKind::PorcelainStatus,
            ),
            descriptor(
                "git-dry-run-diff-stat",
                "diff-stat",
                vec!["git", "diff", "--stat", "--no-ext-diff"],
                GitDryRunSummaryKind::DiffStat,
            ),
        ],
        commit_authority_granted: false,
        branch_mutation_authority_granted: false,
        push_authority_granted: false,
        forge_authority_granted: false,
        raw_output_retention_granted: false,
    }
}

fn descriptor(
    descriptor_id: &str,
    label: &str,
    argv: Vec<&str>,
    expected_summary_kind: GitDryRunSummaryKind,
) -> GitDryRunCommandDescriptor {
    GitDryRunCommandDescriptor {
        descriptor_id: descriptor_id.to_owned(),
        label: label.to_owned(),
        argv: argv.into_iter().map(str::to_owned).collect(),
        stdout_limit_bytes: 64 * 1024,
        stderr_limit_bytes: 8 * 1024,
        expected_summary_kind,
        mutates_working_tree: false,
        mutates_index: false,
        creates_commit: false,
        pushes_refs: false,
        raw_output_retention_granted: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_dry_run_command_descriptors_are_non_mutating() {
        let set = git_dry_run_command_descriptors();

        assert_eq!(set.descriptors.len(), 2);
        assert!(set.descriptors.iter().all(|descriptor| {
            !descriptor.mutates_working_tree
                && !descriptor.mutates_index
                && !descriptor.creates_commit
                && !descriptor.pushes_refs
                && !descriptor.raw_output_retention_granted
        }));
        assert!(set.descriptors.iter().all(|descriptor| {
            descriptor.stdout_limit_bytes > 0 && descriptor.stderr_limit_bytes > 0
        }));
        assert!(!set.commit_authority_granted);
        assert!(!set.push_authority_granted);
        assert!(!set.forge_authority_granted);
    }
}
