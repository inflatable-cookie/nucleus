use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskWorkflowTaskDto {
    pub title: String,
    pub activity: String,
    pub assignment: String,
    pub action_type: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskWorkflowReadinessDto {
    pub lane: String,
    pub rationale_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskWorkflowTimelineDto {
    pub entry_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskWorkflowWorkProgressDto {
    pub work_items: Vec<ControlTaskWorkflowWorkItemDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskWorkflowWorkItemDto {
    pub work_item_ref: String,
    pub runtime_status: String,
    pub review_status: String,
    pub source_ref: String,
    #[ts(as = "u32")]
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskWorkflowRuntimeDto {
    pub runtime_receipt_refs: Vec<String>,
    pub command_evidence_refs: Vec<String>,
    pub task_completion_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskWorkflowReviewDto {
    pub review_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskWorkflowScmHandoffDto {
    pub handoff_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskWorkflowNextDto {
    pub source: String,
    pub next_ref: Option<String>,
    pub summary: String,
    pub rationale_refs: Vec<String>,
    pub blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskWorkflowGuidanceDto {
    pub source: String,
    pub safe_action: String,
    pub reason: String,
    pub evidence_refs: Vec<String>,
    pub missing_evidence_areas: Vec<String>,
    pub blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskWorkflowSourceCountsDto {
    #[ts(as = "u32")]
    pub task_records: usize,
    #[ts(as = "u32")]
    pub readiness_refs: usize,
    #[ts(as = "u32")]
    pub timeline_entry_refs: usize,
    #[ts(as = "u32")]
    pub work_items: usize,
    #[ts(as = "u32")]
    pub runtime_receipt_refs: usize,
    #[ts(as = "u32")]
    pub command_evidence_refs: usize,
    #[ts(as = "u32")]
    pub task_completion_refs: usize,
    #[ts(as = "u32")]
    pub review_refs: usize,
    #[ts(as = "u32")]
    pub scm_handoff_refs: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskWorkflowGapDto {
    pub area: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
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
