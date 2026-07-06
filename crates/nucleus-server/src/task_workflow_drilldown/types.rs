use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowDrilldownInput {
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub task: Option<TaskWorkflowTaskInput>,
    pub readiness: Option<TaskWorkflowReadinessInput>,
    pub timeline_entry_refs: Vec<String>,
    pub work_progress: Vec<TaskWorkflowWorkProgressInput>,
    pub runtime_receipt_refs: Vec<String>,
    pub command_evidence_refs: Vec<String>,
    pub task_completion_refs: Vec<String>,
    pub review_refs: Vec<String>,
    pub scm_handoff_refs: Vec<String>,
    pub next_step: Option<TaskWorkflowNextStepInput>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowTaskInput {
    pub title: String,
    pub activity: String,
    pub assignment: String,
    pub action_type: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowReadinessInput {
    pub lane: String,
    pub rationale_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowWorkProgressInput {
    pub work_item_ref: String,
    pub runtime_status: String,
    pub review_status: String,
    pub source_ref: String,
    pub source_count: usize,
    pub session_ref: Option<String>,
    pub turn_refs: Vec<String>,
    pub receipt_refs: Vec<String>,
    pub checkpoint_refs: Vec<String>,
    pub diff_summary_refs: Vec<String>,
    pub timeline_entry_refs: Vec<String>,
    pub validation_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub issue_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowNextStepInput {
    pub source: TaskWorkflowNextStepSource,
    pub next_ref: Option<String>,
    pub summary: String,
    pub rationale_refs: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskWorkflowNextStepSource {
    Task,
    Runtime,
    Review,
    ScmHandoff,
    BlockedByMissingPathway,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowDrilldown {
    pub drilldown_id: String,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub task: Option<TaskWorkflowTaskSummary>,
    pub readiness: Option<TaskWorkflowReadinessSummary>,
    pub timeline: TaskWorkflowTimelineSummary,
    pub work_progress: TaskWorkflowWorkProgressSummary,
    pub runtime: TaskWorkflowRuntimeSummary,
    pub review: TaskWorkflowReviewSummary,
    pub scm_handoff: TaskWorkflowScmHandoffSummary,
    pub next: TaskWorkflowNextStep,
    pub guidance: TaskWorkflowGuidance,
    pub source_counts: TaskWorkflowSourceCounts,
    pub gaps: Vec<TaskWorkflowGap>,
    pub no_effects: TaskWorkflowNoEffects,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowTaskSummary {
    pub title: String,
    pub activity: String,
    pub assignment: String,
    pub action_type: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowReadinessSummary {
    pub lane: String,
    pub rationale_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowTimelineSummary {
    pub entry_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowWorkProgressSummary {
    pub work_items: Vec<TaskWorkflowWorkProgressItem>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowWorkProgressItem {
    pub work_item_ref: String,
    pub runtime_status: String,
    pub review_status: String,
    pub source_ref: String,
    pub source_count: usize,
    pub session_ref: Option<String>,
    pub turn_refs: Vec<String>,
    pub receipt_refs: Vec<String>,
    pub checkpoint_refs: Vec<String>,
    pub diff_summary_refs: Vec<String>,
    pub timeline_entry_refs: Vec<String>,
    pub validation_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub issue_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowRuntimeSummary {
    pub runtime_receipt_refs: Vec<String>,
    pub command_evidence_refs: Vec<String>,
    pub task_completion_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowReviewSummary {
    pub review_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowScmHandoffSummary {
    pub handoff_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowNextStep {
    pub source: TaskWorkflowNextStepSource,
    pub next_ref: Option<String>,
    pub summary: String,
    pub rationale_refs: Vec<String>,
    pub blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowGuidance {
    pub source: TaskWorkflowGuidanceSource,
    pub safe_action: TaskWorkflowSafeAction,
    pub reason: String,
    pub evidence_refs: Vec<String>,
    pub missing_evidence_areas: Vec<TaskWorkflowGapArea>,
    pub blocked_reason: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskWorkflowGuidanceSource {
    Task,
    Readiness,
    Runtime,
    Review,
    ScmHandoff,
    Blocked,
    NoOp,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskWorkflowSafeAction {
    Inspect,
    Plan,
    Review,
    PrepareHandoff,
    Wait,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowSourceCounts {
    pub task_records: usize,
    pub readiness_refs: usize,
    pub timeline_entry_refs: usize,
    pub work_items: usize,
    pub runtime_receipt_refs: usize,
    pub command_evidence_refs: usize,
    pub task_completion_refs: usize,
    pub review_refs: usize,
    pub scm_handoff_refs: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowGap {
    pub area: TaskWorkflowGapArea,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskWorkflowGapArea {
    Task,
    Readiness,
    Timeline,
    WorkProgress,
    Runtime,
    Review,
    ScmHandoff,
    Next,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowNoEffects {
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

impl TaskWorkflowNoEffects {
    pub fn read_only() -> Self {
        Self {
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
