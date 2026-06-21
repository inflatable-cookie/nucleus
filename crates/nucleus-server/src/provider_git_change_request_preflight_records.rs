//! Preflight records for Git change-request command requests.

use serde::{Deserialize, Serialize};

use crate::{
    GitChangeRequestCommandRequestRecord, GitChangeRequestCommandRequestSet,
    GitChangeRequestCommandRequestStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitChangeRequestPreflightRecordsInput {
    pub requests: GitChangeRequestCommandRequestSet,
    pub working_tree_available: bool,
    pub operator_confirmed: bool,
    pub dry_run_evidence_present: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitChangeRequestPreflightSet {
    pub preflight_set_id: String,
    pub preflights: Vec<GitChangeRequestPreflightRecord>,
    pub skipped_request_ids: Vec<String>,
    pub command_execution_enabled: bool,
    pub shell_command_created: bool,
    pub forge_request_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitChangeRequestPreflightRecord {
    pub preflight_id: String,
    pub request_id: String,
    pub descriptor_id: String,
    pub authority_id: String,
    pub git_plan_id: String,
    pub task_id: String,
    pub repo_id: String,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub status: GitChangeRequestPreflightStatus,
    pub blockers: Vec<GitChangeRequestPreflightBlocker>,
    pub preflight_passed: bool,
    pub command_execution_enabled: bool,
    pub shell_command_created: bool,
    pub forge_request_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeRequestPreflightStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeRequestPreflightBlocker {
    RequestNotAdmitted,
    WorkingTreeUnavailable,
    OperatorConfirmationMissing,
    DryRunEvidenceMissing,
}

pub fn git_change_request_preflight_records(
    input: GitChangeRequestPreflightRecordsInput,
) -> GitChangeRequestPreflightSet {
    let checks = GitChangeRequestPreflightChecks {
        working_tree_available: input.working_tree_available,
        operator_confirmed: input.operator_confirmed,
        dry_run_evidence_present: input.dry_run_evidence_present,
    };
    let mut preflights = input
        .requests
        .requests
        .into_iter()
        .map(|request| preflight_record(&checks, request))
        .collect::<Vec<_>>();
    preflights.sort_by(|left, right| left.preflight_id.cmp(&right.preflight_id));

    GitChangeRequestPreflightSet {
        preflight_set_id: "git-change-request-preflight-records".to_owned(),
        skipped_request_ids: preflights
            .iter()
            .filter(|preflight| preflight.status != GitChangeRequestPreflightStatus::Ready)
            .map(|preflight| preflight.request_id.clone())
            .collect(),
        preflights,
        command_execution_enabled: false,
        shell_command_created: false,
        forge_request_created: false,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GitChangeRequestPreflightChecks {
    working_tree_available: bool,
    operator_confirmed: bool,
    dry_run_evidence_present: bool,
}

fn preflight_record(
    checks: &GitChangeRequestPreflightChecks,
    request: GitChangeRequestCommandRequestRecord,
) -> GitChangeRequestPreflightRecord {
    let blockers = blockers(checks, &request);
    let status = if blockers.is_empty() {
        GitChangeRequestPreflightStatus::Ready
    } else {
        GitChangeRequestPreflightStatus::Blocked
    };
    let preflight_passed = status == GitChangeRequestPreflightStatus::Ready;

    GitChangeRequestPreflightRecord {
        preflight_id: format!("git-change-request-preflight:{}", request.request_id),
        request_id: request.request_id,
        descriptor_id: request.descriptor_id,
        authority_id: request.authority_id,
        git_plan_id: request.git_plan_id,
        task_id: request.task_id,
        repo_id: request.repo_id,
        operator_ref: request.operator_ref,
        evidence_refs: request.evidence_refs,
        status,
        blockers,
        preflight_passed,
        command_execution_enabled: false,
        shell_command_created: false,
        forge_request_created: false,
    }
}

fn blockers(
    checks: &GitChangeRequestPreflightChecks,
    request: &GitChangeRequestCommandRequestRecord,
) -> Vec<GitChangeRequestPreflightBlocker> {
    let mut blockers = Vec::new();
    if request.status != GitChangeRequestCommandRequestStatus::Admitted {
        blockers.push(GitChangeRequestPreflightBlocker::RequestNotAdmitted);
    }
    if !checks.working_tree_available {
        blockers.push(GitChangeRequestPreflightBlocker::WorkingTreeUnavailable);
    }
    if !checks.operator_confirmed {
        blockers.push(GitChangeRequestPreflightBlocker::OperatorConfirmationMissing);
    }
    if !checks.dry_run_evidence_present {
        blockers.push(GitChangeRequestPreflightBlocker::DryRunEvidenceMissing);
    }
    blockers
}

#[cfg(test)]
mod tests;
