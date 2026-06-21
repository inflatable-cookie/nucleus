//! Preflight records for Git push command descriptors.

use serde::{Deserialize, Serialize};

use crate::{
    GitPushCommandDescriptorRecord, GitPushCommandDescriptorSet, GitPushCommandDescriptorStatus,
    GitPushRemoteTarget,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitPushPreflightInput {
    pub descriptors: GitPushCommandDescriptorSet,
    pub operator_confirmed: bool,
    pub remote_ready: bool,
    pub credential_ready: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitPushPreflightSet {
    pub preflight_set_id: String,
    pub preflights: Vec<GitPushPreflightRecord>,
    pub skipped_descriptor_ids: Vec<String>,
    pub shell_handoff_created: bool,
    pub push_executed: bool,
    pub pull_request_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitPushPreflightRecord {
    pub preflight_id: String,
    pub descriptor_id: String,
    pub admission_id: String,
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
    pub status: GitPushPreflightStatus,
    pub blockers: Vec<GitPushPreflightBlocker>,
    pub shell_handoff_created: bool,
    pub push_executed: bool,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitPushPreflightStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitPushPreflightBlocker {
    DescriptorNotReady,
    OperatorConfirmationMissing,
    RemoteNotReady,
    CredentialNotReady,
}

pub fn git_push_preflight_records(input: GitPushPreflightInput) -> GitPushPreflightSet {
    let checks = GitPushPreflightChecks {
        operator_confirmed: input.operator_confirmed,
        remote_ready: input.remote_ready,
        credential_ready: input.credential_ready,
    };
    let mut preflights = input
        .descriptors
        .descriptors
        .into_iter()
        .map(|descriptor| preflight_record(&checks, descriptor))
        .collect::<Vec<_>>();
    preflights.sort_by(|left, right| left.preflight_id.cmp(&right.preflight_id));

    GitPushPreflightSet {
        preflight_set_id: "git-push-preflight-records".to_owned(),
        skipped_descriptor_ids: preflights
            .iter()
            .filter(|preflight| preflight.status != GitPushPreflightStatus::Ready)
            .map(|preflight| preflight.descriptor_id.clone())
            .collect(),
        preflights,
        shell_handoff_created: false,
        push_executed: false,
        pull_request_created: false,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GitPushPreflightChecks {
    operator_confirmed: bool,
    remote_ready: bool,
    credential_ready: bool,
}

fn preflight_record(
    checks: &GitPushPreflightChecks,
    descriptor: GitPushCommandDescriptorRecord,
) -> GitPushPreflightRecord {
    let blockers = blockers(checks, &descriptor);
    let status = if blockers.is_empty() {
        GitPushPreflightStatus::Ready
    } else {
        GitPushPreflightStatus::Blocked
    };

    GitPushPreflightRecord {
        preflight_id: format!("git-push-preflight:{}", descriptor.descriptor_id),
        descriptor_id: descriptor.descriptor_id,
        admission_id: descriptor.admission_id,
        commit_preflight_id: descriptor.commit_preflight_id,
        commit_descriptor_id: descriptor.commit_descriptor_id,
        commit_admission_id: descriptor.commit_admission_id,
        branch_worktree_evidence_id: descriptor.branch_worktree_evidence_id,
        request_id: descriptor.request_id,
        authority_id: descriptor.authority_id,
        git_plan_id: descriptor.git_plan_id,
        task_id: descriptor.task_id,
        repo_id: descriptor.repo_id,
        operator_ref: descriptor.operator_ref,
        remote_target: descriptor.remote_target,
        status,
        blockers,
        shell_handoff_created: false,
        push_executed: false,
        pull_request_created: false,
        forge_effect_executed: false,
        raw_output_retained: false,
    }
}

fn blockers(
    checks: &GitPushPreflightChecks,
    descriptor: &GitPushCommandDescriptorRecord,
) -> Vec<GitPushPreflightBlocker> {
    let mut blockers = Vec::new();
    if descriptor.status != GitPushCommandDescriptorStatus::Ready {
        blockers.push(GitPushPreflightBlocker::DescriptorNotReady);
    }
    if !checks.operator_confirmed {
        blockers.push(GitPushPreflightBlocker::OperatorConfirmationMissing);
    }
    if !checks.remote_ready {
        blockers.push(GitPushPreflightBlocker::RemoteNotReady);
    }
    if !checks.credential_ready {
        blockers.push(GitPushPreflightBlocker::CredentialNotReady);
    }
    blockers
}

#[cfg(test)]
mod tests;
