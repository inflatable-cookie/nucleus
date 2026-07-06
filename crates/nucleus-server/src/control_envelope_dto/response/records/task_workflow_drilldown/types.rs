use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlTaskWorkflowDrilldownDto {
    pub drilldown_id: String,
    pub project_id: String,
    pub task_id: String,
    pub task: Option<ControlTaskWorkflowTaskDto>,
    pub readiness: Option<ControlTaskWorkflowReadinessDto>,
    pub timeline: ControlTaskWorkflowTimelineDto,
    pub work_progress: ControlTaskWorkflowWorkProgressDto,
    pub runtime: ControlTaskWorkflowRuntimeDto,
    pub review: ControlTaskWorkflowReviewDto,
    pub scm_handoff: ControlTaskWorkflowScmHandoffDto,
    pub next: ControlTaskWorkflowNextDto,
    pub guidance: ControlTaskWorkflowGuidanceDto,
    pub source_counts: ControlTaskWorkflowSourceCountsDto,
    pub gaps: Vec<ControlTaskWorkflowGapDto>,
    pub no_effects: ControlTaskWorkflowNoEffectsDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlTaskWorkflowTaskDto {
    pub title: String,
    pub activity: String,
    pub assignment: String,
    pub action_type: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlTaskWorkflowReadinessDto {
    pub lane: String,
    pub rationale_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlTaskWorkflowTimelineDto {
    pub entry_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlTaskWorkflowWorkProgressDto {
    pub work_items: Vec<ControlTaskWorkflowWorkItemDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlTaskWorkflowWorkItemDto {
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlTaskWorkflowRuntimeDto {
    pub runtime_receipt_refs: Vec<String>,
    pub command_evidence_refs: Vec<String>,
    pub task_completion_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlTaskWorkflowReviewDto {
    pub review_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlTaskWorkflowScmHandoffDto {
    pub handoff_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlTaskWorkflowNextDto {
    pub source: String,
    pub next_ref: Option<String>,
    pub summary: String,
    pub rationale_refs: Vec<String>,
    pub blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlTaskWorkflowGuidanceDto {
    pub source: String,
    pub safe_action: String,
    pub reason: String,
    pub evidence_refs: Vec<String>,
    pub missing_evidence_areas: Vec<String>,
    pub blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlTaskWorkflowSourceCountsDto {
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlTaskWorkflowGapDto {
    pub area: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlTaskWorkflowNoEffectsDto {
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
