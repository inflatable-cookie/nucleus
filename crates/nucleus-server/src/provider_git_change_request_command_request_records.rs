//! Stopped-by-default command request records for Git change requests.

use serde::{Deserialize, Serialize};

use crate::{
    GitChangeRequestCommandDescriptorRecord, GitChangeRequestCommandDescriptorSet,
    GitChangeRequestCommandDescriptorStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitChangeRequestCommandRequestRecordsInput {
    pub descriptors: GitChangeRequestCommandDescriptorSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitChangeRequestCommandRequestSet {
    pub request_set_id: String,
    pub requests: Vec<GitChangeRequestCommandRequestRecord>,
    pub skipped_descriptor_ids: Vec<String>,
    pub command_execution_enabled: bool,
    pub shell_command_created: bool,
    pub forge_request_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitChangeRequestCommandRequestRecord {
    pub request_id: String,
    pub descriptor_id: String,
    pub authority_id: String,
    pub git_plan_id: String,
    pub task_id: String,
    pub repo_id: String,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub idempotency_key: String,
    pub status: GitChangeRequestCommandRequestStatus,
    pub blockers: Vec<GitChangeRequestCommandRequestBlocker>,
    pub command_execution_enabled: bool,
    pub shell_command_created: bool,
    pub forge_request_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeRequestCommandRequestStatus {
    Admitted,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeRequestCommandRequestBlocker {
    DescriptorNotReady,
}

pub fn git_change_request_command_request_records(
    input: GitChangeRequestCommandRequestRecordsInput,
) -> GitChangeRequestCommandRequestSet {
    let mut requests = input
        .descriptors
        .descriptors
        .into_iter()
        .map(request_record)
        .collect::<Vec<_>>();
    requests.sort_by(|left, right| left.request_id.cmp(&right.request_id));

    GitChangeRequestCommandRequestSet {
        request_set_id: "git-change-request-command-request-records".to_owned(),
        skipped_descriptor_ids: requests
            .iter()
            .filter(|request| request.status != GitChangeRequestCommandRequestStatus::Admitted)
            .map(|request| request.descriptor_id.clone())
            .collect(),
        requests,
        command_execution_enabled: false,
        shell_command_created: false,
        forge_request_created: false,
    }
}

fn request_record(
    descriptor: GitChangeRequestCommandDescriptorRecord,
) -> GitChangeRequestCommandRequestRecord {
    let blockers = blockers(&descriptor);
    let status = if blockers.is_empty() {
        GitChangeRequestCommandRequestStatus::Admitted
    } else {
        GitChangeRequestCommandRequestStatus::Blocked
    };

    GitChangeRequestCommandRequestRecord {
        request_id: format!(
            "git-change-request-command-request:{}",
            descriptor.descriptor_id
        ),
        idempotency_key: format!("idempotency:{}", descriptor.descriptor_id),
        descriptor_id: descriptor.descriptor_id,
        authority_id: descriptor.authority_id,
        git_plan_id: descriptor.git_plan_id,
        task_id: descriptor.task_id,
        repo_id: descriptor.repo_id,
        operator_ref: descriptor.operator_ref,
        evidence_refs: descriptor.evidence_refs,
        status,
        blockers,
        command_execution_enabled: false,
        shell_command_created: false,
        forge_request_created: false,
    }
}

fn blockers(
    descriptor: &GitChangeRequestCommandDescriptorRecord,
) -> Vec<GitChangeRequestCommandRequestBlocker> {
    let mut blockers = Vec::new();
    if descriptor.status != GitChangeRequestCommandDescriptorStatus::Ready {
        blockers.push(GitChangeRequestCommandRequestBlocker::DescriptorNotReady);
    }
    blockers
}

#[cfg(test)]
mod tests;
