use serde::{Deserialize, Serialize};

use crate::planning_sessions_projection::{
    PlanningSessionOutputRefs, PlanningSessionSourceCounts, PlanningSessionSourceKind,
    PlanningSessionSourceKindCount, PlanningSessionStatusCount, PlanningSessionSummary,
    PlanningSessionSummaryKind, PlanningSessionSummaryStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlPlanningSessionSummaryDto {
    pub session_id: String,
    pub kind: String,
    pub status: String,
    pub prompt_or_template_refs: Vec<String>,
    #[ts(as = "u32")]
    pub participant_count: usize,
    #[ts(as = "u32")]
    pub source_ref_count: usize,
    pub source_kind_counts: Vec<ControlPlanningSessionSourceKindCountDto>,
    pub output_refs: ControlPlanningSessionOutputRefsDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlPlanningSessionStatusCountDto {
    pub status: String,
    #[ts(as = "u32")]
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlPlanningSessionSourceKindCountDto {
    pub kind: String,
    #[ts(as = "u32")]
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlPlanningSessionSourceCountsDto {
    #[ts(as = "u32")]
    pub planning_session_records: usize,
    #[ts(as = "u32")]
    pub exploration_session_records: usize,
    #[ts(as = "u32")]
    pub prompt_or_template_refs: usize,
    #[ts(as = "u32")]
    pub participant_refs: usize,
    #[ts(as = "u32")]
    pub source_refs: usize,
    #[ts(as = "u32")]
    pub output_refs: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlPlanningSessionOutputRefsDto {
    pub artifact_refs: Vec<String>,
    pub task_seed_refs: Vec<String>,
    pub memory_proposal_refs: Vec<String>,
    pub research_run_brief_refs: Vec<String>,
}

impl From<&PlanningSessionSummary> for ControlPlanningSessionSummaryDto {
    fn from(summary: &PlanningSessionSummary) -> Self {
        Self {
            session_id: summary.session_id.clone(),
            kind: session_kind_dto(&summary.kind),
            status: session_status_dto(&summary.status),
            prompt_or_template_refs: summary.prompt_or_template_refs.clone(),
            participant_count: summary.participant_count,
            source_ref_count: summary.source_ref_count,
            source_kind_counts: summary
                .source_kind_counts
                .iter()
                .map(ControlPlanningSessionSourceKindCountDto::from)
                .collect(),
            output_refs: ControlPlanningSessionOutputRefsDto::from(&summary.output_refs),
        }
    }
}

impl From<&PlanningSessionStatusCount> for ControlPlanningSessionStatusCountDto {
    fn from(count: &PlanningSessionStatusCount) -> Self {
        Self {
            status: session_status_dto(&count.status),
            count: count.count,
        }
    }
}

impl From<&PlanningSessionSourceKindCount> for ControlPlanningSessionSourceKindCountDto {
    fn from(count: &PlanningSessionSourceKindCount) -> Self {
        Self {
            kind: source_kind_dto(&count.kind),
            count: count.count,
        }
    }
}

impl From<&PlanningSessionSourceCounts> for ControlPlanningSessionSourceCountsDto {
    fn from(counts: &PlanningSessionSourceCounts) -> Self {
        Self {
            planning_session_records: counts.planning_session_records,
            exploration_session_records: counts.exploration_session_records,
            prompt_or_template_refs: counts.prompt_or_template_refs,
            participant_refs: counts.participant_refs,
            source_refs: counts.source_refs,
            output_refs: counts.output_refs,
        }
    }
}

impl From<&PlanningSessionOutputRefs> for ControlPlanningSessionOutputRefsDto {
    fn from(refs: &PlanningSessionOutputRefs) -> Self {
        Self {
            artifact_refs: refs.artifact_refs.clone(),
            task_seed_refs: refs.task_seed_refs.clone(),
            memory_proposal_refs: refs.memory_proposal_refs.clone(),
            research_run_brief_refs: refs.research_run_brief_refs.clone(),
        }
    }
}

fn session_kind_dto(kind: &PlanningSessionSummaryKind) -> String {
    match kind {
        PlanningSessionSummaryKind::ProjectIntake => "project_intake",
        PlanningSessionSummaryKind::VisionDefinition => "vision_definition",
        PlanningSessionSummaryKind::Ideation => "ideation",
        PlanningSessionSummaryKind::ArchitecturePlanning => "architecture_planning",
        PlanningSessionSummaryKind::ResearchPlanning => "research_planning",
        PlanningSessionSummaryKind::DeepResearch => "deep_research",
        PlanningSessionSummaryKind::RoadmapPlanning => "roadmap_planning",
        PlanningSessionSummaryKind::TaskBreakdown => "task_breakdown",
        PlanningSessionSummaryKind::DecisionReview => "decision_review",
        PlanningSessionSummaryKind::Other(value) => value,
    }
    .to_owned()
}

fn session_status_dto(status: &PlanningSessionSummaryStatus) -> String {
    match status {
        PlanningSessionSummaryStatus::Draft => "draft",
        PlanningSessionSummaryStatus::Active => "active",
        PlanningSessionSummaryStatus::Paused => "paused",
        PlanningSessionSummaryStatus::Review => "review",
        PlanningSessionSummaryStatus::Accepted => "accepted",
        PlanningSessionSummaryStatus::Superseded => "superseded",
        PlanningSessionSummaryStatus::Archived => "archived",
    }
    .to_owned()
}

fn source_kind_dto(kind: &PlanningSessionSourceKind) -> String {
    match kind {
        PlanningSessionSourceKind::OperatorPrompt => "operator_prompt",
        PlanningSessionSourceKind::ConversationSummary => "conversation_summary",
        PlanningSessionSourceKind::TranscriptRef => "transcript_ref",
        PlanningSessionSourceKind::ExistingDocument => "existing_document",
        PlanningSessionSourceKind::ResearchRun => "research_run",
        PlanningSessionSourceKind::Memory => "memory",
        PlanningSessionSourceKind::Task => "task",
        PlanningSessionSourceKind::ProjectionFile => "projection_file",
        PlanningSessionSourceKind::Other(value) => value,
    }
    .to_owned()
}
