//! Git commit admission records from reviewable branch/worktree evidence.

use crate::provider_no_effects::ForgeScmNoEffects;
use serde::{Deserialize, Serialize};

use crate::{
    GitBranchWorktreeEvidenceRecord, GitBranchWorktreeEvidenceSet, GitBranchWorktreeEvidenceStatus,
    GitBranchWorktreeMode,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommitAdmissionInput {
    pub evidence: GitBranchWorktreeEvidenceSet,
    pub commit_message_source: Option<GitCommitMessageSource>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitCommitAdmissionSet {
    pub admission_set_id: String,
    pub admissions: Vec<GitCommitAdmissionRecord>,
    pub skipped_evidence_ids: Vec<String>,
    pub commit_created: bool,
    pub push_executed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitCommitAdmissionRecord {
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
    pub commit_message_source: Option<GitCommitMessageSource>,
    pub status: GitCommitAdmissionStatus,
    pub blockers: Vec<GitCommitAdmissionBlocker>,
    pub commit_created: bool,
    pub push_executed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitCommitMessageSource {
    OperatorProvided,
    AgentSuggested,
    GeneratedFromDiff,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitCommitAdmissionStatus {
    Admitted,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitCommitAdmissionBlocker {
    BranchWorktreeEvidenceNotReviewable,
    CommitMessageSourceMissing,
}

pub fn git_commit_admission_records(input: GitCommitAdmissionInput) -> GitCommitAdmissionSet {
    let source = input.commit_message_source;
    let mut admissions = input
        .evidence
        .evidence
        .into_iter()
        .map(|evidence| admission_record(&source, evidence))
        .collect::<Vec<_>>();
    admissions.sort_by(|left, right| left.admission_id.cmp(&right.admission_id));

    GitCommitAdmissionSet {
        admission_set_id: "git-commit-admission-records".to_owned(),
        skipped_evidence_ids: admissions
            .iter()
            .filter(|admission| admission.status != GitCommitAdmissionStatus::Admitted)
            .map(|admission| admission.branch_worktree_evidence_id.clone())
            .collect(),
        admissions,
        commit_created: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn admission_record(
    source: &Option<GitCommitMessageSource>,
    evidence: GitBranchWorktreeEvidenceRecord,
) -> GitCommitAdmissionRecord {
    let blockers = blockers(source, &evidence);
    let status = if blockers.is_empty() {
        GitCommitAdmissionStatus::Admitted
    } else {
        GitCommitAdmissionStatus::Blocked
    };

    GitCommitAdmissionRecord {
        admission_id: format!("git-commit-admission:{}", evidence.evidence_id),
        branch_worktree_evidence_id: evidence.evidence_id,
        branch_worktree_outcome_id: evidence.outcome_id,
        branch_worktree_handoff_id: evidence.execution_handoff_id,
        branch_worktree_preflight_id: evidence.preflight_id,
        branch_worktree_descriptor_id: evidence.descriptor_id,
        branch_worktree_admission_id: evidence.admission_id,
        dry_run_evidence_id: evidence.dry_run_evidence_id,
        dry_run_outcome_id: evidence.dry_run_outcome_id,
        dry_run_handoff_id: evidence.dry_run_handoff_id,
        request_id: evidence.request_id,
        authority_id: evidence.authority_id,
        git_plan_id: evidence.git_plan_id,
        task_id: evidence.task_id,
        repo_id: evidence.repo_id,
        operator_ref: evidence.operator_ref,
        worktree_mode: evidence.worktree_mode,
        commit_message_source: source.clone(),
        status,
        blockers,
        commit_created: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn blockers(
    source: &Option<GitCommitMessageSource>,
    evidence: &GitBranchWorktreeEvidenceRecord,
) -> Vec<GitCommitAdmissionBlocker> {
    let mut blockers = Vec::new();
    if evidence.status != GitBranchWorktreeEvidenceStatus::Reviewable {
        blockers.push(GitCommitAdmissionBlocker::BranchWorktreeEvidenceNotReviewable);
    }
    if source.is_none() {
        blockers.push(GitCommitAdmissionBlocker::CommitMessageSourceMissing);
    }
    blockers
}

#[cfg(test)]
mod tests;
