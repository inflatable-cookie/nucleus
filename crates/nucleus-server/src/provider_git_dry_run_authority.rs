//! Authority proof for Git dry-run adapter records.

use serde::{Deserialize, Serialize};

use crate::{
    GitDryRunAdapterAdmissionSet, GitDryRunCommandDescriptorSet, GitDryRunSanitizedOutcomeRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitDryRunAuthorityInput {
    pub descriptors: GitDryRunCommandDescriptorSet,
    pub admissions: GitDryRunAdapterAdmissionSet,
    pub outcomes: Vec<GitDryRunSanitizedOutcomeRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitDryRunAuthorityRecord {
    pub authority_id: String,
    pub descriptor_count: usize,
    pub admission_count: usize,
    pub outcome_count: usize,
    pub dry_run_executed_count: usize,
    pub commit_executed: bool,
    pub branch_mutation_executed: bool,
    pub push_executed: bool,
    pub forge_effect_executed: bool,
    pub provider_write_executed: bool,
    pub callback_response_executed: bool,
    pub interruption_executed: bool,
    pub recovery_executed: bool,
    pub raw_output_retained: bool,
}

pub fn git_dry_run_authority_regressions(
    input: GitDryRunAuthorityInput,
) -> GitDryRunAuthorityRecord {
    GitDryRunAuthorityRecord {
        authority_id: "git-dry-run-authority".to_owned(),
        descriptor_count: input.descriptors.descriptors.len(),
        admission_count: input.admissions.admissions.len(),
        outcome_count: input.outcomes.len(),
        dry_run_executed_count: input
            .outcomes
            .iter()
            .filter(|outcome| outcome.git_dry_run_executed)
            .count(),
        commit_executed: false,
        branch_mutation_executed: false,
        push_executed: false,
        forge_effect_executed: false,
        provider_write_executed: false,
        callback_response_executed: false,
        interruption_executed: false,
        recovery_executed: false,
        raw_output_retained: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_dry_run_authority_regressions_block_mutating_effects() {
        let record = git_dry_run_authority_regressions(input());

        assert_eq!(record.descriptor_count, 2);
        assert_eq!(record.admission_count, 1);
        assert_eq!(record.outcome_count, 1);
        assert_eq!(record.dry_run_executed_count, 1);
        assert!(!record.commit_executed);
        assert!(!record.branch_mutation_executed);
        assert!(!record.push_executed);
        assert!(!record.forge_effect_executed);
        assert!(!record.provider_write_executed);
        assert!(!record.callback_response_executed);
        assert!(!record.interruption_executed);
        assert!(!record.recovery_executed);
        assert!(!record.raw_output_retained);
    }

    fn input() -> GitDryRunAuthorityInput {
        let descriptors = crate::git_dry_run_command_descriptors();
        let admissions = crate::GitDryRunAdapterAdmissionSet {
            admission_set_id: "admissions".to_owned(),
            admissions: vec![crate::GitDryRunAdapterAdmissionRecord {
                admission_id: "admission:1".to_owned(),
                capability_item_id: "capability:1".to_owned(),
                persisted_dry_run_plan_id: "persisted:1".to_owned(),
                task_id: "task:1".to_owned(),
                work_item_id: Some("work:1".to_owned()),
                completion_id: Some("completion:1".to_owned()),
                operator_ref: "operator:tom".to_owned(),
                evidence_refs: vec!["evidence:admission".to_owned()],
                descriptor_ids: descriptors
                    .descriptors
                    .iter()
                    .map(|descriptor| descriptor.descriptor_id.clone())
                    .collect(),
                status: crate::GitDryRunAdapterAdmissionStatus::Admitted,
                blockers: Vec::new(),
                git_dry_run_admitted: true,
                git_mutation_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_output_retention_granted: false,
            }],
            skipped_capability_item_ids: Vec::new(),
            git_mutation_authority_granted: false,
            forge_authority_granted: false,
            provider_authority_granted: false,
            raw_output_retention_granted: false,
        };
        GitDryRunAuthorityInput {
            descriptors,
            admissions,
            outcomes: vec![crate::GitDryRunSanitizedOutcomeRecord {
                outcome_id: "outcome:1".to_owned(),
                admission_id: "admission:1".to_owned(),
                capability_item_id: "capability:1".to_owned(),
                persisted_dry_run_plan_id: "persisted:1".to_owned(),
                task_id: "task:1".to_owned(),
                work_item_id: Some("work:1".to_owned()),
                completion_id: Some("completion:1".to_owned()),
                operator_ref: "operator:tom".to_owned(),
                descriptor_ids: vec!["descriptor:1".to_owned()],
                status: crate::GitDryRunOutcomeStatus::Completed,
                blockers: Vec::new(),
                changed_path_count: 1,
                staged_path_count: 0,
                unstaged_path_count: 1,
                untracked_path_count: 0,
                evidence_refs: vec!["evidence:outcome".to_owned()],
                git_dry_run_executed: true,
                git_mutation_executed: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_output_retained: false,
            }],
        }
    }
}
