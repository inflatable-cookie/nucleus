//! Read-only accepted-memory projection readiness diagnostics.
//!
//! Diagnostics summarize policy and stopped export-plan readiness without
//! writing projection files, calling SCM/forge providers, running embeddings,
//! syncing provider memory, mutating tasks, or exposing raw memory bodies.

use nucleus_memory::{AcceptedMemoryStorageRecord, MemoryProposalStorageScope};
use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_export_plan::{
    accepted_memory_projection_export_entry, AcceptedMemoryProjectionExportBlocker,
    AcceptedMemoryProjectionExportEntry, AcceptedMemoryProjectionExportStatus,
};
use crate::accepted_memory_projection_policy::{
    AcceptedMemoryProjectionPolicyBlocker, AcceptedMemoryProjectionPolicyStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionDiagnostics {
    pub project_id: ProjectId,
    pub entries: Vec<AcceptedMemoryProjectionDiagnosticEntry>,
    pub counts: AcceptedMemoryProjectionDiagnosticCounts,
    pub projection_write_performed: bool,
    pub scm_effect_performed: bool,
    pub import_or_apply_performed: bool,
    pub embedding_available: bool,
    pub provider_sync_available: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionDiagnosticEntry {
    pub memory_id: String,
    pub plan_ref: String,
    pub file_ref: Option<String>,
    pub export_status: AcceptedMemoryProjectionExportStatus,
    pub policy_status: AcceptedMemoryProjectionPolicyStatus,
    pub policy_blockers: Vec<AcceptedMemoryProjectionPolicyBlocker>,
    pub export_blockers: Vec<AcceptedMemoryProjectionExportBlocker>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionDiagnosticCounts {
    pub accepted_records: usize,
    pub out_of_scope_accepted_records: usize,
    pub projectable_records: usize,
    pub local_only_records: usize,
    pub blocked_records: usize,
    pub review_required_records: usize,
    pub skipped_records: usize,
    pub skipped_proposal_records: usize,
    pub skipped_unsupported_records: usize,
    pub skipped_decode_errors: usize,
    pub policy_blockers: usize,
    pub export_blockers: usize,
    pub file_refs: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionDiagnosticRecord {
    Accepted(AcceptedMemoryStorageRecord),
    ProposalRecordSkipped { record_id: String },
    UnsupportedRecordSkipped { record_id: String },
    DecodeFailedSkipped { record_id: String },
}

impl AcceptedMemoryProjectionDiagnostics {
    pub fn from_records(
        project_id: ProjectId,
        records: impl IntoIterator<Item = AcceptedMemoryProjectionDiagnosticRecord>,
    ) -> Self {
        let mut counts = AcceptedMemoryProjectionDiagnosticCounts::empty();
        let mut entries = Vec::new();

        for record in records {
            match record {
                AcceptedMemoryProjectionDiagnosticRecord::Accepted(record) => {
                    counts.accepted_records += 1;
                    if accepted_record_belongs_to_project(&record, &project_id) {
                        let entry = AcceptedMemoryProjectionDiagnosticEntry::from_export_entry(
                            accepted_memory_projection_export_entry(&project_id, &record),
                        );
                        counts.add_entry(&entry);
                        entries.push(entry);
                    } else {
                        counts.out_of_scope_accepted_records += 1;
                    }
                }
                AcceptedMemoryProjectionDiagnosticRecord::ProposalRecordSkipped { .. } => {
                    counts.skipped_records += 1;
                    counts.skipped_proposal_records += 1;
                }
                AcceptedMemoryProjectionDiagnosticRecord::UnsupportedRecordSkipped { .. } => {
                    counts.skipped_records += 1;
                    counts.skipped_unsupported_records += 1;
                }
                AcceptedMemoryProjectionDiagnosticRecord::DecodeFailedSkipped { .. } => {
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
        }
    }
}

impl AcceptedMemoryProjectionDiagnosticEntry {
    fn from_export_entry(entry: AcceptedMemoryProjectionExportEntry) -> Self {
        Self {
            memory_id: entry.memory_id,
            plan_ref: entry.plan_ref,
            file_ref: entry.file_ref,
            export_status: entry.status,
            policy_status: entry.policy_status,
            policy_blockers: entry.policy_blockers,
            export_blockers: entry.export_blockers,
        }
    }
}

impl AcceptedMemoryProjectionDiagnosticCounts {
    fn empty() -> Self {
        Self {
            accepted_records: 0,
            out_of_scope_accepted_records: 0,
            projectable_records: 0,
            local_only_records: 0,
            blocked_records: 0,
            review_required_records: 0,
            skipped_records: 0,
            skipped_proposal_records: 0,
            skipped_unsupported_records: 0,
            skipped_decode_errors: 0,
            policy_blockers: 0,
            export_blockers: 0,
            file_refs: 0,
        }
    }

    fn add_entry(&mut self, entry: &AcceptedMemoryProjectionDiagnosticEntry) {
        match entry.policy_status {
            AcceptedMemoryProjectionPolicyStatus::Projectable => self.projectable_records += 1,
            AcceptedMemoryProjectionPolicyStatus::LocalOnly => self.local_only_records += 1,
            AcceptedMemoryProjectionPolicyStatus::Blocked => self.blocked_records += 1,
            AcceptedMemoryProjectionPolicyStatus::ReviewRequired => {
                self.review_required_records += 1;
            }
        }

        self.policy_blockers += entry.policy_blockers.len();
        self.export_blockers += entry.export_blockers.len();
        self.file_refs += usize::from(entry.file_ref.is_some());
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
