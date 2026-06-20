//! Git dry-run command request records.

use serde::{Deserialize, Serialize};

use crate::{
    GitDryRunAdapterAdmissionRecord, GitDryRunAdapterAdmissionStatus, GitDryRunCommandDescriptor,
    GitDryRunCommandDescriptorSet,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitDryRunCommandRequestInput {
    pub admission: GitDryRunAdapterAdmissionRecord,
    pub descriptors: GitDryRunCommandDescriptorSet,
    pub descriptor_id: String,
    pub repo_id: String,
    pub worktree_path_ref: String,
    pub evidence_root_ref: String,
    pub raw_output_retention_requested: bool,
    pub checkout_requested: bool,
    pub branch_mutation_requested: bool,
    pub commit_requested: bool,
    pub push_requested: bool,
    pub forge_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitDryRunCommandRequestRecord {
    pub request_id: String,
    pub admission_id: String,
    pub descriptor_id: String,
    pub repo_id: String,
    pub worktree_path_ref: String,
    pub evidence_root_ref: String,
    pub argv: Vec<String>,
    pub stdout_limit_bytes: usize,
    pub stderr_limit_bytes: usize,
    pub status: GitDryRunCommandRequestStatus,
    pub blockers: Vec<GitDryRunCommandRequestBlocker>,
    pub git_dry_run_requested: bool,
    pub checkout_authority_granted: bool,
    pub branch_mutation_authority_granted: bool,
    pub commit_authority_granted: bool,
    pub push_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub raw_output_retention_granted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitDryRunCommandRequestStatus {
    Admitted,
    Blocked,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitDryRunCommandRequestBlocker {
    AdmissionNotAccepted,
    UnknownDescriptor,
    DescriptorNotAdmitted,
    MutatingDescriptor,
    RepoIdMissing,
    WorktreePathRefMissing,
    EvidenceRootRefMissing,
    RawOutputRetentionRequested,
    CheckoutRequested,
    BranchMutationRequested,
    CommitRequested,
    PushRequested,
    ForgeRequested,
}

pub fn git_dry_run_command_request_record(
    input: GitDryRunCommandRequestInput,
) -> GitDryRunCommandRequestRecord {
    let descriptor = input
        .descriptors
        .descriptors
        .iter()
        .find(|descriptor| descriptor.descriptor_id == input.descriptor_id)
        .cloned();
    let blockers = blockers(&input, descriptor.as_ref());
    let status = status(&blockers);
    let descriptor = descriptor.unwrap_or_else(|| GitDryRunCommandDescriptor {
        descriptor_id: input.descriptor_id.clone(),
        label: "unknown".to_owned(),
        argv: Vec::new(),
        stdout_limit_bytes: 0,
        stderr_limit_bytes: 0,
        expected_summary_kind: crate::GitDryRunSummaryKind::PorcelainStatus,
        mutates_working_tree: false,
        mutates_index: false,
        creates_commit: false,
        pushes_refs: false,
        raw_output_retention_granted: false,
    });

    GitDryRunCommandRequestRecord {
        request_id: format!(
            "git-dry-run-command-request:{}:{}",
            input.admission.admission_id, input.descriptor_id
        ),
        admission_id: input.admission.admission_id,
        descriptor_id: descriptor.descriptor_id,
        repo_id: input.repo_id,
        worktree_path_ref: input.worktree_path_ref,
        evidence_root_ref: input.evidence_root_ref,
        argv: descriptor.argv,
        stdout_limit_bytes: descriptor.stdout_limit_bytes,
        stderr_limit_bytes: descriptor.stderr_limit_bytes,
        git_dry_run_requested: status == GitDryRunCommandRequestStatus::Admitted,
        status,
        blockers,
        checkout_authority_granted: false,
        branch_mutation_authority_granted: false,
        commit_authority_granted: false,
        push_authority_granted: false,
        forge_authority_granted: false,
        raw_output_retention_granted: false,
    }
}

fn blockers(
    input: &GitDryRunCommandRequestInput,
    descriptor: Option<&GitDryRunCommandDescriptor>,
) -> Vec<GitDryRunCommandRequestBlocker> {
    let mut blockers = Vec::new();
    if input.admission.status != GitDryRunAdapterAdmissionStatus::Admitted {
        blockers.push(GitDryRunCommandRequestBlocker::AdmissionNotAccepted);
    }
    if descriptor.is_none() {
        blockers.push(GitDryRunCommandRequestBlocker::UnknownDescriptor);
    }
    if !input
        .admission
        .descriptor_ids
        .contains(&input.descriptor_id)
    {
        blockers.push(GitDryRunCommandRequestBlocker::DescriptorNotAdmitted);
    }
    if descriptor.is_some_and(|descriptor| {
        descriptor.mutates_working_tree
            || descriptor.mutates_index
            || descriptor.creates_commit
            || descriptor.pushes_refs
    }) {
        blockers.push(GitDryRunCommandRequestBlocker::MutatingDescriptor);
    }
    if input.repo_id.is_empty() {
        blockers.push(GitDryRunCommandRequestBlocker::RepoIdMissing);
    }
    if input.worktree_path_ref.is_empty() {
        blockers.push(GitDryRunCommandRequestBlocker::WorktreePathRefMissing);
    }
    if input.evidence_root_ref.is_empty() {
        blockers.push(GitDryRunCommandRequestBlocker::EvidenceRootRefMissing);
    }
    if input.raw_output_retention_requested {
        blockers.push(GitDryRunCommandRequestBlocker::RawOutputRetentionRequested);
    }
    if input.checkout_requested {
        blockers.push(GitDryRunCommandRequestBlocker::CheckoutRequested);
    }
    if input.branch_mutation_requested {
        blockers.push(GitDryRunCommandRequestBlocker::BranchMutationRequested);
    }
    if input.commit_requested {
        blockers.push(GitDryRunCommandRequestBlocker::CommitRequested);
    }
    if input.push_requested {
        blockers.push(GitDryRunCommandRequestBlocker::PushRequested);
    }
    if input.forge_requested {
        blockers.push(GitDryRunCommandRequestBlocker::ForgeRequested);
    }
    blockers
}

fn status(blockers: &[GitDryRunCommandRequestBlocker]) -> GitDryRunCommandRequestStatus {
    if blockers.is_empty() {
        GitDryRunCommandRequestStatus::Admitted
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            GitDryRunCommandRequestBlocker::AdmissionNotAccepted
                | GitDryRunCommandRequestBlocker::UnknownDescriptor
                | GitDryRunCommandRequestBlocker::DescriptorNotAdmitted
                | GitDryRunCommandRequestBlocker::RepoIdMissing
                | GitDryRunCommandRequestBlocker::WorktreePathRefMissing
                | GitDryRunCommandRequestBlocker::EvidenceRootRefMissing
        )
    }) {
        GitDryRunCommandRequestStatus::RepairRequired
    } else {
        GitDryRunCommandRequestStatus::Blocked
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_dry_run_command_request_records_admit_descriptor_backed_requests() {
        let record =
            git_dry_run_command_request_record(input("git-dry-run-status-porcelain", false));

        assert_eq!(record.status, GitDryRunCommandRequestStatus::Admitted);
        assert_eq!(record.argv, vec!["git", "status", "--porcelain=v1", "-z"]);
        assert!(record.git_dry_run_requested);
        assert!(!record.commit_authority_granted);
        assert!(!record.raw_output_retention_granted);
    }

    #[test]
    fn git_dry_run_command_request_records_block_unknown_or_mutating_requests() {
        let record = git_dry_run_command_request_record(input("git commit", true));

        assert_eq!(record.status, GitDryRunCommandRequestStatus::RepairRequired);
        assert!(record
            .blockers
            .contains(&GitDryRunCommandRequestBlocker::UnknownDescriptor));
        assert!(record
            .blockers
            .contains(&GitDryRunCommandRequestBlocker::CommitRequested));
        assert!(!record.git_dry_run_requested);
        assert!(!record.commit_authority_granted);
    }

    fn input(descriptor_id: &str, blocked: bool) -> GitDryRunCommandRequestInput {
        let descriptors = crate::git_dry_run_command_descriptors();
        GitDryRunCommandRequestInput {
            admission: crate::GitDryRunAdapterAdmissionRecord {
                admission_id: "admission:1".to_owned(),
                capability_item_id: "capability:1".to_owned(),
                persisted_dry_run_plan_id: "persisted:1".to_owned(),
                task_id: "task:1".to_owned(),
                work_item_id: Some("work:1".to_owned()),
                completion_id: Some("completion:1".to_owned()),
                operator_ref: "operator:tom".to_owned(),
                evidence_refs: vec!["evidence:admission".to_owned()],
                descriptor_ids: descriptors
                    .descriptors
                    .iter()
                    .map(|descriptor| descriptor.descriptor_id.clone())
                    .collect(),
                status: crate::GitDryRunAdapterAdmissionStatus::Admitted,
                blockers: Vec::new(),
                git_dry_run_admitted: true,
                git_mutation_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_output_retention_granted: false,
            },
            descriptors,
            descriptor_id: descriptor_id.to_owned(),
            repo_id: "repo:1".to_owned(),
            worktree_path_ref: "path-ref:repo".to_owned(),
            evidence_root_ref: "evidence-root:1".to_owned(),
            raw_output_retention_requested: blocked,
            checkout_requested: false,
            branch_mutation_requested: false,
            commit_requested: blocked,
            push_requested: false,
            forge_requested: false,
        }
    }
}
