//! Shared nucleus primitives.
//!
//! This crate holds cross-cutting type vocabulary only. It does not implement
//! persistence, scheduling, storage engines, or runtime behavior yet.

pub mod effects;
pub mod persistence;
pub mod projection;
pub mod revisions;

pub use effects::{
    AdmissionStatus, EffectNonTerminalState, EffectState, EffectTerminalState, EvidenceRef,
};
pub use persistence::{
    PersistenceDomain, PersistenceRecord, PersistenceRecordId, PersistenceRecordKind,
    StorageBackendKind, StorageLocation,
};
pub use projection::{
    ProjectionExcludedStateKind, ProjectionMigrationAction, ProjectionMigrationPlan,
    ProjectionMigrationPosture, ProjectionRecordEnvelope, ProjectionRecordId, ProjectionRecordKind,
    ProjectionRecordPath, ProjectionRecordRevision, ProjectionRoot, ProjectionSchemaVersion,
    ProjectionValidationIssue, ProjectionValidationIssueKind, ProjectionValidationReport,
    ProjectionValidationStatus,
};
pub use revisions::{ChangeJournalEntry, ChangeOperation, RevisionId, StateSnapshot};
