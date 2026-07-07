use serde::{Deserialize, Serialize};

use crate::{
    SelectedTaskActionFamily, SelectedTaskActionStatus, SelectedTaskCommandAdmission,
    SelectedTaskCommandAdmissionRefusal, SelectedTaskCommandAdmissionRefusalKind,
    SelectedTaskCommandAdmissionStatus, SelectedTaskOperatorActionCandidate,
    SelectedTaskOperatorActionDisposition, TaskCommand, TaskWorkflowNoEffects,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskCommandAdmissionDto {
    pub admission_id: String,
    pub project_id: String,
    pub task_id: String,
    pub family: String,
    pub status: String,
    pub command: Option<ControlSelectedTaskCommandAdmissionCommandDto>,
    pub candidate: Option<ControlSelectedTaskCommandAdmissionCandidateDto>,
    pub refusal: Option<ControlSelectedTaskCommandAdmissionRefusalDto>,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub no_effects: ControlSelectedTaskCommandAdmissionNoEffectsDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskCommandAdmissionCommandDto {
    pub action: String,
    pub task_id: String,
    pub expected_revision: Option<String>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskCommandAdmissionCandidateDto {
    pub family: String,
    pub readiness_status: String,
    pub disposition: String,
    pub label: String,
    pub reason: String,
    pub evidence_refs: Vec<String>,
    pub blocker_refs: Vec<String>,
    pub expected_revision_required: bool,
    pub reason_required: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskCommandAdmissionRefusalDto {
    pub kind: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskCommandAdmissionNoEffectsDto {
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

impl From<&SelectedTaskCommandAdmission> for ControlSelectedTaskCommandAdmissionDto {
    fn from(admission: &SelectedTaskCommandAdmission) -> Self {
        Self {
            admission_id: admission.admission_id.clone(),
            project_id: admission.project_id.0.clone(),
            task_id: admission.task_id.0.clone(),
            family: action_family_label(admission.family).to_owned(),
            status: admission_status_label(admission.status).to_owned(),
            command: admission
                .command
                .as_ref()
                .map(ControlSelectedTaskCommandAdmissionCommandDto::from),
            candidate: admission
                .candidate
                .as_ref()
                .map(ControlSelectedTaskCommandAdmissionCandidateDto::from),
            refusal: admission
                .refusal
                .as_ref()
                .map(ControlSelectedTaskCommandAdmissionRefusalDto::from),
            operator_ref: admission.operator_ref.clone(),
            evidence_refs: admission.evidence_refs.clone(),
            no_effects: ControlSelectedTaskCommandAdmissionNoEffectsDto::from(
                &admission.no_effects,
            ),
        }
    }
}

impl From<&TaskCommand> for ControlSelectedTaskCommandAdmissionCommandDto {
    fn from(command: &TaskCommand) -> Self {
        match command {
            TaskCommand::Start(command) => Self {
                action: "start".to_owned(),
                task_id: command.task_id.0.clone(),
                expected_revision: command
                    .expected_revision
                    .as_ref()
                    .map(|revision| revision.0.clone()),
                reason: None,
            },
            TaskCommand::Block {
                task_id,
                reason,
                expected_revision,
            } => Self {
                action: "block".to_owned(),
                task_id: task_id.0.clone(),
                expected_revision: expected_revision
                    .as_ref()
                    .map(|revision| revision.0.clone()),
                reason: Some(reason.clone()),
            },
            TaskCommand::Complete(command) => Self {
                action: "complete".to_owned(),
                task_id: command.task_id.0.clone(),
                expected_revision: command
                    .expected_revision
                    .as_ref()
                    .map(|revision| revision.0.clone()),
                reason: None,
            },
            TaskCommand::Archive(command) => Self {
                action: "archive".to_owned(),
                task_id: command.task_id.0.clone(),
                expected_revision: command
                    .expected_revision
                    .as_ref()
                    .map(|revision| revision.0.clone()),
                reason: None,
            },
            TaskCommand::Create(_)
            | TaskCommand::PromoteSeed(_)
            | TaskCommand::Update(_)
            | TaskCommand::Delegate(_) => Self {
                action: "unsupported".to_owned(),
                task_id: String::new(),
                expected_revision: None,
                reason: None,
            },
        }
    }
}

impl From<&SelectedTaskOperatorActionCandidate>
    for ControlSelectedTaskCommandAdmissionCandidateDto
{
    fn from(candidate: &SelectedTaskOperatorActionCandidate) -> Self {
        Self {
            family: action_family_label(candidate.family).to_owned(),
            readiness_status: action_status_label(candidate.readiness_status).to_owned(),
            disposition: disposition_label(candidate.disposition).to_owned(),
            label: candidate.label.clone(),
            reason: candidate.reason.clone(),
            evidence_refs: candidate.evidence_refs.clone(),
            blocker_refs: candidate.blocker_refs.clone(),
            expected_revision_required: candidate.expected_revision_required,
            reason_required: candidate.reason_required,
        }
    }
}

impl From<&SelectedTaskCommandAdmissionRefusal> for ControlSelectedTaskCommandAdmissionRefusalDto {
    fn from(refusal: &SelectedTaskCommandAdmissionRefusal) -> Self {
        Self {
            kind: refusal_kind_label(refusal.kind).to_owned(),
            reason: refusal.reason.clone(),
        }
    }
}

impl From<&TaskWorkflowNoEffects> for ControlSelectedTaskCommandAdmissionNoEffectsDto {
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

fn admission_status_label(status: SelectedTaskCommandAdmissionStatus) -> &'static str {
    match status {
        SelectedTaskCommandAdmissionStatus::Admitted => "admitted",
        SelectedTaskCommandAdmissionStatus::Refused => "refused",
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

fn refusal_kind_label(kind: SelectedTaskCommandAdmissionRefusalKind) -> &'static str {
    match kind {
        SelectedTaskCommandAdmissionRefusalKind::MissingOperatorIntent => "missing_operator_intent",
        SelectedTaskCommandAdmissionRefusalKind::CandidateNotFound => "candidate_not_found",
        SelectedTaskCommandAdmissionRefusalKind::CandidateNotAdmitted => "candidate_not_admitted",
        SelectedTaskCommandAdmissionRefusalKind::ExpectedRevisionRequired => {
            "expected_revision_required"
        }
        SelectedTaskCommandAdmissionRefusalKind::ReasonRequired => "reason_required",
        SelectedTaskCommandAdmissionRefusalKind::CandidateTaskMismatch => "candidate_task_mismatch",
        SelectedTaskCommandAdmissionRefusalKind::UnsupportedAction => "unsupported_action",
    }
}
