use serde::{Deserialize, Serialize};

use crate::{
    SelectedTaskReviewDecisionAction, SelectedTaskReviewDecisionAdmission,
    SelectedTaskReviewDecisionAdmissionRefusal, SelectedTaskReviewDecisionAdmissionRefusalKind,
    SelectedTaskReviewDecisionAdmissionStatus, SelectedTaskReviewDecisionCommand,
    SelectedTaskReviewDecisionNoEffects, SelectedTaskReviewDecisionOutcome,
    SelectedTaskReviewDecisionPersistenceBlocker, SelectedTaskReviewDecisionPersistenceStatus,
    SelectedTaskReviewDecisionRecord,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskReviewDecisionAdmissionDto {
    pub admission_id: String,
    pub decision_id: String,
    pub project_id: String,
    pub task_id: String,
    pub action: String,
    pub status: String,
    pub command: Option<ControlSelectedTaskReviewDecisionCommandDto>,
    pub refusal: Option<ControlSelectedTaskReviewDecisionRefusalDto>,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub no_effects: ControlSelectedTaskReviewDecisionNoEffectsDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskReviewDecisionCommandDto {
    pub decision_id: String,
    pub project_id: String,
    pub task_id: String,
    pub action: String,
    pub outcome: String,
    pub expected_revision: String,
    pub operator_ref: String,
    pub reviewed_evidence_refs: Vec<String>,
    pub idempotency_key: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskReviewDecisionRefusalDto {
    pub kind: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskReviewDecisionNoEffectsDto {
    pub review_mutation_performed: bool,
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskReviewDecisionRecordDto {
    pub decision_id: String,
    pub admission_id: String,
    pub project_id: String,
    pub task_id: String,
    pub work_item_refs: Vec<String>,
    pub action: String,
    pub outcome: String,
    pub operator_ref: String,
    pub expected_revision: String,
    pub reviewed_evidence_refs: Vec<String>,
    pub receipt_refs: Vec<String>,
    pub timeline_refs: Vec<String>,
    pub reason_summary: Option<String>,
    pub idempotency_key: String,
    pub status: String,
    pub blockers: Vec<String>,
    pub duplicate_decision_detected: bool,
    pub review_mutation_performed: bool,
    pub task_lifecycle_mutation_performed: bool,
    pub provider_execution_performed: bool,
    pub provider_write_performed: bool,
    pub scm_or_forge_mutation_performed: bool,
    pub accepted_memory_apply_performed: bool,
    pub planning_apply_performed: bool,
    pub projection_write_performed: bool,
    pub agent_scheduling_performed: bool,
    pub ui_effect_performed: bool,
    pub raw_provider_material_retained: bool,
    pub raw_command_output_retained: bool,
}

impl From<&SelectedTaskReviewDecisionAdmission> for ControlSelectedTaskReviewDecisionAdmissionDto {
    fn from(admission: &SelectedTaskReviewDecisionAdmission) -> Self {
        Self {
            admission_id: admission.admission_id.clone(),
            decision_id: admission.decision_id.clone(),
            project_id: admission.project_id.0.clone(),
            task_id: admission.task_id.0.clone(),
            action: decision_action_label(admission.action).to_owned(),
            status: admission_status_label(admission.status).to_owned(),
            command: admission
                .command
                .as_ref()
                .map(ControlSelectedTaskReviewDecisionCommandDto::from),
            refusal: admission
                .refusal
                .as_ref()
                .map(ControlSelectedTaskReviewDecisionRefusalDto::from),
            operator_ref: admission.operator_ref.clone(),
            evidence_refs: admission.evidence_refs.clone(),
            no_effects: ControlSelectedTaskReviewDecisionNoEffectsDto::from(&admission.no_effects),
        }
    }
}

impl From<&SelectedTaskReviewDecisionCommand> for ControlSelectedTaskReviewDecisionCommandDto {
    fn from(command: &SelectedTaskReviewDecisionCommand) -> Self {
        Self {
            decision_id: command.decision_id.clone(),
            project_id: command.project_id.0.clone(),
            task_id: command.task_id.0.clone(),
            action: decision_action_label(command.action).to_owned(),
            outcome: decision_outcome_label(command.outcome).to_owned(),
            expected_revision: command.expected_revision.0.clone(),
            operator_ref: command.operator_ref.clone(),
            reviewed_evidence_refs: command.reviewed_evidence_refs.clone(),
            idempotency_key: command.idempotency_key.clone(),
            reason: command.reason.clone(),
        }
    }
}

impl From<&SelectedTaskReviewDecisionAdmissionRefusal>
    for ControlSelectedTaskReviewDecisionRefusalDto
{
    fn from(refusal: &SelectedTaskReviewDecisionAdmissionRefusal) -> Self {
        Self {
            kind: refusal_kind_label(refusal.kind).to_owned(),
            reason: refusal.reason.clone(),
        }
    }
}

impl From<&SelectedTaskReviewDecisionNoEffects> for ControlSelectedTaskReviewDecisionNoEffectsDto {
    fn from(no_effects: &SelectedTaskReviewDecisionNoEffects) -> Self {
        Self {
            review_mutation_performed: no_effects.review_mutation_performed,
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

impl From<&SelectedTaskReviewDecisionRecord> for ControlSelectedTaskReviewDecisionRecordDto {
    fn from(record: &SelectedTaskReviewDecisionRecord) -> Self {
        Self {
            decision_id: record.decision_id.clone(),
            admission_id: record.admission_id.clone(),
            project_id: record.project_id.clone(),
            task_id: record.task_id.clone(),
            work_item_refs: record.work_item_refs.clone(),
            action: decision_action_label(record.action).to_owned(),
            outcome: decision_outcome_label(record.outcome).to_owned(),
            operator_ref: record.operator_ref.clone(),
            expected_revision: record.expected_revision.clone(),
            reviewed_evidence_refs: record.reviewed_evidence_refs.clone(),
            receipt_refs: record.receipt_refs.clone(),
            timeline_refs: record.timeline_refs.clone(),
            reason_summary: record.reason_summary.clone(),
            idempotency_key: record.idempotency_key.clone(),
            status: persistence_status_label(&record.status).to_owned(),
            blockers: record
                .blockers
                .iter()
                .map(|blocker| persistence_blocker_label(blocker).to_owned())
                .collect(),
            duplicate_decision_detected: record.duplicate_decision_detected,
            review_mutation_performed: record.review_mutation_performed,
            task_lifecycle_mutation_performed: record.task_lifecycle_mutation_performed,
            provider_execution_performed: record.provider_execution_performed,
            provider_write_performed: record.provider_write_performed,
            scm_or_forge_mutation_performed: record.scm_or_forge_mutation_performed,
            accepted_memory_apply_performed: record.accepted_memory_apply_performed,
            planning_apply_performed: record.planning_apply_performed,
            projection_write_performed: record.projection_write_performed,
            agent_scheduling_performed: record.agent_scheduling_performed,
            ui_effect_performed: record.ui_effect_performed,
            raw_provider_material_retained: record.raw_provider_material_retained,
            raw_command_output_retained: record.raw_command_output_retained,
        }
    }
}

fn decision_action_label(action: SelectedTaskReviewDecisionAction) -> &'static str {
    match action {
        SelectedTaskReviewDecisionAction::AcceptEvidence => "accept_evidence",
        SelectedTaskReviewDecisionAction::RejectEvidence => "reject_evidence",
        SelectedTaskReviewDecisionAction::RequestChanges => "request_changes",
        SelectedTaskReviewDecisionAction::AbandonReview => "abandon_review",
    }
}

fn decision_outcome_label(outcome: SelectedTaskReviewDecisionOutcome) -> &'static str {
    match outcome {
        SelectedTaskReviewDecisionOutcome::Accepted => "accepted",
        SelectedTaskReviewDecisionOutcome::Rejected => "rejected",
        SelectedTaskReviewDecisionOutcome::NeedsChanges => "needs_changes",
        SelectedTaskReviewDecisionOutcome::Abandoned => "abandoned",
    }
}

fn admission_status_label(status: SelectedTaskReviewDecisionAdmissionStatus) -> &'static str {
    match status {
        SelectedTaskReviewDecisionAdmissionStatus::Admitted => "admitted",
        SelectedTaskReviewDecisionAdmissionStatus::Blocked => "blocked",
        SelectedTaskReviewDecisionAdmissionStatus::Stale => "stale",
        SelectedTaskReviewDecisionAdmissionStatus::Duplicate => "duplicate",
        SelectedTaskReviewDecisionAdmissionStatus::Unsupported => "unsupported",
        SelectedTaskReviewDecisionAdmissionStatus::MissingEvidence => "missing_evidence",
        SelectedTaskReviewDecisionAdmissionStatus::NoOp => "no_op",
    }
}

fn refusal_kind_label(kind: SelectedTaskReviewDecisionAdmissionRefusalKind) -> &'static str {
    match kind {
        SelectedTaskReviewDecisionAdmissionRefusalKind::MissingOperator => "missing_operator",
        SelectedTaskReviewDecisionAdmissionRefusalKind::MissingIdempotencyKey => {
            "missing_idempotency_key"
        }
        SelectedTaskReviewDecisionAdmissionRefusalKind::ExpectedRevisionRequired => {
            "expected_revision_required"
        }
        SelectedTaskReviewDecisionAdmissionRefusalKind::StaleRevision => "stale_revision",
        SelectedTaskReviewDecisionAdmissionRefusalKind::DuplicateDecision => "duplicate_decision",
        SelectedTaskReviewDecisionAdmissionRefusalKind::MissingReviewedEvidence => {
            "missing_reviewed_evidence"
        }
        SelectedTaskReviewDecisionAdmissionRefusalKind::UnknownReviewedEvidence => {
            "unknown_reviewed_evidence"
        }
        SelectedTaskReviewDecisionAdmissionRefusalKind::ReasonRequired => "reason_required",
        SelectedTaskReviewDecisionAdmissionRefusalKind::ReviewNotAwaitingDecision => {
            "review_not_awaiting_decision"
        }
        SelectedTaskReviewDecisionAdmissionRefusalKind::DecisionAlreadyRepresented => {
            "decision_already_represented"
        }
    }
}

fn persistence_status_label(status: &SelectedTaskReviewDecisionPersistenceStatus) -> &'static str {
    match status {
        SelectedTaskReviewDecisionPersistenceStatus::Persisted => "persisted",
        SelectedTaskReviewDecisionPersistenceStatus::DuplicateNoop => "duplicate_noop",
        SelectedTaskReviewDecisionPersistenceStatus::Blocked => "blocked",
    }
}

fn persistence_blocker_label(
    blocker: &SelectedTaskReviewDecisionPersistenceBlocker,
) -> &'static str {
    match blocker {
        SelectedTaskReviewDecisionPersistenceBlocker::AdmissionNotAdmitted => {
            "admission_not_admitted"
        }
        SelectedTaskReviewDecisionPersistenceBlocker::MissingCommand => "missing_command",
        SelectedTaskReviewDecisionPersistenceBlocker::ProjectMismatch => "project_mismatch",
        SelectedTaskReviewDecisionPersistenceBlocker::TaskMismatch => "task_mismatch",
        SelectedTaskReviewDecisionPersistenceBlocker::MissingWorkItemRef => "missing_work_item_ref",
        SelectedTaskReviewDecisionPersistenceBlocker::MissingEvidenceRef => "missing_evidence_ref",
        SelectedTaskReviewDecisionPersistenceBlocker::RawProviderMaterialPresent => {
            "raw_provider_material_present"
        }
        SelectedTaskReviewDecisionPersistenceBlocker::RawCommandOutputPresent => {
            "raw_command_output_present"
        }
        SelectedTaskReviewDecisionPersistenceBlocker::TaskLifecycleMutationRequested => {
            "task_lifecycle_mutation_requested"
        }
        SelectedTaskReviewDecisionPersistenceBlocker::ProviderExecutionRequested => {
            "provider_execution_requested"
        }
        SelectedTaskReviewDecisionPersistenceBlocker::ScmOrForgeMutationRequested => {
            "scm_or_forge_mutation_requested"
        }
        SelectedTaskReviewDecisionPersistenceBlocker::MemoryOrPlanningApplyRequested => {
            "memory_or_planning_apply_requested"
        }
        SelectedTaskReviewDecisionPersistenceBlocker::UiEffectRequested => "ui_effect_requested",
    }
}
