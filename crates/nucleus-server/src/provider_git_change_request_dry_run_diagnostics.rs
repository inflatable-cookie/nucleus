//! Read-only diagnostics for Git change-request dry-run runner records.

use serde::{Deserialize, Serialize};

use crate::{
    GitChangeRequestDryRunEvidenceSet, GitChangeRequestDryRunEvidenceStatus,
    GitChangeRequestDryRunHandoffSet, GitChangeRequestDryRunHandoffStatus,
    GitChangeRequestDryRunOutcomeStatus, GitChangeRequestDryRunSanitizedOutcomeSet,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitChangeRequestDryRunDiagnosticsInput {
    pub handoffs: GitChangeRequestDryRunHandoffSet,
    pub outcomes: GitChangeRequestDryRunSanitizedOutcomeSet,
    pub evidence: GitChangeRequestDryRunEvidenceSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitChangeRequestDryRunDiagnosticsRecord {
    pub diagnostics_id: String,
    pub handoff_count: usize,
    pub handoff_admitted_count: usize,
    pub outcome_count: usize,
    pub outcome_completed_count: usize,
    pub evidence_count: usize,
    pub evidence_reviewable_count: usize,
    pub blocker_count: usize,
    pub changed_path_count: usize,
    pub insertion_count: usize,
    pub deletion_count: usize,
    pub shell_execution_performed: bool,
    pub git_mutation_executed: bool,
    pub forge_effect_executed: bool,
    pub raw_output_retained: bool,
}

pub fn git_change_request_dry_run_diagnostics(
    input: GitChangeRequestDryRunDiagnosticsInput,
) -> GitChangeRequestDryRunDiagnosticsRecord {
    GitChangeRequestDryRunDiagnosticsRecord {
        diagnostics_id: "git-change-request-dry-run-diagnostics".to_owned(),
        handoff_count: input.handoffs.handoffs.len(),
        handoff_admitted_count: input
            .handoffs
            .handoffs
            .iter()
            .filter(|handoff| handoff.status == GitChangeRequestDryRunHandoffStatus::Admitted)
            .count(),
        outcome_count: input.outcomes.outcomes.len(),
        outcome_completed_count: input
            .outcomes
            .outcomes
            .iter()
            .filter(|outcome| outcome.status == GitChangeRequestDryRunOutcomeStatus::Completed)
            .count(),
        evidence_count: input.evidence.evidence.len(),
        evidence_reviewable_count: input
            .evidence
            .evidence
            .iter()
            .filter(|evidence| evidence.status == GitChangeRequestDryRunEvidenceStatus::Reviewable)
            .count(),
        blocker_count: input
            .handoffs
            .handoffs
            .iter()
            .map(|handoff| handoff.blockers.len())
            .sum::<usize>()
            + input
                .outcomes
                .outcomes
                .iter()
                .map(|outcome| outcome.blockers.len())
                .sum::<usize>()
            + input
                .evidence
                .evidence
                .iter()
                .map(|evidence| evidence.blockers.len())
                .sum::<usize>(),
        changed_path_count: input
            .outcomes
            .outcomes
            .iter()
            .map(|outcome| outcome.changed_path_count)
            .sum(),
        insertion_count: input
            .outcomes
            .outcomes
            .iter()
            .map(|outcome| outcome.insertion_count)
            .sum(),
        deletion_count: input
            .outcomes
            .outcomes
            .iter()
            .map(|outcome| outcome.deletion_count)
            .sum(),
        shell_execution_performed: false,
        git_mutation_executed: false,
        forge_effect_executed: false,
        raw_output_retained: false,
    }
}

#[cfg(test)]
mod tests;
