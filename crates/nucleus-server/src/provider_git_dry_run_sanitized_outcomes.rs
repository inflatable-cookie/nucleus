//! Sanitized Git dry-run outcome records.

use serde::{Deserialize, Serialize};

use crate::{GitDryRunAdapterAdmissionRecord, GitDryRunAdapterAdmissionStatus};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitDryRunSanitizedOutcomeInput {
    pub admission: GitDryRunAdapterAdmissionRecord,
    pub status: GitDryRunOutcomeStatus,
    pub changed_path_count: usize,
    pub staged_path_count: usize,
    pub unstaged_path_count: usize,
    pub untracked_path_count: usize,
    pub evidence_refs: Vec<String>,
    pub raw_output_present: bool,
    pub commit_requested: bool,
    pub branch_mutation_requested: bool,
    pub push_requested: bool,
    pub forge_requested: bool,
    pub provider_write_requested: bool,
    pub callback_response_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitDryRunSanitizedOutcomeRecord {
    pub outcome_id: String,
    pub admission_id: String,
    pub capability_item_id: String,
    pub persisted_dry_run_plan_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub operator_ref: String,
    pub descriptor_ids: Vec<String>,
    pub status: GitDryRunOutcomeStatus,
    pub blockers: Vec<GitDryRunSanitizedOutcomeBlocker>,
    pub changed_path_count: usize,
    pub staged_path_count: usize,
    pub unstaged_path_count: usize,
    pub untracked_path_count: usize,
    pub evidence_refs: Vec<String>,
    pub git_dry_run_executed: bool,
    pub git_mutation_executed: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitDryRunOutcomeStatus {
    Completed,
    Failed,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitDryRunSanitizedOutcomeBlocker {
    AdmissionNotAccepted,
    EvidenceRefsMissing,
    RawOutputPresent,
    CommitRequested,
    BranchMutationRequested,
    PushRequested,
    ForgeRequested,
    ProviderWriteRequested,
    CallbackResponseRequested,
    InterruptionRequested,
    RecoveryRequested,
}

pub fn git_dry_run_sanitized_outcome(
    input: GitDryRunSanitizedOutcomeInput,
) -> GitDryRunSanitizedOutcomeRecord {
    let blockers = blockers(&input);
    let status = if blockers.is_empty() {
        input.status
    } else {
        GitDryRunOutcomeStatus::Blocked
    };

    GitDryRunSanitizedOutcomeRecord {
        outcome_id: format!("git-dry-run-outcome:{}", input.admission.admission_id),
        admission_id: input.admission.admission_id,
        capability_item_id: input.admission.capability_item_id,
        persisted_dry_run_plan_id: input.admission.persisted_dry_run_plan_id,
        task_id: input.admission.task_id,
        work_item_id: input.admission.work_item_id,
        completion_id: input.admission.completion_id,
        operator_ref: input.admission.operator_ref,
        descriptor_ids: input.admission.descriptor_ids,
        status,
        blockers,
        changed_path_count: input.changed_path_count,
        staged_path_count: input.staged_path_count,
        unstaged_path_count: input.unstaged_path_count,
        untracked_path_count: input.untracked_path_count,
        evidence_refs: unique_sorted(input.evidence_refs),
        git_dry_run_executed: true,
        git_mutation_executed: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_output_retained: false,
    }
}

fn blockers(input: &GitDryRunSanitizedOutcomeInput) -> Vec<GitDryRunSanitizedOutcomeBlocker> {
    let mut blockers = Vec::new();
    if input.admission.status != GitDryRunAdapterAdmissionStatus::Admitted {
        blockers.push(GitDryRunSanitizedOutcomeBlocker::AdmissionNotAccepted);
    }
    if input.evidence_refs.is_empty() {
        blockers.push(GitDryRunSanitizedOutcomeBlocker::EvidenceRefsMissing);
    }
    if input.raw_output_present {
        blockers.push(GitDryRunSanitizedOutcomeBlocker::RawOutputPresent);
    }
    if input.commit_requested {
        blockers.push(GitDryRunSanitizedOutcomeBlocker::CommitRequested);
    }
    if input.branch_mutation_requested {
        blockers.push(GitDryRunSanitizedOutcomeBlocker::BranchMutationRequested);
    }
    if input.push_requested {
        blockers.push(GitDryRunSanitizedOutcomeBlocker::PushRequested);
    }
    if input.forge_requested {
        blockers.push(GitDryRunSanitizedOutcomeBlocker::ForgeRequested);
    }
    if input.provider_write_requested {
        blockers.push(GitDryRunSanitizedOutcomeBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested {
        blockers.push(GitDryRunSanitizedOutcomeBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested {
        blockers.push(GitDryRunSanitizedOutcomeBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(GitDryRunSanitizedOutcomeBlocker::RecoveryRequested);
    }
    blockers
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_dry_run_sanitized_outcomes_keep_refs_and_counts_only() {
        let record = git_dry_run_sanitized_outcome(input(false));

        assert_eq!(record.status, GitDryRunOutcomeStatus::Completed);
        assert_eq!(record.changed_path_count, 3);
        assert_eq!(record.staged_path_count, 1);
        assert!(record.git_dry_run_executed);
        assert!(!record.git_mutation_executed);
        assert!(!record.raw_output_retained);
    }

    #[test]
    fn git_dry_run_sanitized_outcomes_block_raw_or_mutating_requests() {
        let record = git_dry_run_sanitized_outcome(input(true));

        assert_eq!(record.status, GitDryRunOutcomeStatus::Blocked);
        assert!(record
            .blockers
            .contains(&GitDryRunSanitizedOutcomeBlocker::RawOutputPresent));
        assert!(record
            .blockers
            .contains(&GitDryRunSanitizedOutcomeBlocker::CommitRequested));
        assert!(!record.git_mutation_executed);
        assert!(!record.raw_output_retained);
    }

    fn input(blocked: bool) -> GitDryRunSanitizedOutcomeInput {
        GitDryRunSanitizedOutcomeInput {
            admission: GitDryRunAdapterAdmissionRecord {
                admission_id: "admission:1".to_owned(),
                capability_item_id: "capability:1".to_owned(),
                persisted_dry_run_plan_id: "persisted:1".to_owned(),
                task_id: "task:1".to_owned(),
                work_item_id: Some("work:1".to_owned()),
                completion_id: Some("completion:1".to_owned()),
                operator_ref: "operator:tom".to_owned(),
                evidence_refs: vec!["evidence:admission".to_owned()],
                descriptor_ids: vec!["descriptor:1".to_owned()],
                status: GitDryRunAdapterAdmissionStatus::Admitted,
                blockers: Vec::new(),
                git_dry_run_admitted: true,
                git_mutation_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_output_retention_granted: false,
            },
            status: GitDryRunOutcomeStatus::Completed,
            changed_path_count: 3,
            staged_path_count: 1,
            unstaged_path_count: 1,
            untracked_path_count: 1,
            evidence_refs: vec!["evidence:outcome".to_owned()],
            raw_output_present: blocked,
            commit_requested: blocked,
            branch_mutation_requested: false,
            push_requested: false,
            forge_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        }
    }
}
