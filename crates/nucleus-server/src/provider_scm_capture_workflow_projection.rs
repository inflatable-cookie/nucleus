//! Replay-only SCM capture workflow projection records.

use serde::{Deserialize, Serialize};

use crate::{
    GitDryRunEvidenceCaptureStatus, GitDryRunExecutionPersistenceRecord,
    GitDryRunExecutionPersistenceStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmCaptureWorkflowProjectionInput {
    pub workflow_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub repo_id: String,
    pub adapter_label: String,
    pub completion_capture_ref: Option<String>,
    pub dry_run_plan_ref: Option<String>,
    pub git_execution: Option<GitDryRunExecutionPersistenceRecord>,
    pub diagnostics_ref: Option<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureWorkflowProjectionRecord {
    pub workflow_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub repo_id: String,
    pub adapter_label: String,
    pub completion_capture_ref: Option<String>,
    pub dry_run_plan_ref: Option<String>,
    pub git_execution_ref: Option<String>,
    pub diagnostics_ref: Option<String>,
    pub evidence_refs: Vec<String>,
    pub completion_capture_stage: ScmCaptureWorkflowStageState,
    pub dry_run_plan_stage: ScmCaptureWorkflowStageState,
    pub git_runner_stage: ScmCaptureWorkflowStageState,
    pub evidence_persistence_stage: ScmCaptureWorkflowStageState,
    pub diagnostics_stage: ScmCaptureWorkflowStageState,
    pub workflow_ready_for_operator_review: bool,
    pub replay_only: bool,
    pub raw_output_retained: bool,
    pub scm_mutation_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureWorkflowStageState {
    Missing,
    Ready,
    Completed,
    Blocked,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureWorkflowDiagnosticsRecord {
    pub diagnostics_id: String,
    pub workflow_count: usize,
    pub ready_for_operator_review_count: usize,
    pub missing_stage_count: usize,
    pub completed_stage_count: usize,
    pub blocked_stage_count: usize,
    pub repair_required_stage_count: usize,
    pub evidence_ref_count: usize,
    pub replay_only: bool,
    pub raw_output_retained: bool,
    pub scm_mutation_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureWorkflowAuthorityRecord {
    pub authority_id: String,
    pub workflow_count: usize,
    pub replay_only: bool,
    pub checkout_executed: bool,
    pub branch_mutation_executed: bool,
    pub commit_executed: bool,
    pub push_executed: bool,
    pub forge_effect_executed: bool,
    pub provider_write_executed: bool,
    pub callback_response_executed: bool,
    pub interruption_executed: bool,
    pub recovery_executed: bool,
    pub raw_output_retained: bool,
}

pub fn scm_capture_workflow_projection(
    input: ScmCaptureWorkflowProjectionInput,
) -> ScmCaptureWorkflowProjectionRecord {
    let git_execution_ref = input
        .git_execution
        .as_ref()
        .map(|record| record.persisted_execution_id.clone());
    let git_runner_stage = input
        .git_execution
        .as_ref()
        .map(git_runner_stage)
        .unwrap_or(ScmCaptureWorkflowStageState::Missing);
    let evidence_persistence_stage = input
        .git_execution
        .as_ref()
        .map(evidence_persistence_stage)
        .unwrap_or(ScmCaptureWorkflowStageState::Missing);
    let completion_capture_stage = optional_ref_stage(&input.completion_capture_ref);
    let dry_run_plan_stage = optional_ref_stage(&input.dry_run_plan_ref);
    let diagnostics_stage = optional_ref_stage(&input.diagnostics_ref);
    let workflow_ready_for_operator_review = [
        &completion_capture_stage,
        &dry_run_plan_stage,
        &git_runner_stage,
        &evidence_persistence_stage,
        &diagnostics_stage,
    ]
    .iter()
    .all(|stage| matches!(stage, ScmCaptureWorkflowStageState::Completed));

    ScmCaptureWorkflowProjectionRecord {
        workflow_id: input.workflow_id,
        task_id: input.task_id,
        work_item_id: input.work_item_id,
        completion_id: input.completion_id,
        repo_id: input.repo_id,
        adapter_label: input.adapter_label,
        completion_capture_ref: input.completion_capture_ref,
        dry_run_plan_ref: input.dry_run_plan_ref,
        git_execution_ref,
        diagnostics_ref: input.diagnostics_ref,
        evidence_refs: unique_sorted(input.evidence_refs),
        completion_capture_stage,
        dry_run_plan_stage,
        git_runner_stage,
        evidence_persistence_stage,
        diagnostics_stage,
        workflow_ready_for_operator_review,
        replay_only: true,
        raw_output_retained: false,
        scm_mutation_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
    }
}

pub fn scm_capture_workflow_diagnostics(
    workflows: Vec<ScmCaptureWorkflowProjectionRecord>,
) -> ScmCaptureWorkflowDiagnosticsRecord {
    ScmCaptureWorkflowDiagnosticsRecord {
        diagnostics_id: "scm-capture-workflow-diagnostics".to_owned(),
        workflow_count: workflows.len(),
        ready_for_operator_review_count: workflows
            .iter()
            .filter(|workflow| workflow.workflow_ready_for_operator_review)
            .count(),
        missing_stage_count: stage_count(&workflows, ScmCaptureWorkflowStageState::Missing),
        completed_stage_count: stage_count(&workflows, ScmCaptureWorkflowStageState::Completed),
        blocked_stage_count: stage_count(&workflows, ScmCaptureWorkflowStageState::Blocked),
        repair_required_stage_count: stage_count(
            &workflows,
            ScmCaptureWorkflowStageState::RepairRequired,
        ),
        evidence_ref_count: workflows
            .iter()
            .map(|workflow| workflow.evidence_refs.len())
            .sum(),
        replay_only: true,
        raw_output_retained: false,
        scm_mutation_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
    }
}

pub fn scm_capture_workflow_authority(
    workflows: Vec<ScmCaptureWorkflowProjectionRecord>,
) -> ScmCaptureWorkflowAuthorityRecord {
    ScmCaptureWorkflowAuthorityRecord {
        authority_id: "scm-capture-workflow-authority".to_owned(),
        workflow_count: workflows.len(),
        replay_only: true,
        checkout_executed: false,
        branch_mutation_executed: false,
        commit_executed: false,
        push_executed: false,
        forge_effect_executed: false,
        provider_write_executed: false,
        callback_response_executed: false,
        interruption_executed: false,
        recovery_executed: false,
        raw_output_retained: false,
    }
}

fn optional_ref_stage(value: &Option<String>) -> ScmCaptureWorkflowStageState {
    if value.is_some() {
        ScmCaptureWorkflowStageState::Completed
    } else {
        ScmCaptureWorkflowStageState::Missing
    }
}

fn git_runner_stage(record: &GitDryRunExecutionPersistenceRecord) -> ScmCaptureWorkflowStageState {
    match record.capture_status {
        GitDryRunEvidenceCaptureStatus::Completed => ScmCaptureWorkflowStageState::Completed,
        GitDryRunEvidenceCaptureStatus::Failed | GitDryRunEvidenceCaptureStatus::RepairRequired => {
            ScmCaptureWorkflowStageState::RepairRequired
        }
        GitDryRunEvidenceCaptureStatus::TimedOut | GitDryRunEvidenceCaptureStatus::Blocked => {
            ScmCaptureWorkflowStageState::Blocked
        }
    }
}

fn evidence_persistence_stage(
    record: &GitDryRunExecutionPersistenceRecord,
) -> ScmCaptureWorkflowStageState {
    match record.persistence_status {
        GitDryRunExecutionPersistenceStatus::Persisted => ScmCaptureWorkflowStageState::Completed,
        GitDryRunExecutionPersistenceStatus::DuplicateNoop
        | GitDryRunExecutionPersistenceStatus::Blocked => ScmCaptureWorkflowStageState::Blocked,
    }
}

fn stage_count(
    workflows: &[ScmCaptureWorkflowProjectionRecord],
    state: ScmCaptureWorkflowStageState,
) -> usize {
    workflows
        .iter()
        .flat_map(|workflow| {
            [
                &workflow.completion_capture_stage,
                &workflow.dry_run_plan_stage,
                &workflow.git_runner_stage,
                &workflow.evidence_persistence_stage,
                &workflow.diagnostics_stage,
            ]
        })
        .filter(|stage| **stage == state)
        .count()
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
    fn scm_capture_workflow_projection_records_link_existing_surfaces_by_refs() {
        let workflow = scm_capture_workflow_projection(input(Some(execution(
            GitDryRunEvidenceCaptureStatus::Completed,
            GitDryRunExecutionPersistenceStatus::Persisted,
        ))));

        assert_eq!(
            workflow.completion_capture_stage,
            ScmCaptureWorkflowStageState::Completed
        );
        assert_eq!(
            workflow.git_runner_stage,
            ScmCaptureWorkflowStageState::Completed
        );
        assert_eq!(
            workflow.evidence_persistence_stage,
            ScmCaptureWorkflowStageState::Completed
        );
        assert!(workflow.workflow_ready_for_operator_review);
        assert!(workflow.replay_only);
        assert!(!workflow.raw_output_retained);
    }

    #[test]
    fn scm_capture_workflow_stage_state_distinguishes_missing_blocked_and_repair() {
        let missing = scm_capture_workflow_projection(input(None));
        let blocked = scm_capture_workflow_projection(input(Some(execution(
            GitDryRunEvidenceCaptureStatus::Blocked,
            GitDryRunExecutionPersistenceStatus::Blocked,
        ))));
        let repair = scm_capture_workflow_projection(input(Some(execution(
            GitDryRunEvidenceCaptureStatus::RepairRequired,
            GitDryRunExecutionPersistenceStatus::Persisted,
        ))));

        assert_eq!(
            missing.git_runner_stage,
            ScmCaptureWorkflowStageState::Missing
        );
        assert_eq!(
            blocked.git_runner_stage,
            ScmCaptureWorkflowStageState::Blocked
        );
        assert_eq!(
            repair.git_runner_stage,
            ScmCaptureWorkflowStageState::RepairRequired
        );
        assert!(!missing.workflow_ready_for_operator_review);
        assert!(!blocked.workflow_ready_for_operator_review);
        assert!(!repair.workflow_ready_for_operator_review);
    }

    #[test]
    fn scm_capture_workflow_diagnostics_summarizes_stage_states() {
        let complete = scm_capture_workflow_projection(input(Some(execution(
            GitDryRunEvidenceCaptureStatus::Completed,
            GitDryRunExecutionPersistenceStatus::Persisted,
        ))));
        let blocked = scm_capture_workflow_projection(input(Some(execution(
            GitDryRunEvidenceCaptureStatus::Blocked,
            GitDryRunExecutionPersistenceStatus::Blocked,
        ))));
        let diagnostics = scm_capture_workflow_diagnostics(vec![complete, blocked]);

        assert_eq!(diagnostics.workflow_count, 2);
        assert_eq!(diagnostics.ready_for_operator_review_count, 1);
        assert!(diagnostics.completed_stage_count > 0);
        assert!(diagnostics.blocked_stage_count > 0);
        assert!(!diagnostics.raw_output_retained);
        assert!(!diagnostics.scm_mutation_authority_granted);
    }

    #[test]
    fn scm_capture_workflow_authority_keeps_projection_replay_only() {
        let workflow = scm_capture_workflow_projection(input(Some(execution(
            GitDryRunEvidenceCaptureStatus::Completed,
            GitDryRunExecutionPersistenceStatus::Persisted,
        ))));
        let authority = scm_capture_workflow_authority(vec![workflow]);

        assert_eq!(authority.workflow_count, 1);
        assert!(authority.replay_only);
        assert!(!authority.checkout_executed);
        assert!(!authority.branch_mutation_executed);
        assert!(!authority.commit_executed);
        assert!(!authority.push_executed);
        assert!(!authority.forge_effect_executed);
        assert!(!authority.provider_write_executed);
        assert!(!authority.raw_output_retained);
    }

    fn input(
        git_execution: Option<GitDryRunExecutionPersistenceRecord>,
    ) -> ScmCaptureWorkflowProjectionInput {
        ScmCaptureWorkflowProjectionInput {
            workflow_id: "workflow:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: Some("work:1".to_owned()),
            completion_id: Some("completion:1".to_owned()),
            repo_id: "repo:1".to_owned(),
            adapter_label: "git".to_owned(),
            completion_capture_ref: Some("completion-capture:1".to_owned()),
            dry_run_plan_ref: Some("dry-run-plan:1".to_owned()),
            git_execution,
            diagnostics_ref: Some("diagnostics:1".to_owned()),
            evidence_refs: vec!["evidence:1".to_owned(), "evidence:1".to_owned()],
        }
    }

    fn execution(
        capture_status: GitDryRunEvidenceCaptureStatus,
        persistence_status: GitDryRunExecutionPersistenceStatus,
    ) -> GitDryRunExecutionPersistenceRecord {
        GitDryRunExecutionPersistenceRecord {
            persisted_execution_id: "git-dry-run-execution:capture:1".to_owned(),
            capture_id: "capture:1".to_owned(),
            handoff_id: "handoff:1".to_owned(),
            request_id: "request:1".to_owned(),
            descriptor_id: "git-dry-run-status-porcelain".to_owned(),
            repo_id: "repo:1".to_owned(),
            capture_status,
            capture_blockers: Vec::new(),
            persistence_status,
            persistence_blockers: Vec::new(),
            duplicate_execution_detected: false,
            exit_code: Some(0),
            changed_path_count: 1,
            staged_path_count: 0,
            unstaged_path_count: 0,
            untracked_path_count: 1,
            insertion_count: 0,
            deletion_count: 0,
            evidence_refs: vec!["evidence:1".to_owned()],
            git_dry_run_executed: true,
            checkout_executed: false,
            branch_mutation_executed: false,
            commit_executed: false,
            push_executed: false,
            forge_effect_executed: false,
            provider_write_executed: false,
            callback_response_executed: false,
            interruption_executed: false,
            recovery_executed: false,
            raw_output_retained: false,
        }
    }
}
