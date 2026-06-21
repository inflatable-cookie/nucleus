//! Runner handoff records for Git change-request dry runs.

use serde::{Deserialize, Serialize};

use crate::{
    GitChangeRequestPreflightRecord, GitChangeRequestPreflightSet, GitChangeRequestPreflightStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitChangeRequestDryRunHandoffInput {
    pub preflights: GitChangeRequestPreflightSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitChangeRequestDryRunHandoffSet {
    pub handoff_set_id: String,
    pub handoffs: Vec<GitChangeRequestDryRunHandoffRecord>,
    pub skipped_preflight_ids: Vec<String>,
    pub shell_execution_performed: bool,
    pub branch_created: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitChangeRequestDryRunHandoffRecord {
    pub handoff_id: String,
    pub preflight_id: String,
    pub request_id: String,
    pub descriptor_id: String,
    pub authority_id: String,
    pub git_plan_id: String,
    pub task_id: String,
    pub repo_id: String,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub status: GitChangeRequestDryRunHandoffStatus,
    pub blockers: Vec<GitChangeRequestDryRunHandoffBlocker>,
    pub runner_handoff_admitted: bool,
    pub shell_execution_performed: bool,
    pub branch_created: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeRequestDryRunHandoffStatus {
    Admitted,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeRequestDryRunHandoffBlocker {
    PreflightNotReady,
}

pub fn git_change_request_dry_run_handoff(
    input: GitChangeRequestDryRunHandoffInput,
) -> GitChangeRequestDryRunHandoffSet {
    let mut handoffs = input
        .preflights
        .preflights
        .into_iter()
        .map(handoff_record)
        .collect::<Vec<_>>();
    handoffs.sort_by(|left, right| left.handoff_id.cmp(&right.handoff_id));

    GitChangeRequestDryRunHandoffSet {
        handoff_set_id: "git-change-request-dry-run-handoff".to_owned(),
        skipped_preflight_ids: handoffs
            .iter()
            .filter(|handoff| handoff.status != GitChangeRequestDryRunHandoffStatus::Admitted)
            .map(|handoff| handoff.preflight_id.clone())
            .collect(),
        handoffs,
        shell_execution_performed: false,
        branch_created: false,
        commit_created: false,
        push_executed: false,
        pull_request_created: false,
        forge_effect_executed: false,
        raw_output_retained: false,
    }
}

fn handoff_record(
    preflight: GitChangeRequestPreflightRecord,
) -> GitChangeRequestDryRunHandoffRecord {
    let blockers = blockers(&preflight);
    let status = if blockers.is_empty() {
        GitChangeRequestDryRunHandoffStatus::Admitted
    } else {
        GitChangeRequestDryRunHandoffStatus::Blocked
    };
    let runner_handoff_admitted = status == GitChangeRequestDryRunHandoffStatus::Admitted;

    GitChangeRequestDryRunHandoffRecord {
        handoff_id: format!(
            "git-change-request-dry-run-handoff:{}",
            preflight.preflight_id
        ),
        preflight_id: preflight.preflight_id,
        request_id: preflight.request_id,
        descriptor_id: preflight.descriptor_id,
        authority_id: preflight.authority_id,
        git_plan_id: preflight.git_plan_id,
        task_id: preflight.task_id,
        repo_id: preflight.repo_id,
        operator_ref: preflight.operator_ref,
        evidence_refs: preflight.evidence_refs,
        status,
        blockers,
        runner_handoff_admitted,
        shell_execution_performed: false,
        branch_created: false,
        commit_created: false,
        push_executed: false,
        pull_request_created: false,
        forge_effect_executed: false,
        raw_output_retained: false,
    }
}

fn blockers(
    preflight: &GitChangeRequestPreflightRecord,
) -> Vec<GitChangeRequestDryRunHandoffBlocker> {
    let mut blockers = Vec::new();
    if preflight.status != GitChangeRequestPreflightStatus::Ready {
        blockers.push(GitChangeRequestDryRunHandoffBlocker::PreflightNotReady);
    }
    blockers
}

#[cfg(test)]
mod tests;
