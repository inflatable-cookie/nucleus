use serde::{Deserialize, Serialize};

use crate::{
    SelectedTaskAction, SelectedTaskActionBlocker, SelectedTaskActionFamily,
    SelectedTaskActionReadiness, SelectedTaskActionSourceCounts, SelectedTaskActionStatus,
    TaskWorkflowNoEffects,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskActionReadinessDto {
    pub readiness_id: String,
    pub project_id: String,
    pub task_id: String,
    pub actions: Vec<ControlSelectedTaskActionDto>,
    pub source_counts: ControlSelectedTaskActionSourceCountsDto,
    pub blockers: Vec<ControlSelectedTaskActionBlockerDto>,
    pub no_effects: ControlSelectedTaskActionNoEffectsDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskActionDto {
    pub family: String,
    pub status: String,
    pub label: String,
    pub reason: String,
    pub evidence_refs: Vec<String>,
    pub blocker_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskActionBlockerDto {
    pub family: String,
    pub reason: String,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskActionSourceCountsDto {
    pub task_records: usize,
    pub readiness_refs: usize,
    pub work_items: usize,
    pub active_work_items: usize,
    pub completed_work_items: usize,
    pub runtime_evidence_refs: usize,
    pub completion_refs: usize,
    pub review_refs: usize,
    pub scm_handoff_refs: usize,
    pub gap_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskActionNoEffectsDto {
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

impl From<&SelectedTaskActionReadiness> for ControlSelectedTaskActionReadinessDto {
    fn from(readiness: &SelectedTaskActionReadiness) -> Self {
        Self {
            readiness_id: readiness.readiness_id.clone(),
            project_id: readiness.project_id.0.clone(),
            task_id: readiness.task_id.0.clone(),
            actions: readiness
                .actions
                .iter()
                .map(ControlSelectedTaskActionDto::from)
                .collect(),
            source_counts: ControlSelectedTaskActionSourceCountsDto::from(&readiness.source_counts),
            blockers: readiness
                .blockers
                .iter()
                .map(ControlSelectedTaskActionBlockerDto::from)
                .collect(),
            no_effects: ControlSelectedTaskActionNoEffectsDto::from(&readiness.no_effects),
        }
    }
}

impl From<&SelectedTaskAction> for ControlSelectedTaskActionDto {
    fn from(action: &SelectedTaskAction) -> Self {
        Self {
            family: action_family_label(action.family).to_owned(),
            status: action_status_label(action.status).to_owned(),
            label: action.label.clone(),
            reason: action.reason.clone(),
            evidence_refs: action.evidence_refs.clone(),
            blocker_refs: action.blocker_refs.clone(),
        }
    }
}

impl From<&SelectedTaskActionBlocker> for ControlSelectedTaskActionBlockerDto {
    fn from(blocker: &SelectedTaskActionBlocker) -> Self {
        Self {
            family: action_family_label(blocker.family).to_owned(),
            reason: blocker.reason.clone(),
            evidence_refs: blocker.evidence_refs.clone(),
        }
    }
}

impl From<&SelectedTaskActionSourceCounts> for ControlSelectedTaskActionSourceCountsDto {
    fn from(counts: &SelectedTaskActionSourceCounts) -> Self {
        Self {
            task_records: counts.task_records,
            readiness_refs: counts.readiness_refs,
            work_items: counts.work_items,
            active_work_items: counts.active_work_items,
            completed_work_items: counts.completed_work_items,
            runtime_evidence_refs: counts.runtime_evidence_refs,
            completion_refs: counts.completion_refs,
            review_refs: counts.review_refs,
            scm_handoff_refs: counts.scm_handoff_refs,
            gap_count: counts.gap_count,
        }
    }
}

impl From<&TaskWorkflowNoEffects> for ControlSelectedTaskActionNoEffectsDto {
    fn from(no_effects: &TaskWorkflowNoEffects) -> Self {
        Self {
            task_mutation_performed: no_effects.task_mutation_performed,
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

fn action_family_label(family: SelectedTaskActionFamily) -> &'static str {
    match family {
        SelectedTaskActionFamily::PlanSelectedTask => "plan_selected_task",
        SelectedTaskActionFamily::StartSelectedTask => "start_selected_task",
        SelectedTaskActionFamily::BlockSelectedTask => "block_selected_task",
        SelectedTaskActionFamily::CompleteSelectedTask => "complete_selected_task",
        SelectedTaskActionFamily::ArchiveSelectedTask => "archive_selected_task",
        SelectedTaskActionFamily::PrepareDelegation => "prepare_delegation",
        SelectedTaskActionFamily::InspectRuntimeEvidence => "inspect_runtime_evidence",
        SelectedTaskActionFamily::ReviewWorkEvidence => "review_work_evidence",
        SelectedTaskActionFamily::PrepareScmHandoff => "prepare_scm_handoff",
    }
}

fn action_status_label(status: SelectedTaskActionStatus) -> &'static str {
    match status {
        SelectedTaskActionStatus::Allowed => "allowed",
        SelectedTaskActionStatus::Blocked => "blocked",
        SelectedTaskActionStatus::NotApplicable => "not_applicable",
        SelectedTaskActionStatus::DifferentLane => "different_lane",
    }
}
