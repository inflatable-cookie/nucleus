//! Task workflow query builders: selected-task read models, planning and
//! memory domains, and accepted-memory diagnostics.
//!
//! Module index over the query surface: task and selected-task query
//! builders, planning-domain builders, and the existing accepted-memory and
//! review submodules.

mod accepted_memory;
mod planning;
mod selected_task_completion_route_apply;
mod selected_task_review_decision;
mod selected_task_rework_preparation;
mod selected;
mod task;

pub(super) use accepted_memory::{
    accepted_memory_active_apply_diagnostics_query_from_action,
    accepted_memory_import_apply_review_diagnostics_query_from_action,
    accepted_memory_projection_diagnostics_query_from_action,
    accepted_memory_projection_import_apply_diagnostics_query_from_action,
    accepted_memory_projection_import_diagnostics_query_from_action,
    accepted_memory_projection_write_diagnostics_query_from_action,
    accepted_memory_query_from_action, accepted_memory_review_readiness_query_from_action,
    accepted_memory_review_receipt_storage_diagnostics_query_from_action,
};
pub(super) use selected_task_completion_route_apply::selected_task_completion_route_apply_query_from_action;
pub(super) use selected_task_review_decision::{
    selected_task_review_decision_action_label,
    selected_task_review_decision_admission_query_from_action,
    selected_task_review_decision_apply_query_from_action,
};
pub(super) use selected_task_rework_preparation::selected_task_rework_preparation_query_from_action;

pub(super) use planning::{
    memory_proposal_review_diagnostics_query_from_action, memory_proposals_query_from_action,
    planning_sessions_query_from_action, planning_task_seeds_query_from_action,
    research_run_briefs_query_from_action, task_seed_promotion_diagnostics_query_from_action,
};
pub(super) use selected::{
    selected_task_action_family_label, selected_task_command_admission_query_from_action,
    selected_task_product_aggregate_query_from_action,
    selected_task_route_admission_query_from_action,
    selected_task_scm_handoff_query_from_action,
};
pub(super) use task::{
    selected_task_action_readiness_query_from_action,
    selected_task_operator_action_gate_query_from_action,
    selected_task_review_next_query_from_action,
    selected_task_review_outcome_route_query_from_action, task_readiness_query_from_action,
    task_timeline_query_from_action, task_workflow_drilldown_query_from_action,
};
