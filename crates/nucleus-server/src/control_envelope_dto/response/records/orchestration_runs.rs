use serde::{Deserialize, Serialize};

use nucleus_engine::{
    EngineRunCloseout, EngineRunFleetEntry, EngineRunLifecycleState, EngineRunStateCount,
    EngineRunTransitionRecord,
};

use crate::request_handler::run_review::{
    OrchestrationRunReview, OrchestrationRunReviewPatch, RunReviewDiffFile,
    RunReviewDiffOverview, RunReviewValidation,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlOrchestrationRunSummaryDto {
    pub run_id: String,
    pub state: String,
    pub provider_instance: String,
    pub provider_model: String,
    pub orchestrator_designation: Option<String>,
    #[ts(as = "u64")]
    pub updated_at: u64,
    pub has_closeout: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlOrchestrationRunStateCountDto {
    pub state: String,
    #[ts(as = "u32")]
    pub count: usize,
}

/// Delivery-review read model for one run (closeout + validation + diff).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlOrchestrationRunReviewDto {
    pub project_id: String,
    pub run_id: String,
    pub state: String,
    pub objective_scope: String,
    pub acceptance: Vec<String>,
    pub stop_conditions: Vec<String>,
    pub provider_instance: String,
    pub provider_model: String,
    pub orchestrator_designation: Option<String>,
    pub worktree_ref: Option<String>,
    pub base_ref: Option<String>,
    pub conversation_id: Option<String>,
    pub closeout: Option<ControlOrchestrationRunCloseoutDto>,
    pub transitions: Vec<ControlOrchestrationRunTransitionDto>,
    #[ts(as = "u64")]
    pub created_at: u64,
    #[ts(as = "u64")]
    pub updated_at: u64,
    pub validation: ControlOrchestrationRunValidationDto,
    pub diff: ControlOrchestrationRunDiffOverviewDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlOrchestrationRunCloseoutDto {
    pub summary: String,
    pub evidence_refs: Vec<String>,
    pub diff_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlOrchestrationRunTransitionDto {
    pub command_id: String,
    pub from: Option<String>,
    pub to: String,
    #[ts(as = "u64")]
    pub at: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlOrchestrationRunValidationDto {
    pub status: Option<String>,
    #[ts(as = "Option<u64>")]
    pub changed_files: Option<u64>,
    pub commit_created: Option<bool>,
    pub push_executed: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlOrchestrationRunDiffOverviewDto {
    pub base_ref: Option<String>,
    pub available: bool,
    pub unreachable_reason: Option<String>,
    pub files: Vec<ControlOrchestrationRunDiffFileDto>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlOrchestrationRunDiffFileDto {
    pub path: String,
    pub change_kind: String,
    #[ts(as = "u64")]
    pub additions: u64,
    #[ts(as = "u64")]
    pub deletions: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlOrchestrationRunReviewPatchDto {
    pub run_id: String,
    pub file_ref: String,
    pub available: bool,
    pub unreachable_reason: Option<String>,
    pub patch: Option<String>,
    #[ts(as = "u64")]
    pub additions: u64,
    #[ts(as = "u64")]
    pub deletions: u64,
    pub truncated: bool,
}

impl From<&EngineRunFleetEntry> for ControlOrchestrationRunSummaryDto {
    fn from(run: &EngineRunFleetEntry) -> Self {
        Self {
            run_id: run.run_id.clone(),
            state: state_dto(&run.state),
            provider_instance: run.provider_instance.clone(),
            provider_model: run.provider_model.clone(),
            orchestrator_designation: run.orchestrator_designation.clone(),
            updated_at: run.updated_at,
            has_closeout: run.has_closeout,
        }
    }
}

impl From<&EngineRunStateCount> for ControlOrchestrationRunStateCountDto {
    fn from(count: &EngineRunStateCount) -> Self {
        Self {
            state: state_dto(&count.state),
            count: count.count,
        }
    }
}

impl From<&OrchestrationRunReview> for ControlOrchestrationRunReviewDto {
    fn from(review: &OrchestrationRunReview) -> Self {
        Self {
            project_id: review.project_id.clone(),
            run_id: review.run_id.clone(),
            state: state_dto(&review.state),
            objective_scope: review.objective_scope.clone(),
            acceptance: review.acceptance.clone(),
            stop_conditions: review.stop_conditions.clone(),
            provider_instance: review.provider_instance.clone(),
            provider_model: review.provider_model.clone(),
            orchestrator_designation: review.orchestrator_designation.clone(),
            worktree_ref: review.worktree_ref.clone(),
            base_ref: review.base_ref.clone(),
            conversation_id: review.conversation_id.clone(),
            closeout: review.closeout.as_ref().map(closeout_dto),
            transitions: review
                .transitions
                .iter()
                .map(transition_dto)
                .collect(),
            created_at: review.created_at,
            updated_at: review.updated_at,
            validation: ControlOrchestrationRunValidationDto::from(&review.validation),
            diff: ControlOrchestrationRunDiffOverviewDto::from(&review.diff),
        }
    }
}

impl From<&OrchestrationRunReviewPatch> for ControlOrchestrationRunReviewPatchDto {
    fn from(patch: &OrchestrationRunReviewPatch) -> Self {
        Self {
            run_id: patch.run_id.clone(),
            file_ref: patch.file_ref.clone(),
            available: patch.available,
            unreachable_reason: patch.unreachable_reason.clone(),
            patch: patch.patch.clone(),
            additions: patch.additions,
            deletions: patch.deletions,
            truncated: patch.truncated,
        }
    }
}

impl From<&RunReviewValidation> for ControlOrchestrationRunValidationDto {
    fn from(validation: &RunReviewValidation) -> Self {
        Self {
            status: validation.status.clone(),
            changed_files: validation.changed_files,
            commit_created: validation.commit_created,
            push_executed: validation.push_executed,
        }
    }
}

impl From<&RunReviewDiffOverview> for ControlOrchestrationRunDiffOverviewDto {
    fn from(diff: &RunReviewDiffOverview) -> Self {
        Self {
            base_ref: diff.base_ref.clone(),
            available: diff.available,
            unreachable_reason: diff.unreachable_reason.clone(),
            files: diff.files.iter().map(diff_file_dto).collect(),
            truncated: diff.truncated,
        }
    }
}

fn closeout_dto(closeout: &EngineRunCloseout) -> ControlOrchestrationRunCloseoutDto {
    ControlOrchestrationRunCloseoutDto {
        summary: closeout.summary.clone(),
        evidence_refs: closeout.evidence_refs.clone(),
        diff_ref: closeout.diff_ref.clone(),
    }
}

fn transition_dto(
    transition: &EngineRunTransitionRecord,
) -> ControlOrchestrationRunTransitionDto {
    ControlOrchestrationRunTransitionDto {
        command_id: transition.command_id.clone(),
        from: transition.from.as_ref().map(state_dto),
        to: state_dto(&transition.to),
        at: transition.at,
    }
}

fn diff_file_dto(file: &RunReviewDiffFile) -> ControlOrchestrationRunDiffFileDto {
    ControlOrchestrationRunDiffFileDto {
        path: file.path.clone(),
        change_kind: file.change_kind.clone(),
        additions: file.additions,
        deletions: file.deletions,
    }
}

fn state_dto(state: &EngineRunLifecycleState) -> String {
    match state {
        EngineRunLifecycleState::Proposed => "proposed",
        EngineRunLifecycleState::Dispatched => "dispatched",
        EngineRunLifecycleState::Running => "running",
        EngineRunLifecycleState::Delivered => "delivered",
        EngineRunLifecycleState::Accepted => "accepted",
        EngineRunLifecycleState::Rejected => "rejected",
        EngineRunLifecycleState::Failed => "failed",
        EngineRunLifecycleState::Cancelled => "cancelled",
    }
    .to_owned()
}
