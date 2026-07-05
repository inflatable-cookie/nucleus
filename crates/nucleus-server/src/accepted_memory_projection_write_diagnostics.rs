//! Read-only accepted-memory projection write diagnostics.
//!
//! Diagnostics compose export plans, write admission, and payload codec
//! readiness without writing files, calling SCM/forge providers, importing
//! projected files, running embeddings, syncing provider memory, mutating
//! tasks, or exposing raw memory bodies.

use nucleus_memory::{AcceptedMemoryStorageRecord, MemoryProposalStorageScope};
use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_export_plan::{
    accepted_memory_projection_export_entry, AcceptedMemoryProjectionExportBlocker,
    AcceptedMemoryProjectionExportStatus,
};
use crate::accepted_memory_projection_payload::{
    encode_accepted_memory_projection_payload, AcceptedMemoryProjectionPayload,
};
use crate::accepted_memory_projection_policy::{
    AcceptedMemoryProjectionPolicyBlocker, AcceptedMemoryProjectionPolicyStatus,
};
use crate::accepted_memory_projection_write_admission::{
    accepted_memory_projection_write_admission, AcceptedMemoryProjectionWriteAdmissionBlocker,
    AcceptedMemoryProjectionWriteAdmissionStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionWriteDiagnostics {
    pub project_id: ProjectId,
    pub entries: Vec<AcceptedMemoryProjectionWriteDiagnosticEntry>,
    pub counts: AcceptedMemoryProjectionWriteDiagnosticCounts,
    pub projection_write_performed: bool,
    pub scm_effect_performed: bool,
    pub import_or_apply_performed: bool,
    pub embedding_available: bool,
    pub provider_sync_available: bool,
    pub task_mutation_performed: bool,
    pub ui_effect_performed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionWriteDiagnosticEntry {
    pub memory_id: String,
    pub plan_ref: String,
    pub file_ref: Option<String>,
    pub policy_status: AcceptedMemoryProjectionPolicyStatus,
    pub export_status: AcceptedMemoryProjectionExportStatus,
    pub admission_status: AcceptedMemoryProjectionWriteAdmissionStatus,
    pub payload_status: AcceptedMemoryProjectionPayloadStatus,
    pub materialization_status: AcceptedMemoryProjectionMaterializationDiagnosticStatus,
    pub policy_blockers: Vec<AcceptedMemoryProjectionPolicyBlocker>,
    pub export_blockers: Vec<AcceptedMemoryProjectionExportBlocker>,
    pub admission_blockers: Vec<AcceptedMemoryProjectionWriteAdmissionBlocker>,
    pub payload_blockers: Vec<AcceptedMemoryProjectionPayloadBlocker>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionPayloadStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionPayloadBlocker {
    UnsupportedStorageSchema { schema_version: u16 },
    EncodeFailed { reason: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionMaterializationDiagnosticStatus {
    NotRun,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionWriteDiagnosticCounts {
    pub accepted_records: usize,
    pub out_of_scope_accepted_records: usize,
    pub admitted_writes: usize,
    pub blocked_writes: usize,
    pub payload_ready_records: usize,
    pub payload_blocked_records: usize,
    pub materialized_files: usize,
    pub skipped_records: usize,
    pub skipped_proposal_records: usize,
    pub skipped_unsupported_records: usize,
    pub skipped_decode_errors: usize,
    pub policy_blockers: usize,
    pub export_blockers: usize,
    pub admission_blockers: usize,
    pub payload_blockers: usize,
    pub file_refs: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionWriteDiagnosticRecord {
    Accepted(AcceptedMemoryStorageRecord),
    ProposalRecordSkipped { record_id: String },
    UnsupportedRecordSkipped { record_id: String },
    DecodeFailedSkipped { record_id: String },
}

impl AcceptedMemoryProjectionWriteDiagnostics {
    pub fn from_records(
        project_id: ProjectId,
        records: impl IntoIterator<Item = AcceptedMemoryProjectionWriteDiagnosticRecord>,
    ) -> Self {
        let mut counts = AcceptedMemoryProjectionWriteDiagnosticCounts::empty();
        let mut entries = Vec::new();

        for record in records {
            match record {
                AcceptedMemoryProjectionWriteDiagnosticRecord::Accepted(record) => {
                    counts.accepted_records += 1;
                    if accepted_record_belongs_to_project(&record, &project_id) {
                        let entry = AcceptedMemoryProjectionWriteDiagnosticEntry::from_record(
                            &project_id,
                            record,
                        );
                        counts.add_entry(&entry);
                        entries.push(entry);
                    } else {
                        counts.out_of_scope_accepted_records += 1;
                    }
                }
                AcceptedMemoryProjectionWriteDiagnosticRecord::ProposalRecordSkipped { .. } => {
                    counts.skipped_records += 1;
                    counts.skipped_proposal_records += 1;
                }
                AcceptedMemoryProjectionWriteDiagnosticRecord::UnsupportedRecordSkipped {
                    ..
                } => {
                    counts.skipped_records += 1;
                    counts.skipped_unsupported_records += 1;
                }
                AcceptedMemoryProjectionWriteDiagnosticRecord::DecodeFailedSkipped { .. } => {
                    counts.skipped_records += 1;
                    counts.skipped_decode_errors += 1;
                }
            }
        }

        Self {
            project_id,
            entries,
            counts,
            projection_write_performed: false,
            scm_effect_performed: false,
            import_or_apply_performed: false,
            embedding_available: false,
            provider_sync_available: false,
            task_mutation_performed: false,
            ui_effect_performed: false,
        }
    }
}

impl AcceptedMemoryProjectionWriteDiagnosticEntry {
    fn from_record(project_id: &ProjectId, record: AcceptedMemoryStorageRecord) -> Self {
        let export_entry = accepted_memory_projection_export_entry(project_id, &record);
        let admission = accepted_memory_projection_write_admission(export_entry.clone());
        let payload_blockers = payload_blockers(&record);
        let payload_status = if payload_blockers.is_empty() {
            AcceptedMemoryProjectionPayloadStatus::Ready
        } else {
            AcceptedMemoryProjectionPayloadStatus::Blocked
        };

        Self {
            memory_id: admission.memory_id,
            plan_ref: admission.plan_ref,
            file_ref: admission.file_ref,
            policy_status: admission.policy_status,
            export_status: admission.export_status,
            admission_status: admission.status,
            payload_status,
            materialization_status: AcceptedMemoryProjectionMaterializationDiagnosticStatus::NotRun,
            policy_blockers: admission.policy_blockers,
            export_blockers: admission.export_blockers,
            admission_blockers: admission.admission_blockers,
            payload_blockers,
        }
    }
}

impl AcceptedMemoryProjectionWriteDiagnosticCounts {
    fn empty() -> Self {
        Self {
            accepted_records: 0,
            out_of_scope_accepted_records: 0,
            admitted_writes: 0,
            blocked_writes: 0,
            payload_ready_records: 0,
            payload_blocked_records: 0,
            materialized_files: 0,
            skipped_records: 0,
            skipped_proposal_records: 0,
            skipped_unsupported_records: 0,
            skipped_decode_errors: 0,
            policy_blockers: 0,
            export_blockers: 0,
            admission_blockers: 0,
            payload_blockers: 0,
            file_refs: 0,
        }
    }

    fn add_entry(&mut self, entry: &AcceptedMemoryProjectionWriteDiagnosticEntry) {
        match entry.admission_status {
            AcceptedMemoryProjectionWriteAdmissionStatus::Admitted => self.admitted_writes += 1,
            AcceptedMemoryProjectionWriteAdmissionStatus::Blocked => self.blocked_writes += 1,
        }
        match entry.payload_status {
            AcceptedMemoryProjectionPayloadStatus::Ready => self.payload_ready_records += 1,
            AcceptedMemoryProjectionPayloadStatus::Blocked => self.payload_blocked_records += 1,
        }
        self.policy_blockers += entry.policy_blockers.len();
        self.export_blockers += entry.export_blockers.len();
        self.admission_blockers += entry.admission_blockers.len();
        self.payload_blockers += entry.payload_blockers.len();
        self.file_refs += usize::from(entry.file_ref.is_some());
    }
}

fn payload_blockers(
    record: &AcceptedMemoryStorageRecord,
) -> Vec<AcceptedMemoryProjectionPayloadBlocker> {
    match AcceptedMemoryProjectionPayload::from_accepted_memory_record(record) {
        Ok(payload) => match encode_accepted_memory_projection_payload(&payload) {
            Ok(_) => Vec::new(),
            Err(error) => vec![AcceptedMemoryProjectionPayloadBlocker::EncodeFailed {
                reason: error.reason,
            }],
        },
        Err(_) => vec![
            AcceptedMemoryProjectionPayloadBlocker::UnsupportedStorageSchema {
                schema_version: record.schema_version,
            },
        ],
    }
}

fn accepted_record_belongs_to_project(
    record: &AcceptedMemoryStorageRecord,
    project_id: &ProjectId,
) -> bool {
    matches!(
        &record.scope,
        MemoryProposalStorageScope::Project { project_ref } if project_ref == &project_id.0
    )
}
