use nucleus_core::RevisionId;
use nucleus_engine::{EngineRuntimeReceiptRecordId, ManagementProjectionFileDocument};
use serde::{Deserialize, Serialize};

use super::super::PlanningProjectionImportActiveApplyExecutorPlan;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportMinimumApplyProofRequest {
    pub executor_plan: PlanningProjectionImportActiveApplyExecutorPlan,
    pub reviewed_document: ManagementProjectionFileDocument,
    pub next_revision_id: RevisionId,
    pub receipt_id: EngineRuntimeReceiptRecordId,
    pub sanitization_policy_ref: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningProjectionImportMinimumApplyProofReceipt {
    pub receipt_id: String,
    pub status: PlanningProjectionImportMinimumApplyProofStatus,
    pub blockers: Vec<PlanningProjectionImportMinimumApplyProofBlocker>,
    pub target_record_id: Option<String>,
    pub import_file_ref: Option<String>,
    pub previous_revision_id: Option<String>,
    pub next_revision_id: Option<String>,
    pub evidence_refs: Vec<String>,
    pub active_planning_mutation_performed: bool,
    pub task_creation_performed: bool,
    pub task_promotion_performed: bool,
    pub provider_execution_performed: bool,
    pub scm_mutation_performed: bool,
    pub forge_mutation_performed: bool,
    pub accepted_memory_mutation_performed: bool,
    pub semantic_merge_performed: bool,
    pub raw_payload_retained: bool,
    pub ui_apply_triggered: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningProjectionImportMinimumApplyProofStatus {
    Applied,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningProjectionImportMinimumApplyProofBlocker {
    ExecutorNotPlannedStopped {
        status: String,
    },
    MissingAdmissionRef,
    MissingStoppedApplyRef,
    MissingDryRunApplyPlanRef,
    MissingOperatorRef,
    MissingApprovalRef,
    MissingSanitizationPolicyRef,
    MissingNextRevision,
    MissingReceiptId,
    ExpectedSingleOperation {
        operation_count: usize,
    },
    UnsupportedOperationKind {
        operation_kind: String,
    },
    MissingOperationRevisionExpectation,
    StaleOperationRevision {
        expected_current_revision: String,
        observed_current_revision: String,
    },
    OperationRecordMismatch {
        expected: String,
        observed: String,
    },
    OperationFileMismatch {
        expected: String,
        observed: String,
    },
    UnsupportedDocumentKind {
        record_kind: String,
    },
    UnsupportedDocumentPayload,
    PayloadRecordMismatch {
        expected: String,
        observed: String,
    },
    MissingTargetArtifact,
    TargetKindMismatch {
        kind: String,
    },
    TargetRevisionConflict {
        expected: String,
        observed: String,
    },
    MissingEvidenceRef {
        summary: String,
    },
    ExecutorBlockerPresent {
        summary: String,
    },
    EffectPermissionWidened {
        effect: String,
    },
    RawPayloadRetained,
    PayloadBodyRetained,
}
