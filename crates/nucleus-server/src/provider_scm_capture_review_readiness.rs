//! Operator review readiness for replay-only SCM capture workflows.

use serde::{Deserialize, Serialize};

use crate::{ScmCaptureWorkflowProjectionRecord, ScmCaptureWorkflowStageState};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmCaptureReviewReadinessInput {
    pub workflow: ScmCaptureWorkflowProjectionRecord,
    pub operator_ref: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureReviewReadinessRecord {
    pub readiness_id: String,
    pub workflow_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub repo_id: String,
    pub operator_ref: String,
    pub status: ScmCaptureReviewReadinessStatus,
    pub blockers: Vec<ScmCaptureReviewReadinessBlocker>,
    pub evidence_refs: Vec<String>,
    pub review_ready: bool,
    pub change_request_authority_granted: bool,
    pub scm_mutation_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureReviewReadinessStatus {
    Ready,
    Blocked,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureReviewReadinessBlocker {
    WorkflowNotReady,
    MissingStage,
    BlockedStage,
    RepairRequiredStage,
    MissingEvidenceRef,
    RawOutputRetained,
    MutationAuthorityPresent,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureReviewDiagnosticsRecord {
    pub diagnostics_id: String,
    pub readiness_count: usize,
    pub ready_count: usize,
    pub blocked_count: usize,
    pub repair_required_count: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    pub change_request_authority_granted: bool,
    pub scm_mutation_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureReviewAuthorityRecord {
    pub authority_id: String,
    pub readiness_count: usize,
    pub review_ready_count: usize,
    pub change_request_created: bool,
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

pub fn scm_capture_review_readiness(
    input: ScmCaptureReviewReadinessInput,
) -> ScmCaptureReviewReadinessRecord {
    let blockers = blockers(&input.workflow);
    let status = status(&blockers);
    let review_ready = status == ScmCaptureReviewReadinessStatus::Ready;
    ScmCaptureReviewReadinessRecord {
        readiness_id: format!(
            "scm-capture-review-readiness:{}",
            input.workflow.workflow_id
        ),
        workflow_id: input.workflow.workflow_id,
        task_id: input.workflow.task_id,
        work_item_id: input.workflow.work_item_id,
        completion_id: input.workflow.completion_id,
        repo_id: input.workflow.repo_id,
        operator_ref: input.operator_ref,
        status,
        blockers,
        evidence_refs: unique_sorted(input.workflow.evidence_refs),
        review_ready,
        change_request_authority_granted: false,
        scm_mutation_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        raw_output_retained: false,
    }
}

pub fn scm_capture_review_diagnostics(
    records: Vec<ScmCaptureReviewReadinessRecord>,
) -> ScmCaptureReviewDiagnosticsRecord {
    ScmCaptureReviewDiagnosticsRecord {
        diagnostics_id: "scm-capture-review-diagnostics".to_owned(),
        readiness_count: records.len(),
        ready_count: records
            .iter()
            .filter(|record| record.status == ScmCaptureReviewReadinessStatus::Ready)
            .count(),
        blocked_count: records
            .iter()
            .filter(|record| record.status == ScmCaptureReviewReadinessStatus::Blocked)
            .count(),
        repair_required_count: records
            .iter()
            .filter(|record| record.status == ScmCaptureReviewReadinessStatus::RepairRequired)
            .count(),
        blocker_count: records.iter().map(|record| record.blockers.len()).sum(),
        evidence_ref_count: records
            .iter()
            .map(|record| record.evidence_refs.len())
            .sum(),
        change_request_authority_granted: false,
        scm_mutation_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        raw_output_retained: false,
    }
}

pub fn scm_capture_review_authority(
    records: Vec<ScmCaptureReviewReadinessRecord>,
) -> ScmCaptureReviewAuthorityRecord {
    ScmCaptureReviewAuthorityRecord {
        authority_id: "scm-capture-review-authority".to_owned(),
        readiness_count: records.len(),
        review_ready_count: records.iter().filter(|record| record.review_ready).count(),
        change_request_created: false,
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

fn blockers(
    workflow: &ScmCaptureWorkflowProjectionRecord,
) -> Vec<ScmCaptureReviewReadinessBlocker> {
    let mut blockers = Vec::new();
    if !workflow.workflow_ready_for_operator_review {
        blockers.push(ScmCaptureReviewReadinessBlocker::WorkflowNotReady);
    }
    for stage in [
        &workflow.completion_capture_stage,
        &workflow.dry_run_plan_stage,
        &workflow.git_runner_stage,
        &workflow.evidence_persistence_stage,
        &workflow.diagnostics_stage,
    ] {
        match stage {
            ScmCaptureWorkflowStageState::Missing => {
                blockers.push(ScmCaptureReviewReadinessBlocker::MissingStage)
            }
            ScmCaptureWorkflowStageState::Blocked => {
                blockers.push(ScmCaptureReviewReadinessBlocker::BlockedStage)
            }
            ScmCaptureWorkflowStageState::RepairRequired => {
                blockers.push(ScmCaptureReviewReadinessBlocker::RepairRequiredStage)
            }
            ScmCaptureWorkflowStageState::Ready | ScmCaptureWorkflowStageState::Completed => {}
        }
    }
    if workflow.evidence_refs.is_empty() {
        blockers.push(ScmCaptureReviewReadinessBlocker::MissingEvidenceRef);
    }
    if workflow.raw_output_retained {
        blockers.push(ScmCaptureReviewReadinessBlocker::RawOutputRetained);
    }
    if workflow.scm_mutation_authority_granted
        || workflow.forge_authority_granted
        || workflow.provider_authority_granted
        || workflow.callback_authority_granted
        || workflow.interruption_authority_granted
        || workflow.recovery_authority_granted
    {
        blockers.push(ScmCaptureReviewReadinessBlocker::MutationAuthorityPresent);
    }
    unique_blockers(blockers)
}

fn status(blockers: &[ScmCaptureReviewReadinessBlocker]) -> ScmCaptureReviewReadinessStatus {
    if blockers.is_empty() {
        ScmCaptureReviewReadinessStatus::Ready
    } else if blockers
        .iter()
        .any(|blocker| blocker == &ScmCaptureReviewReadinessBlocker::RepairRequiredStage)
    {
        ScmCaptureReviewReadinessStatus::RepairRequired
    } else {
        ScmCaptureReviewReadinessStatus::Blocked
    }
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

fn unique_blockers(
    mut values: Vec<ScmCaptureReviewReadinessBlocker>,
) -> Vec<ScmCaptureReviewReadinessBlocker> {
    values.sort_by_key(|value| format!("{value:?}"));
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scm_capture_review_readiness_records_admit_completed_workflows() {
        let record =
            scm_capture_review_readiness(input(workflow(ScmCaptureWorkflowStageState::Completed)));

        assert_eq!(record.status, ScmCaptureReviewReadinessStatus::Ready);
        assert!(record.review_ready);
        assert_eq!(record.evidence_refs, vec!["evidence:1"]);
        assert!(!record.change_request_authority_granted);
        assert!(!record.raw_output_retained);
    }

    #[test]
    fn scm_capture_review_blockers_preserve_missing_blocked_and_repair_states() {
        let missing =
            scm_capture_review_readiness(input(workflow(ScmCaptureWorkflowStageState::Missing)));
        let blocked =
            scm_capture_review_readiness(input(workflow(ScmCaptureWorkflowStageState::Blocked)));
        let repair = scm_capture_review_readiness(input(workflow(
            ScmCaptureWorkflowStageState::RepairRequired,
        )));

        assert_eq!(missing.status, ScmCaptureReviewReadinessStatus::Blocked);
        assert!(missing
            .blockers
            .contains(&ScmCaptureReviewReadinessBlocker::MissingStage));
        assert_eq!(blocked.status, ScmCaptureReviewReadinessStatus::Blocked);
        assert!(blocked
            .blockers
            .contains(&ScmCaptureReviewReadinessBlocker::BlockedStage));
        assert_eq!(
            repair.status,
            ScmCaptureReviewReadinessStatus::RepairRequired
        );
        assert!(repair
            .blockers
            .contains(&ScmCaptureReviewReadinessBlocker::RepairRequiredStage));
    }

    #[test]
    fn scm_capture_review_diagnostics_summarizes_readiness() {
        let ready =
            scm_capture_review_readiness(input(workflow(ScmCaptureWorkflowStageState::Completed)));
        let blocked =
            scm_capture_review_readiness(input(workflow(ScmCaptureWorkflowStageState::Blocked)));
        let diagnostics = scm_capture_review_diagnostics(vec![ready, blocked]);

        assert_eq!(diagnostics.readiness_count, 2);
        assert_eq!(diagnostics.ready_count, 1);
        assert_eq!(diagnostics.blocked_count, 1);
        assert!(diagnostics.blocker_count > 0);
        assert!(!diagnostics.change_request_authority_granted);
        assert!(!diagnostics.raw_output_retained);
    }

    #[test]
    fn scm_capture_review_authority_keeps_review_readiness_read_only() {
        let ready =
            scm_capture_review_readiness(input(workflow(ScmCaptureWorkflowStageState::Completed)));
        let authority = scm_capture_review_authority(vec![ready]);

        assert_eq!(authority.readiness_count, 1);
        assert_eq!(authority.review_ready_count, 1);
        assert!(!authority.change_request_created);
        assert!(!authority.checkout_executed);
        assert!(!authority.branch_mutation_executed);
        assert!(!authority.commit_executed);
        assert!(!authority.push_executed);
        assert!(!authority.provider_write_executed);
        assert!(!authority.raw_output_retained);
    }

    fn input(workflow: ScmCaptureWorkflowProjectionRecord) -> ScmCaptureReviewReadinessInput {
        ScmCaptureReviewReadinessInput {
            workflow,
            operator_ref: "operator:tom".to_owned(),
        }
    }

    fn workflow(stage: ScmCaptureWorkflowStageState) -> ScmCaptureWorkflowProjectionRecord {
        let ready = stage == ScmCaptureWorkflowStageState::Completed;
        ScmCaptureWorkflowProjectionRecord {
            workflow_id: "workflow:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: Some("work:1".to_owned()),
            completion_id: Some("completion:1".to_owned()),
            repo_id: "repo:1".to_owned(),
            adapter_label: "git".to_owned(),
            completion_capture_ref: Some("completion-capture:1".to_owned()),
            dry_run_plan_ref: Some("dry-run-plan:1".to_owned()),
            git_execution_ref: Some("git-execution:1".to_owned()),
            diagnostics_ref: Some("diagnostics:1".to_owned()),
            evidence_refs: vec!["evidence:1".to_owned()],
            completion_capture_stage: ScmCaptureWorkflowStageState::Completed,
            dry_run_plan_stage: ScmCaptureWorkflowStageState::Completed,
            git_runner_stage: stage.clone(),
            evidence_persistence_stage: ScmCaptureWorkflowStageState::Completed,
            diagnostics_stage: ScmCaptureWorkflowStageState::Completed,
            workflow_ready_for_operator_review: ready,
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
}
