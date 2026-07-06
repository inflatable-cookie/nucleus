use serde::{Deserialize, Serialize};

use crate::{
    ProductWorkflowContextSummary, ProductWorkflowGap, ProductWorkflowGapArea,
    ProductWorkflowLaneSummary, ProductWorkflowNextStep, ProductWorkflowNextStepSource,
    ProductWorkflowNoEffects, ProductWorkflowPlanningContext, ProductWorkflowProjectSummary,
    ProductWorkflowReviewSummary, ProductWorkflowRuntimeSummary,
    ProductWorkflowScmReadinessSummary, ProductWorkflowSourceCounts, ProductWorkflowSummary,
    ProductWorkflowTaskLane,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProductWorkflowSummaryDto {
    pub summary_id: String,
    pub project_id: String,
    pub project: ControlProductWorkflowProjectDto,
    pub task_lanes: Vec<ControlProductWorkflowLaneDto>,
    pub planning_context: ControlProductWorkflowPlanningContextDto,
    pub context: ControlProductWorkflowContextDto,
    pub runtime: ControlProductWorkflowRuntimeDto,
    pub review: ControlProductWorkflowReviewDto,
    pub scm_readiness: ControlProductWorkflowScmReadinessDto,
    pub next: ControlProductWorkflowNextDto,
    pub source_counts: ControlProductWorkflowSourceCountsDto,
    pub gaps: Vec<ControlProductWorkflowGapDto>,
    pub no_effects: ControlProductWorkflowNoEffectsDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProductWorkflowProjectDto {
    pub display_name: Option<String>,
    pub status: Option<String>,
    pub authority_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProductWorkflowLaneDto {
    pub lane: String,
    pub count: usize,
    pub task_refs: Vec<String>,
    pub rationale_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProductWorkflowPlanningContextDto {
    pub planning_session_refs: Vec<String>,
    pub task_seed_refs: Vec<String>,
    pub accepted_planning_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProductWorkflowContextDto {
    pub memory_proposal_refs: Vec<String>,
    pub accepted_memory_refs: Vec<String>,
    pub research_run_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProductWorkflowRuntimeDto {
    pub runtime_evidence_refs: Vec<String>,
    pub command_evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProductWorkflowReviewDto {
    pub review_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProductWorkflowScmReadinessDto {
    pub readiness_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProductWorkflowNextDto {
    pub source: String,
    pub next_ref: Option<String>,
    pub summary: String,
    pub rationale_refs: Vec<String>,
    pub blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProductWorkflowSourceCountsDto {
    pub task_candidates: usize,
    pub planning_sessions: usize,
    pub task_seeds: usize,
    pub accepted_planning_refs: usize,
    pub memory_proposals: usize,
    pub accepted_memories: usize,
    pub research_runs: usize,
    pub runtime_evidence_refs: usize,
    pub command_evidence_refs: usize,
    pub review_refs: usize,
    pub scm_readiness_refs: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProductWorkflowGapDto {
    pub area: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProductWorkflowNoEffectsDto {
    pub task_mutation_performed: bool,
    pub provider_execution_performed: bool,
    pub provider_write_performed: bool,
    pub scm_or_forge_mutation_performed: bool,
    pub accepted_memory_apply_performed: bool,
    pub projection_write_performed: bool,
    pub agent_scheduling_performed: bool,
    pub ui_effect_performed: bool,
}

impl From<&ProductWorkflowSummary> for ControlProductWorkflowSummaryDto {
    fn from(summary: &ProductWorkflowSummary) -> Self {
        Self {
            summary_id: summary.summary_id.clone(),
            project_id: summary.project_id.0.clone(),
            project: ControlProductWorkflowProjectDto::from(&summary.project),
            task_lanes: summary
                .task_lanes
                .iter()
                .map(ControlProductWorkflowLaneDto::from)
                .collect(),
            planning_context: ControlProductWorkflowPlanningContextDto::from(
                &summary.planning_context,
            ),
            context: ControlProductWorkflowContextDto::from(&summary.context),
            runtime: ControlProductWorkflowRuntimeDto::from(&summary.runtime),
            review: ControlProductWorkflowReviewDto::from(&summary.review),
            scm_readiness: ControlProductWorkflowScmReadinessDto::from(&summary.scm_readiness),
            next: ControlProductWorkflowNextDto::from(&summary.next),
            source_counts: ControlProductWorkflowSourceCountsDto::from(&summary.source_counts),
            gaps: summary
                .gaps
                .iter()
                .map(ControlProductWorkflowGapDto::from)
                .collect(),
            no_effects: ControlProductWorkflowNoEffectsDto::from(&summary.no_effects),
        }
    }
}

impl From<&ProductWorkflowProjectSummary> for ControlProductWorkflowProjectDto {
    fn from(project: &ProductWorkflowProjectSummary) -> Self {
        Self {
            display_name: project.display_name.clone(),
            status: project.status.clone(),
            authority_refs: project.authority_refs.clone(),
        }
    }
}

impl From<&ProductWorkflowLaneSummary> for ControlProductWorkflowLaneDto {
    fn from(lane: &ProductWorkflowLaneSummary) -> Self {
        Self {
            lane: task_lane_label(lane.lane).to_owned(),
            count: lane.count,
            task_refs: lane.task_refs.clone(),
            rationale_refs: lane.rationale_refs.clone(),
        }
    }
}

impl From<&ProductWorkflowPlanningContext> for ControlProductWorkflowPlanningContextDto {
    fn from(context: &ProductWorkflowPlanningContext) -> Self {
        Self {
            planning_session_refs: context.planning_session_refs.clone(),
            task_seed_refs: context.task_seed_refs.clone(),
            accepted_planning_refs: context.accepted_planning_refs.clone(),
        }
    }
}

impl From<&ProductWorkflowContextSummary> for ControlProductWorkflowContextDto {
    fn from(context: &ProductWorkflowContextSummary) -> Self {
        Self {
            memory_proposal_refs: context.memory_proposal_refs.clone(),
            accepted_memory_refs: context.accepted_memory_refs.clone(),
            research_run_refs: context.research_run_refs.clone(),
        }
    }
}

impl From<&ProductWorkflowRuntimeSummary> for ControlProductWorkflowRuntimeDto {
    fn from(runtime: &ProductWorkflowRuntimeSummary) -> Self {
        Self {
            runtime_evidence_refs: runtime.runtime_evidence_refs.clone(),
            command_evidence_refs: runtime.command_evidence_refs.clone(),
        }
    }
}

impl From<&ProductWorkflowReviewSummary> for ControlProductWorkflowReviewDto {
    fn from(review: &ProductWorkflowReviewSummary) -> Self {
        Self {
            review_refs: review.review_refs.clone(),
        }
    }
}

impl From<&ProductWorkflowScmReadinessSummary> for ControlProductWorkflowScmReadinessDto {
    fn from(readiness: &ProductWorkflowScmReadinessSummary) -> Self {
        Self {
            readiness_refs: readiness.readiness_refs.clone(),
        }
    }
}

impl From<&ProductWorkflowNextStep> for ControlProductWorkflowNextDto {
    fn from(next: &ProductWorkflowNextStep) -> Self {
        Self {
            source: next_source_label(next.source).to_owned(),
            next_ref: next.next_ref.clone(),
            summary: next.summary.clone(),
            rationale_refs: next.rationale_refs.clone(),
            blocked_reason: next.blocked_reason.clone(),
        }
    }
}

impl From<&ProductWorkflowSourceCounts> for ControlProductWorkflowSourceCountsDto {
    fn from(counts: &ProductWorkflowSourceCounts) -> Self {
        Self {
            task_candidates: counts.task_candidates,
            planning_sessions: counts.planning_sessions,
            task_seeds: counts.task_seeds,
            accepted_planning_refs: counts.accepted_planning_refs,
            memory_proposals: counts.memory_proposals,
            accepted_memories: counts.accepted_memories,
            research_runs: counts.research_runs,
            runtime_evidence_refs: counts.runtime_evidence_refs,
            command_evidence_refs: counts.command_evidence_refs,
            review_refs: counts.review_refs,
            scm_readiness_refs: counts.scm_readiness_refs,
        }
    }
}

impl From<&ProductWorkflowGap> for ControlProductWorkflowGapDto {
    fn from(gap: &ProductWorkflowGap) -> Self {
        Self {
            area: gap_area_label(gap.area).to_owned(),
            reason: gap.reason.clone(),
        }
    }
}

impl From<&ProductWorkflowNoEffects> for ControlProductWorkflowNoEffectsDto {
    fn from(no_effects: &ProductWorkflowNoEffects) -> Self {
        Self {
            task_mutation_performed: no_effects.task_mutation_performed,
            provider_execution_performed: no_effects.provider_execution_performed,
            provider_write_performed: no_effects.provider_write_performed,
            scm_or_forge_mutation_performed: no_effects.scm_or_forge_mutation_performed,
            accepted_memory_apply_performed: no_effects.accepted_memory_apply_performed,
            projection_write_performed: no_effects.projection_write_performed,
            agent_scheduling_performed: no_effects.agent_scheduling_performed,
            ui_effect_performed: no_effects.ui_effect_performed,
        }
    }
}

fn task_lane_label(lane: ProductWorkflowTaskLane) -> &'static str {
    match lane {
        ProductWorkflowTaskLane::Ready => "ready",
        ProductWorkflowTaskLane::Active => "active",
        ProductWorkflowTaskLane::AwaitingReview => "awaiting_review",
        ProductWorkflowTaskLane::Blocked => "blocked",
        ProductWorkflowTaskLane::RepairRequired => "repair_required",
        ProductWorkflowTaskLane::Completed => "completed",
        ProductWorkflowTaskLane::Archived => "archived",
        ProductWorkflowTaskLane::Unknown => "unknown",
    }
}

fn next_source_label(source: ProductWorkflowNextStepSource) -> &'static str {
    match source {
        ProductWorkflowNextStepSource::Roadmap => "roadmap",
        ProductWorkflowNextStepSource::Task => "task",
        ProductWorkflowNextStepSource::Goal => "goal",
        ProductWorkflowNextStepSource::Planning => "planning",
        ProductWorkflowNextStepSource::Validation => "validation",
        ProductWorkflowNextStepSource::Review => "review",
        ProductWorkflowNextStepSource::Operator => "operator",
        ProductWorkflowNextStepSource::BlockedByMissingPathway => "blocked_by_missing_pathway",
    }
}

fn gap_area_label(area: ProductWorkflowGapArea) -> &'static str {
    match area {
        ProductWorkflowGapArea::Tasks => "tasks",
        ProductWorkflowGapArea::Planning => "planning",
        ProductWorkflowGapArea::Context => "context",
        ProductWorkflowGapArea::Runtime => "runtime",
        ProductWorkflowGapArea::Review => "review",
        ProductWorkflowGapArea::ScmReadiness => "scm_readiness",
        ProductWorkflowGapArea::Next => "next",
    }
}
