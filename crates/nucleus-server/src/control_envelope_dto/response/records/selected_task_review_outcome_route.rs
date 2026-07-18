use serde::{Deserialize, Serialize};

use crate::{
    SelectedTaskReviewDecisionOutcome, SelectedTaskReviewOutcomeCommandHint,
    SelectedTaskReviewOutcomeRoute, SelectedTaskReviewOutcomeRouteBlocker,
    SelectedTaskReviewOutcomeRouteCandidate, SelectedTaskReviewOutcomeRouteNoEffects,
    SelectedTaskReviewOutcomeRouteSourceCounts, SelectedTaskReviewOutcomeRouteStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskReviewOutcomeRouteDto {
    pub route_id: String,
    pub project_id: String,
    pub task_id: String,
    pub status: String,
    pub primary_route: String,
    pub candidates: Vec<String>,
    pub decision_ref: Option<String>,
    pub decision_outcome: Option<String>,
    pub work_item_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub downstream_command_hints: Vec<String>,
    pub blockers: Vec<String>,
    pub source_counts: ControlSelectedTaskReviewOutcomeRouteSourceCountsDto,
    pub no_effects: ControlSelectedTaskReviewOutcomeRouteNoEffectsDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskReviewOutcomeRouteSourceCountsDto {
    #[ts(as = "u32")]
    pub decision_records: usize,
    #[ts(as = "u32")]
    pub work_item_refs: usize,
    #[ts(as = "u32")]
    pub evidence_refs: usize,
    #[ts(as = "u32")]
    pub review_gap_count: usize,
    #[ts(as = "u32")]
    pub scm_handoff_refs: usize,
    #[ts(as = "u32")]
    pub downstream_command_hints: usize,
    #[ts(as = "u32")]
    pub blockers: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskReviewOutcomeRouteNoEffectsDto {
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

impl From<&SelectedTaskReviewOutcomeRoute> for ControlSelectedTaskReviewOutcomeRouteDto {
    fn from(route: &SelectedTaskReviewOutcomeRoute) -> Self {
        Self {
            route_id: route.route_id.clone(),
            project_id: route.project_id.0.clone(),
            task_id: route.task_id.0.clone(),
            status: route_status_label(route.status).to_owned(),
            primary_route: route_candidate_label(route.primary_route).to_owned(),
            candidates: route
                .candidates
                .iter()
                .map(|candidate| route_candidate_label(*candidate).to_owned())
                .collect(),
            decision_ref: route.decision_ref.clone(),
            decision_outcome: route
                .decision_outcome
                .map(|outcome| decision_outcome_label(outcome).to_owned()),
            work_item_refs: route.work_item_refs.clone(),
            evidence_refs: route.evidence_refs.clone(),
            downstream_command_hints: route
                .downstream_command_hints
                .iter()
                .map(|hint| command_hint_label(*hint).to_owned())
                .collect(),
            blockers: route
                .blockers
                .iter()
                .map(|blocker| blocker_label(*blocker).to_owned())
                .collect(),
            source_counts: ControlSelectedTaskReviewOutcomeRouteSourceCountsDto::from(
                &route.source_counts,
            ),
            no_effects: ControlSelectedTaskReviewOutcomeRouteNoEffectsDto::from(&route.no_effects),
        }
    }
}

impl From<&SelectedTaskReviewOutcomeRouteSourceCounts>
    for ControlSelectedTaskReviewOutcomeRouteSourceCountsDto
{
    fn from(counts: &SelectedTaskReviewOutcomeRouteSourceCounts) -> Self {
        Self {
            decision_records: counts.decision_records,
            work_item_refs: counts.work_item_refs,
            evidence_refs: counts.evidence_refs,
            review_gap_count: counts.review_gap_count,
            scm_handoff_refs: counts.scm_handoff_refs,
            downstream_command_hints: counts.downstream_command_hints,
            blockers: counts.blockers,
        }
    }
}

impl From<&SelectedTaskReviewOutcomeRouteNoEffects>
    for ControlSelectedTaskReviewOutcomeRouteNoEffectsDto
{
    fn from(no_effects: &SelectedTaskReviewOutcomeRouteNoEffects) -> Self {
        Self {
            review_mutation_performed: no_effects.review_mutation_performed,
            task_lifecycle_mutation_performed: no_effects.task_lifecycle_mutation_performed,
            provider_execution_performed: no_effects.provider_execution_performed,
            provider_write_performed: no_effects.provider_write_performed,
            scm_or_forge_mutation_performed: no_effects.scm_or_forge_mutation_performed,
            accepted_memory_apply_performed: no_effects.accepted_memory_apply_performed,
            planning_apply_performed: no_effects.planning_apply_performed,
            projection_write_performed: no_effects.projection_write_performed,
            agent_scheduling_performed: no_effects.agent_scheduling_performed,
            ui_effect_performed: no_effects.ui_effect_performed,
        }
    }
}

fn route_status_label(status: SelectedTaskReviewOutcomeRouteStatus) -> &'static str {
    match status {
        SelectedTaskReviewOutcomeRouteStatus::Ready => "ready",
        SelectedTaskReviewOutcomeRouteStatus::Blocked => "blocked",
        SelectedTaskReviewOutcomeRouteStatus::Stale => "stale",
        SelectedTaskReviewOutcomeRouteStatus::Missing => "missing",
    }
}

fn route_candidate_label(candidate: SelectedTaskReviewOutcomeRouteCandidate) -> &'static str {
    match candidate {
        SelectedTaskReviewOutcomeRouteCandidate::ReadyForCompletionAdmission => {
            "ready_for_completion_admission"
        }
        SelectedTaskReviewOutcomeRouteCandidate::ReadyForReworkAdmission => {
            "ready_for_rework_admission"
        }
        SelectedTaskReviewOutcomeRouteCandidate::ReadyForDelegationAdmission => {
            "ready_for_delegation_admission"
        }
        SelectedTaskReviewOutcomeRouteCandidate::ReadyForScmHandoffReview => {
            "ready_for_scm_handoff_review"
        }
        SelectedTaskReviewOutcomeRouteCandidate::BlockedOnOperatorChoice => {
            "blocked_on_operator_choice"
        }
        SelectedTaskReviewOutcomeRouteCandidate::BlockedOnMissingEvidence => {
            "blocked_on_missing_evidence"
        }
        SelectedTaskReviewOutcomeRouteCandidate::BlockedOnStaleTaskState => {
            "blocked_on_stale_task_state"
        }
        SelectedTaskReviewOutcomeRouteCandidate::BlockedOnPlanningAmbiguity => {
            "blocked_on_planning_ambiguity"
        }
        SelectedTaskReviewOutcomeRouteCandidate::NoReviewDecision => "no_review_decision",
    }
}

fn command_hint_label(hint: SelectedTaskReviewOutcomeCommandHint) -> &'static str {
    match hint {
        SelectedTaskReviewOutcomeCommandHint::CompleteSelectedTask => "complete_selected_task",
        SelectedTaskReviewOutcomeCommandHint::PrepareRework => "prepare_rework",
        SelectedTaskReviewOutcomeCommandHint::DelegateRework => "delegate_rework",
        SelectedTaskReviewOutcomeCommandHint::ReviewScmHandoff => "review_scm_handoff",
        SelectedTaskReviewOutcomeCommandHint::ResolveOperatorChoice => "resolve_operator_choice",
    }
}

fn blocker_label(blocker: SelectedTaskReviewOutcomeRouteBlocker) -> &'static str {
    match blocker {
        SelectedTaskReviewOutcomeRouteBlocker::MissingDecisionRecord => "missing_decision_record",
        SelectedTaskReviewOutcomeRouteBlocker::MissingReviewEvidence => "missing_review_evidence",
        SelectedTaskReviewOutcomeRouteBlocker::StaleTaskState => "stale_task_state",
        SelectedTaskReviewOutcomeRouteBlocker::UnsupportedReviewState => "unsupported_review_state",
        SelectedTaskReviewOutcomeRouteBlocker::PlanningAmbiguity => "planning_ambiguity",
        SelectedTaskReviewOutcomeRouteBlocker::DownstreamCommandNotDefined => {
            "downstream_command_not_defined"
        }
    }
}

fn decision_outcome_label(outcome: SelectedTaskReviewDecisionOutcome) -> &'static str {
    match outcome {
        SelectedTaskReviewDecisionOutcome::Accepted => "accepted",
        SelectedTaskReviewDecisionOutcome::Rejected => "rejected",
        SelectedTaskReviewDecisionOutcome::NeedsChanges => "needs_changes",
        SelectedTaskReviewDecisionOutcome::Abandoned => "abandoned",
    }
}
