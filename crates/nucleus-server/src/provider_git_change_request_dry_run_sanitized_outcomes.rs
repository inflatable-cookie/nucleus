//! Sanitized outcome records for Git change-request dry-run handoffs.

use serde::{Deserialize, Serialize};

use crate::{
    GitChangeRequestDryRunHandoffRecord, GitChangeRequestDryRunHandoffSet,
    GitChangeRequestDryRunHandoffStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitChangeRequestDryRunSanitizedOutcomesInput {
    pub handoffs: GitChangeRequestDryRunHandoffSet,
    pub requested_status: GitChangeRequestDryRunOutcomeStatus,
    pub changed_path_count: usize,
    pub insertion_count: usize,
    pub deletion_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitChangeRequestDryRunSanitizedOutcomeSet {
    pub outcome_set_id: String,
    pub outcomes: Vec<GitChangeRequestDryRunSanitizedOutcomeRecord>,
    pub skipped_handoff_ids: Vec<String>,
    pub git_dry_run_executed: bool,
    pub git_mutation_executed: bool,
    pub forge_effect_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitChangeRequestDryRunSanitizedOutcomeRecord {
    pub outcome_id: String,
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
    pub status: GitChangeRequestDryRunOutcomeStatus,
    pub blockers: Vec<GitChangeRequestDryRunOutcomeBlocker>,
    pub changed_path_count: usize,
    pub insertion_count: usize,
    pub deletion_count: usize,
    pub git_dry_run_executed: bool,
    pub git_mutation_executed: bool,
    pub forge_effect_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeRequestDryRunOutcomeStatus {
    Completed,
    Blocked,
    Failed,
    TimedOut,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeRequestDryRunOutcomeBlocker {
    HandoffNotAdmitted,
}

pub fn git_change_request_dry_run_sanitized_outcomes(
    input: GitChangeRequestDryRunSanitizedOutcomesInput,
) -> GitChangeRequestDryRunSanitizedOutcomeSet {
    let summary = GitChangeRequestDryRunOutcomeSummary {
        requested_status: input.requested_status,
        changed_path_count: input.changed_path_count,
        insertion_count: input.insertion_count,
        deletion_count: input.deletion_count,
    };
    let mut outcomes = input
        .handoffs
        .handoffs
        .into_iter()
        .map(|handoff| outcome_record(&summary, handoff))
        .collect::<Vec<_>>();
    outcomes.sort_by(|left, right| left.outcome_id.cmp(&right.outcome_id));

    GitChangeRequestDryRunSanitizedOutcomeSet {
        outcome_set_id: "git-change-request-dry-run-sanitized-outcomes".to_owned(),
        skipped_handoff_ids: outcomes
            .iter()
            .filter(|outcome| outcome.status == GitChangeRequestDryRunOutcomeStatus::Blocked)
            .map(|outcome| outcome.handoff_id.clone())
            .collect(),
        git_dry_run_executed: false,
        git_mutation_executed: false,
        forge_effect_executed: false,
        raw_output_retained: false,
        outcomes,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GitChangeRequestDryRunOutcomeSummary {
    requested_status: GitChangeRequestDryRunOutcomeStatus,
    changed_path_count: usize,
    insertion_count: usize,
    deletion_count: usize,
}

fn outcome_record(
    summary: &GitChangeRequestDryRunOutcomeSummary,
    handoff: GitChangeRequestDryRunHandoffRecord,
) -> GitChangeRequestDryRunSanitizedOutcomeRecord {
    let blockers = blockers(&handoff);
    let status = if blockers.is_empty() {
        summary.requested_status.clone()
    } else {
        GitChangeRequestDryRunOutcomeStatus::Blocked
    };

    GitChangeRequestDryRunSanitizedOutcomeRecord {
        outcome_id: format!("git-change-request-dry-run-outcome:{}", handoff.handoff_id),
        handoff_id: handoff.handoff_id,
        preflight_id: handoff.preflight_id,
        request_id: handoff.request_id,
        descriptor_id: handoff.descriptor_id,
        authority_id: handoff.authority_id,
        git_plan_id: handoff.git_plan_id,
        task_id: handoff.task_id,
        repo_id: handoff.repo_id,
        operator_ref: handoff.operator_ref,
        evidence_refs: handoff.evidence_refs,
        status,
        blockers,
        changed_path_count: summary.changed_path_count,
        insertion_count: summary.insertion_count,
        deletion_count: summary.deletion_count,
        git_dry_run_executed: false,
        git_mutation_executed: false,
        forge_effect_executed: false,
        raw_output_retained: false,
    }
}

fn blockers(
    handoff: &GitChangeRequestDryRunHandoffRecord,
) -> Vec<GitChangeRequestDryRunOutcomeBlocker> {
    let mut blockers = Vec::new();
    if handoff.status != GitChangeRequestDryRunHandoffStatus::Admitted {
        blockers.push(GitChangeRequestDryRunOutcomeBlocker::HandoffNotAdmitted);
    }
    blockers
}

#[cfg(test)]
mod tests;
