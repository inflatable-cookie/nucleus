//! Reviewable evidence records for Git change-request dry-run outcomes.

use serde::{Deserialize, Serialize};

use crate::{
    GitChangeRequestDryRunOutcomeStatus, GitChangeRequestDryRunSanitizedOutcomeRecord,
    GitChangeRequestDryRunSanitizedOutcomeSet,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitChangeRequestDryRunEvidenceInput {
    pub outcomes: GitChangeRequestDryRunSanitizedOutcomeSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitChangeRequestDryRunEvidenceSet {
    pub evidence_set_id: String,
    pub evidence: Vec<GitChangeRequestDryRunEvidenceRecord>,
    pub skipped_outcome_ids: Vec<String>,
    pub raw_output_retained: bool,
    pub git_mutation_executed: bool,
    pub forge_effect_executed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitChangeRequestDryRunEvidenceRecord {
    pub evidence_id: String,
    pub outcome_id: String,
    pub handoff_id: String,
    pub request_id: String,
    pub descriptor_id: String,
    pub authority_id: String,
    pub git_plan_id: String,
    pub task_id: String,
    pub repo_id: String,
    pub operator_ref: String,
    pub source_evidence_refs: Vec<String>,
    pub status: GitChangeRequestDryRunEvidenceStatus,
    pub blockers: Vec<GitChangeRequestDryRunEvidenceBlocker>,
    pub changed_path_count: usize,
    pub insertion_count: usize,
    pub deletion_count: usize,
    pub raw_output_retained: bool,
    pub git_mutation_executed: bool,
    pub forge_effect_executed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeRequestDryRunEvidenceStatus {
    Reviewable,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeRequestDryRunEvidenceBlocker {
    OutcomeNotCompleted,
}

pub fn git_change_request_dry_run_evidence(
    input: GitChangeRequestDryRunEvidenceInput,
) -> GitChangeRequestDryRunEvidenceSet {
    let mut evidence = input
        .outcomes
        .outcomes
        .into_iter()
        .map(evidence_record)
        .collect::<Vec<_>>();
    evidence.sort_by(|left, right| left.evidence_id.cmp(&right.evidence_id));

    GitChangeRequestDryRunEvidenceSet {
        evidence_set_id: "git-change-request-dry-run-evidence".to_owned(),
        skipped_outcome_ids: evidence
            .iter()
            .filter(|record| record.status != GitChangeRequestDryRunEvidenceStatus::Reviewable)
            .map(|record| record.outcome_id.clone())
            .collect(),
        evidence,
        raw_output_retained: false,
        git_mutation_executed: false,
        forge_effect_executed: false,
    }
}

fn evidence_record(
    outcome: GitChangeRequestDryRunSanitizedOutcomeRecord,
) -> GitChangeRequestDryRunEvidenceRecord {
    let blockers = blockers(&outcome);
    let status = if blockers.is_empty() {
        GitChangeRequestDryRunEvidenceStatus::Reviewable
    } else {
        GitChangeRequestDryRunEvidenceStatus::Blocked
    };

    GitChangeRequestDryRunEvidenceRecord {
        evidence_id: format!("git-change-request-dry-run-evidence:{}", outcome.outcome_id),
        outcome_id: outcome.outcome_id,
        handoff_id: outcome.handoff_id,
        request_id: outcome.request_id,
        descriptor_id: outcome.descriptor_id,
        authority_id: outcome.authority_id,
        git_plan_id: outcome.git_plan_id,
        task_id: outcome.task_id,
        repo_id: outcome.repo_id,
        operator_ref: outcome.operator_ref,
        source_evidence_refs: outcome.evidence_refs,
        status,
        blockers,
        changed_path_count: outcome.changed_path_count,
        insertion_count: outcome.insertion_count,
        deletion_count: outcome.deletion_count,
        raw_output_retained: false,
        git_mutation_executed: false,
        forge_effect_executed: false,
    }
}

fn blockers(
    outcome: &GitChangeRequestDryRunSanitizedOutcomeRecord,
) -> Vec<GitChangeRequestDryRunEvidenceBlocker> {
    let mut blockers = Vec::new();
    if outcome.status != GitChangeRequestDryRunOutcomeStatus::Completed {
        blockers.push(GitChangeRequestDryRunEvidenceBlocker::OutcomeNotCompleted);
    }
    blockers
}

#[cfg(test)]
mod tests;
