//! Selected-task product DTO types.
//!
//! Split from the selected_task_product_aggregate god file; behavior
//! unchanged.

use serde::{Deserialize, Serialize};

use super::super::task_workflow_drilldown::ControlTaskWorkflowNoEffectsDto;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskProductAggregateDto {
    pub aggregate_id: String,
    pub project_id: String,
    pub task_id: String,
    pub identity: ControlSelectedTaskProductIdentityDto,
    pub workflow: ControlSelectedTaskProductWorkflowDto,
    pub readiness: ControlSelectedTaskProductReadinessDto,
    pub command_previews: ControlSelectedTaskProductCommandPreviewsDto,
    pub work_evidence: ControlSelectedTaskProductWorkEvidenceDto,
    pub review: ControlSelectedTaskProductReviewDto,
    pub rework: ControlSelectedTaskProductReworkDto,
    pub completion: ControlSelectedTaskProductCompletionDto,
    pub scm_handoff: ControlSelectedTaskProductScmHandoffDto,
    pub source_health: ControlSelectedTaskProductSourceHealthDto,
    pub gaps: Vec<ControlSelectedTaskProductGapDto>,
    pub no_effects: ControlTaskWorkflowNoEffectsDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskProductIdentityDto {
    pub title: Option<String>,
    pub activity: Option<String>,
    pub assignment: Option<String>,
    pub action_type: Option<String>,
    pub expected_revision: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskProductWorkflowDto {
    pub primary_next_action: String,
    pub reason: String,
    pub phase: String,
    pub next_ref: Option<String>,
    pub blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskProductReadinessDto {
    pub blockers: Vec<ControlSelectedTaskProductBlockerDto>,
    pub unavailable_actions: Vec<ControlSelectedTaskProductUnavailableActionDto>,
    #[ts(as = "u32")]
    pub allowed_action_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskProductBlockerDto {
    pub family: String,
    pub reason: String,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskProductUnavailableActionDto {
    pub family: String,
    pub status: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskProductCommandPreviewsDto {
    #[ts(as = "u32")]
    pub admitted_count: usize,
    #[ts(as = "u32")]
    pub refused_count: usize,
    pub previews: Vec<ControlSelectedTaskProductCommandPreviewDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskProductCommandPreviewDto {
    pub family: String,
    pub status: String,
    pub command_available: bool,
    pub refusal_reason: Option<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskProductWorkEvidenceDto {
    pub work_item_refs: Vec<String>,
    #[ts(as = "u32")]
    pub active_work_item_count: usize,
    #[ts(as = "u32")]
    pub completed_work_item_count: usize,
    pub evidence_refs: Vec<String>,
    pub timeline_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskProductReviewDto {
    pub state: Option<String>,
    pub next_category: Option<String>,
    pub route_status: Option<String>,
    pub primary_route: Option<String>,
    pub decision_ref: Option<String>,
    pub decision_available: bool,
    pub blocker_reasons: Vec<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskProductReworkDto {
    pub status: Option<String>,
    pub summary: Option<String>,
    pub refusal_reason: Option<String>,
    pub reviewed_work_item_refs: Vec<String>,
    pub reviewed_evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskProductCompletionDto {
    pub status: Option<String>,
    pub command_available: bool,
    pub refusal_reason: Option<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskProductScmHandoffDto {
    pub state: Option<String>,
    pub next_category: Option<String>,
    pub target_shape: Option<String>,
    pub blocker_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    #[ts(as = "u32")]
    pub gap_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskProductSourceHealthDto {
    pub sources: Vec<ControlSelectedTaskProductSourceStatusDto>,
    #[ts(as = "u32")]
    pub missing_count: usize,
    #[ts(as = "u32")]
    pub partial_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskProductSourceStatusDto {
    pub source: String,
    pub state: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskProductGapDto {
    pub source: String,
    pub reason: String,
}
