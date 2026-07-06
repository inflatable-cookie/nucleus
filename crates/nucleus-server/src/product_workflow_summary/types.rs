use nucleus_projects::ProjectId;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductWorkflowSummaryInput {
    pub project_id: ProjectId,
    pub project_display_name: Option<String>,
    pub project_status: Option<String>,
    pub authority_refs: Vec<String>,
    pub task_candidates: Vec<ProductWorkflowTaskCandidateInput>,
    pub planning_session_refs: Vec<String>,
    pub task_seed_refs: Vec<String>,
    pub accepted_planning_refs: Vec<String>,
    pub memory_proposal_refs: Vec<String>,
    pub accepted_memory_refs: Vec<String>,
    pub research_run_refs: Vec<String>,
    pub runtime_evidence_refs: Vec<String>,
    pub command_evidence_refs: Vec<String>,
    pub review_refs: Vec<String>,
    pub scm_readiness_refs: Vec<String>,
    pub next_step: Option<ProductWorkflowNextStepInput>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ProductWorkflowTaskLane {
    Ready,
    Active,
    AwaitingReview,
    Blocked,
    RepairRequired,
    Completed,
    Archived,
    Unknown,
}

impl ProductWorkflowTaskLane {
    pub const ORDERED: [Self; 8] = [
        Self::Ready,
        Self::Active,
        Self::AwaitingReview,
        Self::Blocked,
        Self::RepairRequired,
        Self::Completed,
        Self::Archived,
        Self::Unknown,
    ];
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductWorkflowTaskCandidateInput {
    pub task_ref: String,
    pub lane: ProductWorkflowTaskLane,
    pub rationale_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductWorkflowNextStepInput {
    pub source: ProductWorkflowNextStepSource,
    pub next_ref: Option<String>,
    pub summary: String,
    pub rationale_refs: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProductWorkflowNextStepSource {
    Roadmap,
    Task,
    Goal,
    Planning,
    Validation,
    Review,
    Operator,
    BlockedByMissingPathway,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductWorkflowSummary {
    pub summary_id: String,
    pub project_id: ProjectId,
    pub project: ProductWorkflowProjectSummary,
    pub task_lanes: Vec<ProductWorkflowLaneSummary>,
    pub planning_context: ProductWorkflowPlanningContext,
    pub context: ProductWorkflowContextSummary,
    pub runtime: ProductWorkflowRuntimeSummary,
    pub review: ProductWorkflowReviewSummary,
    pub scm_readiness: ProductWorkflowScmReadinessSummary,
    pub next: ProductWorkflowNextStep,
    pub source_counts: ProductWorkflowSourceCounts,
    pub gaps: Vec<ProductWorkflowGap>,
    pub no_effects: ProductWorkflowNoEffects,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductWorkflowProjectSummary {
    pub display_name: Option<String>,
    pub status: Option<String>,
    pub authority_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductWorkflowLaneSummary {
    pub lane: ProductWorkflowTaskLane,
    pub count: usize,
    pub task_refs: Vec<String>,
    pub rationale_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductWorkflowPlanningContext {
    pub planning_session_refs: Vec<String>,
    pub task_seed_refs: Vec<String>,
    pub accepted_planning_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductWorkflowContextSummary {
    pub memory_proposal_refs: Vec<String>,
    pub accepted_memory_refs: Vec<String>,
    pub research_run_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductWorkflowRuntimeSummary {
    pub runtime_evidence_refs: Vec<String>,
    pub command_evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductWorkflowReviewSummary {
    pub review_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductWorkflowScmReadinessSummary {
    pub readiness_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductWorkflowNextStep {
    pub source: ProductWorkflowNextStepSource,
    pub next_ref: Option<String>,
    pub summary: String,
    pub rationale_refs: Vec<String>,
    pub blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductWorkflowSourceCounts {
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductWorkflowGap {
    pub area: ProductWorkflowGapArea,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProductWorkflowGapArea {
    Tasks,
    Planning,
    Context,
    Runtime,
    Review,
    ScmReadiness,
    Next,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductWorkflowNoEffects {
    pub task_mutation_performed: bool,
    pub provider_execution_performed: bool,
    pub provider_write_performed: bool,
    pub scm_or_forge_mutation_performed: bool,
    pub accepted_memory_apply_performed: bool,
    pub projection_write_performed: bool,
    pub agent_scheduling_performed: bool,
    pub ui_effect_performed: bool,
}

impl ProductWorkflowNoEffects {
    pub fn read_only() -> Self {
        Self {
            task_mutation_performed: false,
            provider_execution_performed: false,
            provider_write_performed: false,
            scm_or_forge_mutation_performed: false,
            accepted_memory_apply_performed: false,
            projection_write_performed: false,
            agent_scheduling_performed: false,
            ui_effect_performed: false,
        }
    }
}
