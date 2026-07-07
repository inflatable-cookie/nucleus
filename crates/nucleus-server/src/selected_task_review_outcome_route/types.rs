use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::{
    SelectedTaskReviewDecisionOutcome, SelectedTaskReviewDecisionRecord, SelectedTaskReviewNext,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewOutcomeRouteInput {
    pub review_next: SelectedTaskReviewNext,
    pub decision_records: Vec<SelectedTaskReviewDecisionRecord>,
    pub scm_handoff_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewOutcomeRoute {
    pub route_id: String,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub status: SelectedTaskReviewOutcomeRouteStatus,
    pub primary_route: SelectedTaskReviewOutcomeRouteCandidate,
    pub candidates: Vec<SelectedTaskReviewOutcomeRouteCandidate>,
    pub decision_ref: Option<String>,
    pub decision_outcome: Option<SelectedTaskReviewDecisionOutcome>,
    pub work_item_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub downstream_command_hints: Vec<SelectedTaskReviewOutcomeCommandHint>,
    pub blockers: Vec<SelectedTaskReviewOutcomeRouteBlocker>,
    pub source_counts: SelectedTaskReviewOutcomeRouteSourceCounts,
    pub no_effects: SelectedTaskReviewOutcomeRouteNoEffects,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskReviewOutcomeRouteStatus {
    Ready,
    Blocked,
    Stale,
    Missing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskReviewOutcomeRouteCandidate {
    ReadyForCompletionAdmission,
    ReadyForReworkAdmission,
    ReadyForDelegationAdmission,
    ReadyForScmHandoffReview,
    BlockedOnOperatorChoice,
    BlockedOnMissingEvidence,
    BlockedOnStaleTaskState,
    BlockedOnPlanningAmbiguity,
    NoReviewDecision,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskReviewOutcomeCommandHint {
    CompleteSelectedTask,
    PrepareRework,
    DelegateRework,
    ReviewScmHandoff,
    ResolveOperatorChoice,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskReviewOutcomeRouteBlocker {
    MissingDecisionRecord,
    MissingReviewEvidence,
    StaleTaskState,
    UnsupportedReviewState,
    PlanningAmbiguity,
    DownstreamCommandNotDefined,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewOutcomeRouteSourceCounts {
    pub decision_records: usize,
    pub work_item_refs: usize,
    pub evidence_refs: usize,
    pub review_gap_count: usize,
    pub scm_handoff_refs: usize,
    pub downstream_command_hints: usize,
    pub blockers: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewOutcomeRouteNoEffects {
    pub review_mutation_performed: bool,
    pub task_lifecycle_mutation_performed: bool,
    pub provider_execution_performed: bool,
    pub provider_write_performed: bool,
    pub scm_or_forge_mutation_performed: bool,
    pub accepted_memory_apply_performed: bool,
    pub planning_apply_performed: bool,
    pub projection_write_performed: bool,
    pub agent_scheduling_performed: bool,
    pub ui_effect_performed: bool,
}

impl SelectedTaskReviewOutcomeRouteNoEffects {
    pub fn read_only() -> Self {
        Self {
            review_mutation_performed: false,
            task_lifecycle_mutation_performed: false,
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
