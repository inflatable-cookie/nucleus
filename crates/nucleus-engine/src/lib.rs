//! Portable domain execution boundary for Nucleus.
//!
//! This crate composes domain crates, command policy, storage repository
//! boundaries, and orchestration mechanics. It does not own host transports,
//! Tauri IPC, process spawning, provider runtimes, or concrete database
//! adapters.

pub mod authority;
pub mod checkpoint_diff;
pub mod codex_runtime_receipts;
pub mod commands;
pub mod effects;
pub mod management_projection;
pub mod projections;
pub mod repositories;
pub mod runtime_receipts;
pub mod services;
pub mod task_commands;
pub mod task_timeline;

pub use checkpoint_diff::{
    decode_checkpoint_record, decode_diff_summary_record, encode_checkpoint_record,
    encode_diff_summary_record, CheckpointDiffCodecError, EngineCheckpointFamily,
    EngineCheckpointRecord, EngineCheckpointRecordId, EngineCheckpointRecoveryState,
    EngineCheckpointRef, EngineDiffSummaryConfidence, EngineDiffSummaryKind,
    EngineDiffSummaryRecord, EngineDiffSummaryRecordId,
};
pub use codex_runtime_receipts::runtime_receipt_from_codex_fixture;
pub use management_projection::{
    export_project_task_projection, validate_projection_envelope,
    ManagementProjectionConflictClass, ManagementProjectionConflictReport,
    ManagementProjectionEnvelope, ManagementProjectionExcludedStateMarker,
    ManagementProjectionExportEntry, ManagementProjectionExportPlan, ManagementProjectionFileRef,
    ManagementProjectionPayload, ManagementProjectionRecordId, ManagementProjectionRecordKind,
    ManagementProjectionRoot, ManagementProjectionSchemaConflictKind,
    ManagementProjectionSchemaVersion, ManagementProjectionSemanticConflictKind,
    ManagementProjectionValidationIssue, ManagementProjectionValidationIssueKind,
    ManagementProjectionValidationReport, ManagementProjectionValidationStatus,
    MANAGEMENT_PROJECTION_ROOT, MANAGEMENT_PROJECTION_SCHEMA_V1,
};
pub use runtime_receipts::{
    decode_runtime_receipt_record, encode_runtime_receipt_record, EngineRuntimeReceiptEffectFamily,
    EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId, EngineRuntimeReceiptRef,
    EngineRuntimeReceiptStatus, RuntimeReceiptRecordCodecError,
};
pub use services::{
    EngineReadModelError, EngineReadModelService, EngineReadRecordSet, EngineReadScope,
    EngineStateDomain, EngineStateRecordReader,
};
pub use task_commands::{
    EngineRevisionExpectation, EngineTaskCommand, EngineTaskCommandError, EngineTaskCommandOutcome,
    EngineTaskCommandService, EngineTaskCreateCommand, EngineTaskRecord, EngineTaskRepository,
    EngineTaskTransitionCommand, EngineTaskUpdateChanges, EngineTaskUpdateCommand,
};
pub use task_timeline::{
    EngineTaskTimelineEntry, EngineTaskTimelineEntryId, EngineTaskTimelineEntryKind,
    EngineTaskTimelineProjection, EngineTaskTimelineSummary,
};
