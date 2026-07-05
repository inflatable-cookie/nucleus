use super::super::planning_import_apply_persistence::PlanningProjectionImportStoppedApplyRecord;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PlanningProjectionImportActiveApplyAdmissionRequest {
    pub admission_id: String,
    pub stopped_apply_record: Option<PlanningProjectionImportStoppedApplyRecord>,
    pub existing_admission_ids: Vec<String>,
    pub operator_ref: Option<String>,
    pub approval_ref: Option<String>,
    pub revision_expectation_refs: Vec<PlanningProjectionImportActiveApplyRevisionExpectationRef>,
    pub evidence_refs: Vec<String>,
    pub active_planning_mutation_requested: bool,
    pub executor_invocation_requested: bool,
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
pub struct PlanningProjectionImportActiveApplyRevisionExpectationRef {
    pub operation_id: String,
    pub expected_current_revision: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningProjectionImportActiveApplyAdmissionRecord {
    pub admission_id: String,
    pub stopped_apply_record_id: Option<String>,
    pub plan_id: Option<String>,
    pub operator_ref: Option<String>,
    pub approval_ref: Option<String>,
    pub status: PlanningProjectionImportActiveApplyAdmissionStatus,
    pub blockers: Vec<PlanningProjectionImportActiveApplyAdmissionBlocker>,
    pub operation_refs: Vec<PlanningProjectionImportActiveApplyOperationRef>,
    pub evidence_refs: Vec<String>,
    pub apply_admitted: bool,
    pub duplicate_admission_detected: bool,
    pub active_planning_mutation_permitted: bool,
    pub executor_invocation_permitted: bool,
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
pub struct PlanningProjectionImportActiveApplyOperationRef {
    pub operation_id: String,
    pub readiness_entry_id: String,
    pub admission_record_id: String,
    pub candidate_id: String,
    pub file_ref: String,
    pub record_id: String,
    pub operation_kind: String,
    pub expected_current_revision: Option<String>,
    pub observed_current_revision: Option<String>,
    pub revision_expectation_ref: Option<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningProjectionImportActiveApplyAdmissionStatus {
    AdmittedStopped,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningProjectionImportActiveApplyAdmissionBlocker {
    MissingAdmissionId,
    DuplicateAdmissionId {
        admission_id: String,
    },
    MissingStoppedApplyRecord,
    StoppedApplyNotPersisted {
        status: String,
    },
    StoppedApplyDuplicateNoop {
        stopped_apply_record_id: String,
    },
    StoppedApplyBlocked {
        stopped_apply_record_id: String,
    },
    StoppedApplyBlockerPresent {
        blocker: String,
    },
    MissingPlannedOperation,
    BlockedOperationPresent,
    MissingOperatorRef,
    MissingApprovalRef,
    MissingOperationId {
        index: usize,
    },
    MissingOperationRecordId {
        operation_id: String,
    },
    MissingOperationFileRef {
        operation_id: String,
    },
    MissingOperationEvidenceRef {
        operation_id: String,
    },
    MissingRevisionExpectation {
        operation_id: String,
    },
    StaleRevision {
        operation_id: String,
        expected_current_revision: String,
        observed_current_revision: String,
    },
    UnsupportedOperationKind {
        operation_id: String,
        operation_kind: String,
    },
    InspectOnlyOperation {
        operation_id: String,
    },
    ConflictEvidence {
        operation_id: String,
        summary: String,
    },
    RepairRequiredEvidence {
        operation_id: String,
        summary: String,
    },
    MissingRefEvidence {
        operation_id: String,
        summary: String,
    },
    RawPayloadPresent,
    PayloadBodyIncluded,
    ActivePlanningMutationRequested,
    ExecutorInvocationRequested,
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
    EffectPermissionWidened {
        effect: String,
    },
}
