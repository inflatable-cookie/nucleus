//! Data-only command descriptors for admitted Git push records.

use serde::{Deserialize, Serialize};

use crate::{
    GitPushAdmissionRecord, GitPushAdmissionSet, GitPushAdmissionStatus, GitPushRemoteTarget,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitPushCommandDescriptorsInput {
    pub admissions: GitPushAdmissionSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitPushCommandDescriptorSet {
    pub descriptor_set_id: String,
    pub descriptors: Vec<GitPushCommandDescriptorRecord>,
    pub skipped_admission_ids: Vec<String>,
    pub executable_argv_created: bool,
    pub shell_handoff_created: bool,
    pub push_executed: bool,
    pub pull_request_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitPushCommandDescriptorRecord {
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
    pub command_kind: GitPushCommandKind,
    pub status: GitPushCommandDescriptorStatus,
    pub blockers: Vec<GitPushCommandDescriptorBlocker>,
    pub executable_argv_created: bool,
    pub shell_handoff_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitPushCommandKind {
    PushBranch,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitPushCommandDescriptorStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitPushCommandDescriptorBlocker {
    AdmissionNotAdmitted,
}

pub fn git_push_command_descriptors(
    input: GitPushCommandDescriptorsInput,
) -> GitPushCommandDescriptorSet {
    let mut descriptors = input
        .admissions
        .admissions
        .into_iter()
        .map(descriptor_record)
        .collect::<Vec<_>>();
    descriptors.sort_by(|left, right| left.descriptor_id.cmp(&right.descriptor_id));

    GitPushCommandDescriptorSet {
        descriptor_set_id: "git-push-command-descriptors".to_owned(),
        skipped_admission_ids: descriptors
            .iter()
            .filter(|descriptor| descriptor.status != GitPushCommandDescriptorStatus::Ready)
            .map(|descriptor| descriptor.admission_id.clone())
            .collect(),
        descriptors,
        executable_argv_created: false,
        shell_handoff_created: false,
        push_executed: false,
        pull_request_created: false,
    }
}

fn descriptor_record(admission: GitPushAdmissionRecord) -> GitPushCommandDescriptorRecord {
    let blockers = blockers(&admission);
    let status = if blockers.is_empty() {
        GitPushCommandDescriptorStatus::Ready
    } else {
        GitPushCommandDescriptorStatus::Blocked
    };

    GitPushCommandDescriptorRecord {
        descriptor_id: format!("git-push-command-descriptor:{}", admission.admission_id),
        admission_id: admission.admission_id,
        commit_preflight_id: admission.commit_preflight_id,
        commit_descriptor_id: admission.commit_descriptor_id,
        commit_admission_id: admission.commit_admission_id,
        branch_worktree_evidence_id: admission.branch_worktree_evidence_id,
        request_id: admission.request_id,
        authority_id: admission.authority_id,
        git_plan_id: admission.git_plan_id,
        task_id: admission.task_id,
        repo_id: admission.repo_id,
        operator_ref: admission.operator_ref,
        remote_target: admission.remote_target,
        command_kind: GitPushCommandKind::PushBranch,
        status,
        blockers,
        executable_argv_created: false,
        shell_handoff_created: false,
    }
}

fn blockers(admission: &GitPushAdmissionRecord) -> Vec<GitPushCommandDescriptorBlocker> {
    let mut blockers = Vec::new();
    if admission.status != GitPushAdmissionStatus::Admitted {
        blockers.push(GitPushCommandDescriptorBlocker::AdmissionNotAdmitted);
    }
    blockers
}

#[cfg(test)]
mod tests;
