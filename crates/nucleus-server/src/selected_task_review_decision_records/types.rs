use serde::{Deserialize, Serialize};

use crate::{
    SelectedTaskReviewDecisionAction, SelectedTaskReviewDecisionAdmission,
    SelectedTaskReviewDecisionOutcome, SelectedTaskReviewNext,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewDecisionPersistenceInput {
    pub admission: SelectedTaskReviewDecisionAdmission,
    pub review_next: SelectedTaskReviewNext,
    pub existing_decision_ids: Vec<String>,
    pub raw_provider_material_present: bool,
    pub raw_command_output_present: bool,
    pub task_lifecycle_mutation_requested: bool,
    pub provider_execution_requested: bool,
    pub scm_or_forge_mutation_requested: bool,
    pub memory_or_planning_apply_requested: bool,
    pub ui_effect_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SelectedTaskReviewDecisionRecord {
    pub decision_id: String,
    pub admission_id: String,
    pub project_id: String,
    pub task_id: String,
    pub work_item_refs: Vec<String>,
    pub action: SelectedTaskReviewDecisionAction,
    pub outcome: SelectedTaskReviewDecisionOutcome,
    pub operator_ref: String,
    pub expected_revision: String,
    pub reviewed_evidence_refs: Vec<String>,
    pub receipt_refs: Vec<String>,
    pub timeline_refs: Vec<String>,
    pub reason_summary: Option<String>,
    pub idempotency_key: String,
    pub status: SelectedTaskReviewDecisionPersistenceStatus,
    pub blockers: Vec<SelectedTaskReviewDecisionPersistenceBlocker>,
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectedTaskReviewDecisionPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectedTaskReviewDecisionPersistenceBlocker {
    AdmissionNotAdmitted,
    MissingCommand,
    ProjectMismatch,
    TaskMismatch,
    MissingWorkItemRef,
    MissingEvidenceRef,
    RawProviderMaterialPresent,
    RawCommandOutputPresent,
    TaskLifecycleMutationRequested,
    ProviderExecutionRequested,
    ScmOrForgeMutationRequested,
    MemoryOrPlanningApplyRequested,
    UiEffectRequested,
}
