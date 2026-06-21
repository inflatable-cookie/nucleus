//! Git branch/worktree admission records.

use serde::{Deserialize, Serialize};

use crate::{
    GitChangeRequestDryRunEvidenceRecord, GitChangeRequestDryRunEvidenceSet,
    GitChangeRequestDryRunEvidenceStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreeAdmissionInput {
    pub evidence: GitChangeRequestDryRunEvidenceSet,
    pub worktree_mode: GitBranchWorktreeMode,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitBranchWorktreeAdmissionSet {
    pub admission_set_id: String,
    pub admissions: Vec<GitBranchWorktreeAdmissionRecord>,
    pub skipped_evidence_ids: Vec<String>,
    pub checkout_executed: bool,
    pub branch_created: bool,
    pub worktree_created: bool,
    pub forge_effect_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitBranchWorktreeAdmissionRecord {
    pub admission_id: String,
    pub dry_run_evidence_id: String,
    pub outcome_id: String,
    pub handoff_id: String,
    pub request_id: String,
    pub authority_id: String,
    pub git_plan_id: String,
    pub task_id: String,
    pub repo_id: String,
    pub operator_ref: String,
    pub worktree_mode: GitBranchWorktreeMode,
    pub status: GitBranchWorktreeAdmissionStatus,
    pub blockers: Vec<GitBranchWorktreeAdmissionBlocker>,
    pub checkout_executed: bool,
    pub branch_created: bool,
    pub worktree_created: bool,
    pub forge_effect_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeMode {
    PrimaryTree,
    IsolatedWorktree,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeAdmissionStatus {
    Admitted,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeAdmissionBlocker {
    EvidenceNotReviewable,
}

pub fn git_branch_worktree_admission_records(
    input: GitBranchWorktreeAdmissionInput,
) -> GitBranchWorktreeAdmissionSet {
    let mode = input.worktree_mode;
    let mut admissions = input
        .evidence
        .evidence
        .into_iter()
        .map(|evidence| admission_record(&mode, evidence))
        .collect::<Vec<_>>();
    admissions.sort_by(|left, right| left.admission_id.cmp(&right.admission_id));

    GitBranchWorktreeAdmissionSet {
        admission_set_id: "git-branch-worktree-admission-records".to_owned(),
        skipped_evidence_ids: admissions
            .iter()
            .filter(|admission| admission.status != GitBranchWorktreeAdmissionStatus::Admitted)
            .map(|admission| admission.dry_run_evidence_id.clone())
            .collect(),
        admissions,
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
        forge_effect_executed: false,
        raw_output_retained: false,
    }
}

fn admission_record(
    mode: &GitBranchWorktreeMode,
    evidence: GitChangeRequestDryRunEvidenceRecord,
) -> GitBranchWorktreeAdmissionRecord {
    let blockers = blockers(&evidence);
    let status = if blockers.is_empty() {
        GitBranchWorktreeAdmissionStatus::Admitted
    } else {
        GitBranchWorktreeAdmissionStatus::Blocked
    };

    GitBranchWorktreeAdmissionRecord {
        admission_id: format!("git-branch-worktree-admission:{}", evidence.evidence_id),
        dry_run_evidence_id: evidence.evidence_id,
        outcome_id: evidence.outcome_id,
        handoff_id: evidence.handoff_id,
        request_id: evidence.request_id,
        authority_id: evidence.authority_id,
        git_plan_id: evidence.git_plan_id,
        task_id: evidence.task_id,
        repo_id: evidence.repo_id,
        operator_ref: evidence.operator_ref,
        worktree_mode: mode.clone(),
        status,
        blockers,
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
        forge_effect_executed: false,
        raw_output_retained: false,
    }
}

fn blockers(
    evidence: &GitChangeRequestDryRunEvidenceRecord,
) -> Vec<GitBranchWorktreeAdmissionBlocker> {
    let mut blockers = Vec::new();
    if evidence.status != GitChangeRequestDryRunEvidenceStatus::Reviewable {
        blockers.push(GitBranchWorktreeAdmissionBlocker::EvidenceNotReviewable);
    }
    blockers
}

#[cfg(test)]
mod tests;
