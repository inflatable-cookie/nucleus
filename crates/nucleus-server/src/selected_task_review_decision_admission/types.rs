use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;
use serde::{Deserialize, Serialize};

use crate::SelectedTaskReviewNext;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewDecisionAdmissionInput {
    pub review_next: SelectedTaskReviewNext,
    pub intent: SelectedTaskReviewDecisionIntent,
    pub current_revision: Option<RevisionId>,
    pub existing_decision_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewDecisionIntent {
    pub action: SelectedTaskReviewDecisionAction,
    pub expected_revision: Option<RevisionId>,
    pub operator_ref: String,
    pub reviewed_evidence_refs: Vec<String>,
    pub idempotency_key: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewDecisionAdmission {
    pub admission_id: String,
    pub decision_id: String,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub action: SelectedTaskReviewDecisionAction,
    pub status: SelectedTaskReviewDecisionAdmissionStatus,
    pub command: Option<SelectedTaskReviewDecisionCommand>,
    pub refusal: Option<SelectedTaskReviewDecisionAdmissionRefusal>,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub no_effects: SelectedTaskReviewDecisionNoEffects,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectedTaskReviewDecisionAction {
    AcceptEvidence,
    RejectEvidence,
    RequestChanges,
    AbandonReview,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectedTaskReviewDecisionOutcome {
    Accepted,
    Rejected,
    NeedsChanges,
    Abandoned,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskReviewDecisionAdmissionStatus {
    Admitted,
    Blocked,
    Stale,
    Duplicate,
    Unsupported,
    MissingEvidence,
    NoOp,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewDecisionCommand {
    pub decision_id: String,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub action: SelectedTaskReviewDecisionAction,
    pub outcome: SelectedTaskReviewDecisionOutcome,
    pub expected_revision: RevisionId,
    pub operator_ref: String,
    pub reviewed_evidence_refs: Vec<String>,
    pub idempotency_key: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewDecisionAdmissionRefusal {
    pub kind: SelectedTaskReviewDecisionAdmissionRefusalKind,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskReviewDecisionAdmissionRefusalKind {
    MissingOperator,
    MissingIdempotencyKey,
    ExpectedRevisionRequired,
    StaleRevision,
    DuplicateDecision,
    MissingReviewedEvidence,
    UnknownReviewedEvidence,
    ReasonRequired,
    ReviewNotAwaitingDecision,
    DecisionAlreadyRepresented,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewDecisionNoEffects {
    pub review_mutation_performed: bool,
    pub task_mutation_performed: bool,
    pub provider_execution_performed: bool,
    pub provider_write_performed: bool,
    pub scm_or_forge_mutation_performed: bool,
    pub accepted_memory_apply_performed: bool,
    pub planning_apply_performed: bool,
    pub projection_write_performed: bool,
    pub agent_scheduling_performed: bool,
    pub ui_effect_performed: bool,
}

impl SelectedTaskReviewDecisionNoEffects {
    pub fn pure_admission() -> Self {
        Self {
            review_mutation_performed: false,
            task_mutation_performed: false,
            provider_execution_performed: false,
            provider_write_performed: false,
            scm_or_forge_mutation_performed: false,
            accepted_memory_apply_performed: false,
            planning_apply_performed: false,
            projection_write_performed: false,
            agent_scheduling_performed: false,
            ui_effect_performed: false,
        }
    }
}
