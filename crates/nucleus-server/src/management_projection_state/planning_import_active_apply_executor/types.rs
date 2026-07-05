use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PlanningProjectionImportActiveApplyExecutorRequest {
    pub executor_plan_id: String,
    pub admission_record: Option<super::super::PlanningProjectionImportActiveApplyAdmissionRecord>,
    pub existing_executor_plan_ids: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub active_planning_mutation_requested: bool,
    pub final_mutation_receipt_requested: bool,
    pub task_creation_requested: bool,
    pub task_promotion_requested: bool,
    pub projection_write_requested: bool,
    pub agent_scheduling_requested: bool,
    pub provider_execution_requested: bool,
    pub scm_mutation_requested: bool,
    pub forge_mutation_requested: bool,
    pub semantic_merge_requested: bool,
    pub accepted_memory_mutation_requested: bool,
    pub callback_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
    pub ui_apply_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningProjectionImportActiveApplyExecutorPlan {
    pub executor_plan_id: String,
    pub admission_record_id: Option<String>,
    pub stopped_apply_record_id: Option<String>,
    pub dry_run_apply_plan_id: Option<String>,
    pub operator_ref: Option<String>,
    pub approval_ref: Option<String>,
    pub status: PlanningProjectionImportActiveApplyExecutorStatus,
    pub blockers: Vec<PlanningProjectionImportActiveApplyExecutorBlocker>,
    pub operation_plans: Vec<PlanningProjectionImportActiveApplyExecutorOperationPlan>,
    pub planned_receipts: Vec<PlanningProjectionImportActiveApplyExecutorReceiptPlan>,
    pub evidence_refs: Vec<String>,
    pub executor_planned: bool,
    pub duplicate_executor_plan_detected: bool,
    pub active_planning_mutation_permitted: bool,
    pub final_mutation_receipt_permitted: bool,
    pub task_creation_permitted: bool,
    pub task_promotion_permitted: bool,
    pub projection_write_permitted: bool,
    pub agent_scheduling_permitted: bool,
    pub provider_execution_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub forge_mutation_permitted: bool,
    pub semantic_merge_permitted: bool,
    pub accepted_memory_mutation_permitted: bool,
    pub callback_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub raw_payload_retained: bool,
    pub payload_body_included: bool,
    pub ui_apply_permitted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningProjectionImportActiveApplyExecutorOperationPlan {
    pub operation_plan_id: String,
    pub source_operation_id: String,
    pub record_id: String,
    pub file_ref: String,
    pub operation_kind: String,
    pub expected_current_revision: Option<String>,
    pub observed_current_revision: Option<String>,
    pub revision_expectation_ref: Option<String>,
    pub evidence_refs: Vec<String>,
    pub active_planning_mutation_permitted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningProjectionImportActiveApplyExecutorReceiptPlan {
    pub receipt_id: String,
    pub operation_plan_id: String,
    pub source_operation_id: String,
    pub status: String,
    pub evidence_refs: Vec<String>,
    pub final_mutation_receipt: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningProjectionImportActiveApplyExecutorStatus {
    PlannedStopped,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningProjectionImportActiveApplyExecutorBlocker {
    MissingExecutorPlanId,
    DuplicateExecutorPlanId { executor_plan_id: String },
    MissingAdmissionRecord,
    AdmissionNotAdmitted { status: String },
    ApplyNotAdmitted,
    MissingStoppedApplyRecordId,
    MissingDryRunApplyPlanId,
    MissingOperatorRef,
    MissingApprovalRef,
    MissingOperationRef,
    MissingOperationId { index: usize },
    MissingOperationRecordId { operation_id: String },
    MissingOperationFileRef { operation_id: String },
    MissingOperationEvidenceRef { operation_id: String },
    MissingRevisionExpectation { operation_id: String },
    StaleRevision,
    ConflictEvidence,
    UnsupportedOperationKind,
    RepairRequired,
    MissingRef,
    AdmissionBlockerPresent { blocker: String },
    RawPayloadPresent,
    PayloadBodyIncluded,
    ActivePlanningMutationRequested,
    FinalMutationReceiptRequested,
    TaskCreationRequested,
    TaskPromotionRequested,
    ProjectionWriteRequested,
    AgentSchedulingRequested,
    ProviderExecutionRequested,
    ScmMutationRequested,
    ForgeMutationRequested,
    SemanticMergeRequested,
    AcceptedMemoryMutationRequested,
    CallbackRequested,
    InterruptionRequested,
    RecoveryRequested,
    UiApplyRequested,
    EffectPermissionWidened { effect: String },
}
