//! Git push admission records from ready commit preflight records.

use serde::{Deserialize, Serialize};

use crate::{
    GitCommitMessageSource, GitCommitPreflightRecord, GitCommitPreflightSet,
    GitCommitPreflightStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitPushAdmissionInput {
    pub preflights: GitCommitPreflightSet,
    pub remote_target: Option<GitPushRemoteTarget>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitPushAdmissionSet {
    pub admission_set_id: String,
    pub admissions: Vec<GitPushAdmissionRecord>,
    pub skipped_preflight_ids: Vec<String>,
    pub push_executed: bool,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitPushAdmissionRecord {
    pub admission_id: String,
    pub commit_preflight_id: String,
    pub commit_descriptor_id: String,
    pub commit_admission_id: String,
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
    pub commit_message_source: Option<GitCommitMessageSource>,
    pub remote_target: Option<GitPushRemoteTarget>,
    pub status: GitPushAdmissionStatus,
    pub blockers: Vec<GitPushAdmissionBlocker>,
    pub push_executed: bool,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitPushRemoteTarget {
    pub remote_name: String,
    pub branch_name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitPushAdmissionStatus {
    Admitted,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitPushAdmissionBlocker {
    CommitPreflightNotReady,
    RemoteTargetMissing,
}

pub fn git_push_admission_records(input: GitPushAdmissionInput) -> GitPushAdmissionSet {
    let remote_target = input.remote_target;
    let mut admissions = input
        .preflights
        .preflights
        .into_iter()
        .map(|preflight| admission_record(&remote_target, preflight))
        .collect::<Vec<_>>();
    admissions.sort_by(|left, right| left.admission_id.cmp(&right.admission_id));

    GitPushAdmissionSet {
        admission_set_id: "git-push-admission-records".to_owned(),
        skipped_preflight_ids: admissions
            .iter()
            .filter(|admission| admission.status != GitPushAdmissionStatus::Admitted)
            .map(|admission| admission.commit_preflight_id.clone())
            .collect(),
        admissions,
        push_executed: false,
        pull_request_created: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}

fn admission_record(
    remote_target: &Option<GitPushRemoteTarget>,
    preflight: GitCommitPreflightRecord,
) -> GitPushAdmissionRecord {
    let blockers = blockers(remote_target, &preflight);
    let status = if blockers.is_empty() {
        GitPushAdmissionStatus::Admitted
    } else {
        GitPushAdmissionStatus::Blocked
    };

    GitPushAdmissionRecord {
        admission_id: format!("git-push-admission:{}", preflight.preflight_id),
        commit_preflight_id: preflight.preflight_id,
        commit_descriptor_id: preflight.descriptor_id,
        commit_admission_id: preflight.admission_id,
        branch_worktree_evidence_id: preflight.branch_worktree_evidence_id,
        branch_worktree_outcome_id: preflight.branch_worktree_outcome_id,
        branch_worktree_handoff_id: preflight.branch_worktree_handoff_id,
        branch_worktree_preflight_id: preflight.branch_worktree_preflight_id,
        branch_worktree_descriptor_id: preflight.branch_worktree_descriptor_id,
        branch_worktree_admission_id: preflight.branch_worktree_admission_id,
        dry_run_evidence_id: preflight.dry_run_evidence_id,
        dry_run_outcome_id: preflight.dry_run_outcome_id,
        dry_run_handoff_id: preflight.dry_run_handoff_id,
        request_id: preflight.request_id,
        authority_id: preflight.authority_id,
        git_plan_id: preflight.git_plan_id,
        task_id: preflight.task_id,
        repo_id: preflight.repo_id,
        operator_ref: preflight.operator_ref,
        commit_message_source: preflight.commit_message_source,
        remote_target: remote_target.clone(),
        status,
        blockers,
        push_executed: false,
        pull_request_created: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}

fn blockers(
    remote_target: &Option<GitPushRemoteTarget>,
    preflight: &GitCommitPreflightRecord,
) -> Vec<GitPushAdmissionBlocker> {
    let mut blockers = Vec::new();
    if preflight.status != GitCommitPreflightStatus::Ready {
        blockers.push(GitPushAdmissionBlocker::CommitPreflightNotReady);
    }
    if remote_target.is_none() {
        blockers.push(GitPushAdmissionBlocker::RemoteTargetMissing);
    }
    blockers
}

#[cfg(test)]
mod tests;
