use serde::{Deserialize, Serialize};

use crate::{
    SelectedTaskActionFamily, SelectedTaskActionStatus, SelectedTaskOperatorActionBlocker,
    SelectedTaskOperatorActionCandidate, SelectedTaskOperatorActionDisposition,
    SelectedTaskOperatorActionGate, SelectedTaskOperatorActionGateSourceCounts,
    SelectedTaskOperatorTaskCommandAction, SelectedTaskOperatorTaskCommandCandidate,
    TaskWorkflowNoEffects,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskOperatorActionGateDto {
    pub gate_id: String,
    pub project_id: String,
    pub task_id: String,
    pub expected_revision: Option<String>,
    pub actor_ref: Option<String>,
    pub candidates: Vec<ControlSelectedTaskOperatorActionCandidateDto>,
    pub source_counts: ControlSelectedTaskOperatorActionGateSourceCountsDto,
    pub blockers: Vec<ControlSelectedTaskOperatorActionBlockerDto>,
    pub no_effects: ControlSelectedTaskOperatorActionNoEffectsDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskOperatorActionCandidateDto {
    pub family: String,
    pub readiness_status: String,
    pub disposition: String,
    pub task_command: Option<ControlSelectedTaskOperatorTaskCommandCandidateDto>,
    pub label: String,
    pub reason: String,
    pub evidence_refs: Vec<String>,
    pub blocker_refs: Vec<String>,
    pub expected_revision_required: bool,
    pub reason_required: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskOperatorTaskCommandCandidateDto {
    pub action: String,
    pub task_id: String,
    pub expected_revision: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskOperatorActionBlockerDto {
    pub family: String,
    pub reason: String,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskOperatorActionGateSourceCountsDto {
    #[ts(as = "u32")]
    pub readiness_actions: usize,
    #[ts(as = "u32")]
    pub task_command_candidates: usize,
    #[ts(as = "u32")]
    pub blocked_actions: usize,
    #[ts(as = "u32")]
    pub read_only_actions: usize,
    #[ts(as = "u32")]
    pub deferred_actions: usize,
    #[ts(as = "u32")]
    pub evidence_refs: usize,
    #[ts(as = "u32")]
    pub blocker_refs: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskOperatorActionNoEffectsDto {
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

impl From<&SelectedTaskOperatorActionGate> for ControlSelectedTaskOperatorActionGateDto {
    fn from(gate: &SelectedTaskOperatorActionGate) -> Self {
        Self {
            gate_id: gate.gate_id.clone(),
            project_id: gate.project_id.0.clone(),
            task_id: gate.task_id.0.clone(),
            expected_revision: gate
                .expected_revision
                .as_ref()
                .map(|revision| revision.0.clone()),
            actor_ref: gate.actor_ref.clone(),
            candidates: gate
                .candidates
                .iter()
                .map(ControlSelectedTaskOperatorActionCandidateDto::from)
                .collect(),
            source_counts: ControlSelectedTaskOperatorActionGateSourceCountsDto::from(
                &gate.source_counts,
            ),
            blockers: gate
                .blockers
                .iter()
                .map(ControlSelectedTaskOperatorActionBlockerDto::from)
                .collect(),
            no_effects: ControlSelectedTaskOperatorActionNoEffectsDto::from(&gate.no_effects),
        }
    }
}

impl From<&SelectedTaskOperatorActionCandidate> for ControlSelectedTaskOperatorActionCandidateDto {
    fn from(candidate: &SelectedTaskOperatorActionCandidate) -> Self {
        Self {
            family: action_family_label(candidate.family).to_owned(),
            readiness_status: action_status_label(candidate.readiness_status).to_owned(),
            disposition: disposition_label(candidate.disposition).to_owned(),
            task_command: candidate
                .task_command
                .as_ref()
                .map(ControlSelectedTaskOperatorTaskCommandCandidateDto::from),
            label: candidate.label.clone(),
            reason: candidate.reason.clone(),
            evidence_refs: candidate.evidence_refs.clone(),
            blocker_refs: candidate.blocker_refs.clone(),
            expected_revision_required: candidate.expected_revision_required,
            reason_required: candidate.reason_required,
        }
    }
}

impl From<&SelectedTaskOperatorTaskCommandCandidate>
    for ControlSelectedTaskOperatorTaskCommandCandidateDto
{
    fn from(candidate: &SelectedTaskOperatorTaskCommandCandidate) -> Self {
        Self {
            action: task_command_action_label(candidate.action).to_owned(),
            task_id: candidate.task_id.0.clone(),
            expected_revision: candidate
                .expected_revision
                .as_ref()
                .map(|revision| revision.0.clone()),
        }
    }
}

impl From<&SelectedTaskOperatorActionBlocker> for ControlSelectedTaskOperatorActionBlockerDto {
    fn from(blocker: &SelectedTaskOperatorActionBlocker) -> Self {
        Self {
            family: action_family_label(blocker.family).to_owned(),
            reason: blocker.reason.clone(),
            evidence_refs: blocker.evidence_refs.clone(),
        }
    }
}

impl From<&SelectedTaskOperatorActionGateSourceCounts>
    for ControlSelectedTaskOperatorActionGateSourceCountsDto
{
    fn from(counts: &SelectedTaskOperatorActionGateSourceCounts) -> Self {
        Self {
            readiness_actions: counts.readiness_actions,
            task_command_candidates: counts.task_command_candidates,
            blocked_actions: counts.blocked_actions,
            read_only_actions: counts.read_only_actions,
            deferred_actions: counts.deferred_actions,
            evidence_refs: counts.evidence_refs,
            blocker_refs: counts.blocker_refs,
        }
    }
}

impl From<&TaskWorkflowNoEffects> for ControlSelectedTaskOperatorActionNoEffectsDto {
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

fn disposition_label(disposition: SelectedTaskOperatorActionDisposition) -> &'static str {
    match disposition {
        SelectedTaskOperatorActionDisposition::TaskCommandCandidate => "task_command_candidate",
        SelectedTaskOperatorActionDisposition::Blocked => "blocked",
        SelectedTaskOperatorActionDisposition::ReadOnly => "read_only",
        SelectedTaskOperatorActionDisposition::Deferred => "deferred",
    }
}

fn task_command_action_label(action: SelectedTaskOperatorTaskCommandAction) -> &'static str {
    match action {
        SelectedTaskOperatorTaskCommandAction::Start => "start",
        SelectedTaskOperatorTaskCommandAction::Block => "block",
        SelectedTaskOperatorTaskCommandAction::Complete => "complete",
        SelectedTaskOperatorTaskCommandAction::Archive => "archive",
    }
}
