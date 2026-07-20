//! Portable domain execution boundary for Nucleus.
//!
//! This crate composes domain crates, command policy, storage repository
//! boundaries, and orchestration mechanics. It does not own host transports,
//! Tauri IPC, process spawning, provider runtimes, or concrete database
//! adapters.

pub mod authority;
pub mod change_request_prep;
pub mod checkpoint_diff;
pub mod codex_runtime_receipts;
pub mod commands;
pub mod effects;
pub mod goal_commands;
pub mod goal_run_rules;
pub mod management_projection;
pub mod management_sync;
pub mod planning_task_seed;
pub mod project_commands;
pub mod projections;
pub mod repositories;
pub mod runtime_receipts;
pub mod scm_work_item_linkage;
pub mod services;
pub mod task_agent;
pub mod task_commands;
pub mod task_readiness;
pub mod task_timeline;
pub mod task_work_items;

pub use change_request_prep::{
    EngineChangeRequestCandidateAdmission, EngineChangeRequestCandidateAdmissionStatus,
    EngineChangeRequestCandidateId, EngineChangeRequestCandidateRecord,
    EngineChangeRequestCandidateStatus, EngineChangeRequestEvidencePackage,
    EngineChangeRequestEvidenceRef, EngineChangeRequestPolicyGate, EngineChangeRequestPrepId,
    EngineChangeRequestPrepRecord, EngineChangeRequestPrepStatus,
    EngineChangeRequestPublicationState, EngineChangeRequestReviewPolicy,
    EngineChangeRequestTarget, EngineGitHubReviewBoundaryDescriptor,
};
pub use checkpoint_diff::{
    decode_checkpoint_record, decode_diff_summary_record, encode_checkpoint_record,
    encode_diff_summary_record, CheckpointDiffCodecError, EngineCheckpointFamily,
    EngineCheckpointRecord, EngineCheckpointRecordId, EngineCheckpointRecoveryState,
    EngineCheckpointRef, EngineDiffCoverageState, EngineDiffPathChange, EngineDiffPathChangeKind,
    EngineDiffSummaryConfidence, EngineDiffSummaryCounts, EngineDiffSummaryKind,
    EngineDiffSummaryRecord, EngineDiffSummaryRecordId,
};
pub use codex_runtime_receipts::runtime_receipt_from_codex_fixture;
pub use goal_commands::{
    EngineGoalCommand, EngineGoalCommandError, EngineGoalCommandService, EngineGoalCreateCommand,
    EngineGoalRepository, EngineGoalUpdateChanges, EngineGoalUpdateCommand,
};
pub use goal_run_rules::{
    goal_run_task_prompt, goal_run_work_item_id, parse_task_action,
    validate_goal_continuation_status, validate_goal_run_mandate, validate_goal_run_task,
    EngineGoalRunReworkContext, EngineGoalRunTaskView,
};
pub use management_projection::{
    decode_management_projection_file_document, encode_management_projection_file_document,
    export_project_planning_projection, export_project_task_projection,
    planning_projection_export_diagnostics, projection_file_document_from_entry,
    validate_projection_envelope, validate_projection_file_document,
    ManagementProjectionConflictClass, ManagementProjectionConflictReport,
    ManagementProjectionEnvelope, ManagementProjectionExcludedStateMarker,
    ManagementProjectionExportEntry, ManagementProjectionExportIssue,
    ManagementProjectionExportIssueKind, ManagementProjectionExportPlan,
    ManagementProjectionFileCodecError, ManagementProjectionFileDocument,
    ManagementProjectionFileFormat, ManagementProjectionFileRef, ManagementProjectionFileRefError,
    ManagementProjectionPayload, ManagementProjectionPlanningArtifactBody,
    ManagementProjectionPlanningArtifactKind, ManagementProjectionPlanningArtifactRecord,
    ManagementProjectionPlanningArtifactStatus, ManagementProjectionPlanningExportDiagnostics,
    ManagementProjectionPlanningReviewState, ManagementProjectionPlanningTaskSeedRecord,
    ManagementProjectionRecordId, ManagementProjectionRecordKind, ManagementProjectionRoot,
    ManagementProjectionSchemaConflictKind, ManagementProjectionSchemaVersion,
    ManagementProjectionScmConflictKind, ManagementProjectionSemanticConflictKind,
    ManagementProjectionUnsupportedConflictKind, ManagementProjectionValidationIssue,
    ManagementProjectionValidationIssueKind, ManagementProjectionValidationReport,
    ManagementProjectionValidationStatus, MANAGEMENT_PROJECTION_ROOT,
    MANAGEMENT_PROJECTION_SCHEMA_V1,
};
pub use management_sync::{
    GitCaptureDryRunAdmission, GitCaptureDryRunAdmissionStatus, GitCaptureDryRunCheck,
    GitCaptureDryRunEnvelope, GitCaptureDryRunEnvelopeId, GitManagementCaptureDescriptor,
    GitManagementCaptureEvidence, GitManagementCapturePlan, GitManagementCapturePlanId,
    GitManagementCapturePlanStatus, ManagementProjectionApplyCommand,
    ManagementProjectionApplyCommandId, ManagementProjectionApplyRecordTarget,
    ManagementProjectionCaptureAdmission, ManagementProjectionCaptureAdmissionStatus,
    ManagementProjectionCaptureCommand, ManagementProjectionCaptureCommandId,
    ManagementProjectionCaptureEvidence, ManagementProjectionCapturePolicyGate,
    ManagementProjectionCapturePrepId, ManagementProjectionCapturePrepRecord,
    ManagementProjectionCapturePrepStatus, ManagementProjectionCaptureReason,
    ManagementProjectionCaptureScope, ManagementProjectionCaptureShareReadiness,
    ManagementProjectionImportRepairKind, ManagementProjectionImportRepairProposal,
    ManagementProjectionImportRepairProposalId, ManagementProjectionImportRepairReview,
    ManagementProjectionSyncAssistanceKind, ManagementProjectionSyncAssistanceRoute,
    ManagementProjectionSyncPlan, ManagementProjectionSyncPlanId, ManagementProjectionSyncPlanKind,
    ManagementProjectionSyncPlanStatus,
};
pub use planning_task_seed::{
    admit_task_seed_promotion, decode_task_seed_storage_record, encode_task_seed_storage_payload,
    encode_task_seed_storage_record, task_seed_from_storage_record, EnginePlanningArtifactBody,
    EnginePlanningArtifactId, EnginePlanningArtifactKind, EnginePlanningArtifactRecord,
    EnginePlanningArtifactStatus, EnginePlanningReviewState, EnginePlanningSessionId,
    EngineTaskSeedAgentReadinessHints, EngineTaskSeedCandidate, EngineTaskSeedCandidateProjection,
    EngineTaskSeedCandidateRecord, EngineTaskSeedId, EngineTaskSeedPromotionAdmission,
    EngineTaskSeedPromotionCommand, EngineTaskSeedPromotionOutcome, EngineTaskSeedPromotionState,
    EngineTaskSeedReadinessClass, EngineTaskSeedSourceCounts, EngineTaskSeedStatusCount,
    PlanningStorageAcceptanceCriterion, PlanningStorageAgentReadiness,
    PlanningStorageAgentReadinessHints, PlanningStorageReviewState, PlanningStorageTaskActionType,
    PlanningStorageTaskImportance, PlanningTaskSeedRecordCodecError,
    PlanningTaskSeedStoragePromotionState, PlanningTaskSeedStorageRecord,
};
pub use project_commands::{
    EngineProjectCommand, EngineProjectCommandError, EngineProjectCommandService,
    EngineProjectCreateCommand, EngineProjectLifecycleAction, EngineProjectLifecycleCommand,
    EngineProjectLifecycleReceipt, EngineProjectRepository, EngineProjectRetentionChoice,
    EngineProjectScanDomain,
};
pub use runtime_receipts::{
    decode_runtime_receipt_record, encode_runtime_receipt_record, EngineRuntimeReceiptEffectFamily,
    EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId, EngineRuntimeReceiptRef,
    EngineRuntimeReceiptStatus, RuntimeReceiptRecordCodecError,
};
pub use scm_work_item_linkage::{
    EngineScmWorkItemLinkId, EngineScmWorkItemLinkRecord, EngineScmWorkItemLinkState,
};
pub use services::{
    EngineReadModelError, EngineReadModelService, EngineReadRecordSet, EngineReadScope,
    EngineStateDomain, EngineStateRecordReader,
};
pub use task_agent::{
    admit_task_agent_work_unit, project_task_agent_work_units, task_agent_work_unit_diagnostics,
    EngineTaskAgentWorkUnitAdmissionRecord, EngineTaskAgentWorkUnitDiagnostics,
    EngineTaskAgentWorkUnitProjection, EngineTaskAgentWorkUnitProjectionIssue,
    EngineTaskAgentWorkUnitReviewStatus, EngineTaskAgentWorkUnitRuntimeStatus,
    EngineTaskAgentWorkUnitSourceCursor, EngineTaskAgentWorkUnitSourceId,
    EngineTaskAgentWorkUnitSourceRecord,
};
pub use task_commands::{
    EngineRevisionExpectation, EngineTaskCommand, EngineTaskCommandError, EngineTaskCommandOutcome,
    EngineTaskCommandService, EngineTaskCreateCommand, EngineTaskDelegationCommand,
    EngineTaskRecord, EngineTaskRepository, EngineTaskTransitionCommand, EngineTaskUpdateChanges,
    EngineTaskUpdateCommand,
};
pub use task_readiness::{
    EngineTaskReadinessCandidate, EngineTaskReadinessClass, EngineTaskReadinessInput,
    EngineTaskReadinessProjection, EngineTaskReadinessSourceCounts, EngineTaskReadinessStatusCount,
};
pub use task_timeline::{
    EngineTaskTimelineEntry, EngineTaskTimelineEntryId, EngineTaskTimelineEntryKind,
    EngineTaskTimelineProjection, EngineTaskTimelineSummary,
};
pub use task_work_items::{
    review_timeline_entry_from_transition, EngineTaskWorkItemAssignment, EngineTaskWorkItemId,
    EngineTaskWorkItemRecord, EngineTaskWorkItemRefs, EngineTaskWorkItemReviewCommand,
    EngineTaskWorkItemReviewDecision, EngineTaskWorkItemReviewError,
    EngineTaskWorkItemReviewOutcome, EngineTaskWorkItemReviewState,
    EngineTaskWorkItemReviewTimelineEntry, EngineTaskWorkItemReviewTransition,
    EngineTaskWorkItemRuntimeLinkState, EngineTaskWorkItemRuntimeProjection,
    EngineTaskWorkItemRuntimeProjectionEntry, EngineTaskWorkItemRuntimeProjectionEntryKind,
    EngineTaskWorkItemRuntimeState, EngineTaskWorkItemSet,
};
