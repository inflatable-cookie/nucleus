use serde::{Deserialize, Serialize};

use crate::accepted_memory_projection_export_plan::{
    AcceptedMemoryProjectionExportBlocker, AcceptedMemoryProjectionExportStatus,
};
use crate::accepted_memory_projection_policy::{
    AcceptedMemoryPolicyStatus, AcceptedMemoryProjectionPolicyBlocker,
    AcceptedMemoryProjectionPolicyStatus,
};
use crate::accepted_memory_projection_write_admission::{
    AcceptedMemoryProjectionWriteAdmissionBlocker, AcceptedMemoryProjectionWriteAdmissionStatus,
};
use crate::accepted_memory_projection_write_diagnostics::{
    AcceptedMemoryProjectionMaterializationDiagnosticStatus,
    AcceptedMemoryProjectionPayloadBlocker, AcceptedMemoryProjectionPayloadStatus,
    AcceptedMemoryProjectionWriteDiagnosticCounts, AcceptedMemoryProjectionWriteDiagnosticEntry,
    AcceptedMemoryProjectionWriteDiagnostics,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryProjectionWriteDiagnosticsDto {
    pub project_id: String,
    pub entries: Vec<ControlAcceptedMemoryProjectionWriteEntryDto>,
    pub counts: ControlAcceptedMemoryProjectionWriteCountsDto,
    pub projection_write_performed: bool,
    pub scm_effect_performed: bool,
    pub import_or_apply_performed: bool,
    pub embedding_available: bool,
    pub provider_sync_available: bool,
    pub task_mutation_performed: bool,
    pub ui_effect_performed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryProjectionWriteEntryDto {
    pub memory_id: String,
    pub plan_ref: String,
    pub file_ref: Option<String>,
    pub policy_status: String,
    pub export_status: String,
    pub admission_status: String,
    pub payload_status: String,
    pub materialization_status: String,
    pub policy_blockers: Vec<ControlAcceptedMemoryProjectionWriteBlockerDto>,
    pub export_blockers: Vec<ControlAcceptedMemoryProjectionWriteBlockerDto>,
    pub admission_blockers: Vec<ControlAcceptedMemoryProjectionWriteBlockerDto>,
    pub payload_blockers: Vec<ControlAcceptedMemoryProjectionWriteBlockerDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryProjectionWriteBlockerDto {
    pub kind: String,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryProjectionWriteCountsDto {
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

impl From<&AcceptedMemoryProjectionWriteDiagnostics>
    for ControlAcceptedMemoryProjectionWriteDiagnosticsDto
{
    fn from(diagnostics: &AcceptedMemoryProjectionWriteDiagnostics) -> Self {
        Self {
            project_id: diagnostics.project_id.0.clone(),
            entries: diagnostics
                .entries
                .iter()
                .map(ControlAcceptedMemoryProjectionWriteEntryDto::from)
                .collect(),
            counts: ControlAcceptedMemoryProjectionWriteCountsDto::from(&diagnostics.counts),
            projection_write_performed: diagnostics.projection_write_performed,
            scm_effect_performed: diagnostics.scm_effect_performed,
            import_or_apply_performed: diagnostics.import_or_apply_performed,
            embedding_available: diagnostics.embedding_available,
            provider_sync_available: diagnostics.provider_sync_available,
            task_mutation_performed: diagnostics.task_mutation_performed,
            ui_effect_performed: diagnostics.ui_effect_performed,
        }
    }
}

impl From<&AcceptedMemoryProjectionWriteDiagnosticEntry>
    for ControlAcceptedMemoryProjectionWriteEntryDto
{
    fn from(entry: &AcceptedMemoryProjectionWriteDiagnosticEntry) -> Self {
        Self {
            memory_id: entry.memory_id.clone(),
            plan_ref: entry.plan_ref.clone(),
            file_ref: entry.file_ref.clone(),
            policy_status: policy_status(&entry.policy_status),
            export_status: export_status(&entry.export_status),
            admission_status: admission_status(&entry.admission_status),
            payload_status: payload_status(&entry.payload_status),
            materialization_status: materialization_status(&entry.materialization_status),
            policy_blockers: entry.policy_blockers.iter().map(policy_blocker).collect(),
            export_blockers: entry.export_blockers.iter().map(export_blocker).collect(),
            admission_blockers: entry
                .admission_blockers
                .iter()
                .map(admission_blocker)
                .collect(),
            payload_blockers: entry.payload_blockers.iter().map(payload_blocker).collect(),
        }
    }
}

impl From<&AcceptedMemoryProjectionWriteDiagnosticCounts>
    for ControlAcceptedMemoryProjectionWriteCountsDto
{
    fn from(counts: &AcceptedMemoryProjectionWriteDiagnosticCounts) -> Self {
        Self {
            accepted_records: counts.accepted_records,
            out_of_scope_accepted_records: counts.out_of_scope_accepted_records,
            admitted_writes: counts.admitted_writes,
            blocked_writes: counts.blocked_writes,
            payload_ready_records: counts.payload_ready_records,
            payload_blocked_records: counts.payload_blocked_records,
            materialized_files: counts.materialized_files,
            skipped_records: counts.skipped_records,
            skipped_proposal_records: counts.skipped_proposal_records,
            skipped_unsupported_records: counts.skipped_unsupported_records,
            skipped_decode_errors: counts.skipped_decode_errors,
            policy_blockers: counts.policy_blockers,
            export_blockers: counts.export_blockers,
            admission_blockers: counts.admission_blockers,
            payload_blockers: counts.payload_blockers,
            file_refs: counts.file_refs,
        }
    }
}

fn blocker(kind: &str, detail: Option<String>) -> ControlAcceptedMemoryProjectionWriteBlockerDto {
    ControlAcceptedMemoryProjectionWriteBlockerDto {
        kind: kind.to_owned(),
        detail,
    }
}

fn policy_status(status: &AcceptedMemoryProjectionPolicyStatus) -> String {
    match status {
        AcceptedMemoryProjectionPolicyStatus::Projectable => "projectable",
        AcceptedMemoryProjectionPolicyStatus::LocalOnly => "local_only",
        AcceptedMemoryProjectionPolicyStatus::Blocked => "blocked",
        AcceptedMemoryProjectionPolicyStatus::ReviewRequired => "review_required",
    }
    .to_owned()
}

fn export_status(status: &AcceptedMemoryProjectionExportStatus) -> String {
    match status {
        AcceptedMemoryProjectionExportStatus::Stopped => "stopped",
        AcceptedMemoryProjectionExportStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn admission_status(status: &AcceptedMemoryProjectionWriteAdmissionStatus) -> String {
    match status {
        AcceptedMemoryProjectionWriteAdmissionStatus::Admitted => "admitted",
        AcceptedMemoryProjectionWriteAdmissionStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn payload_status(status: &AcceptedMemoryProjectionPayloadStatus) -> String {
    match status {
        AcceptedMemoryProjectionPayloadStatus::Ready => "ready",
        AcceptedMemoryProjectionPayloadStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn materialization_status(
    status: &AcceptedMemoryProjectionMaterializationDiagnosticStatus,
) -> String {
    match status {
        AcceptedMemoryProjectionMaterializationDiagnosticStatus::NotRun => "not_run",
    }
    .to_owned()
}

fn policy_blocker(
    blocker_value: &AcceptedMemoryProjectionPolicyBlocker,
) -> ControlAcceptedMemoryProjectionWriteBlockerDto {
    match blocker_value {
        AcceptedMemoryProjectionPolicyBlocker::NonAcceptedStatus { status } => {
            blocker("non_accepted_status", Some(memory_status(status)))
        }
        AcceptedMemoryProjectionPolicyBlocker::MissingProjectScope => {
            blocker("missing_project_scope", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::OutOfScopeProject { .. } => {
            blocker("out_of_scope_project", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::UserPrivateScope => {
            blocker("user_private_scope", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::UserPrivateSensitivity => {
            blocker("user_private_sensitivity", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::SecretAdjacentSensitivity => {
            blocker("secret_adjacent_sensitivity", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::RestrictedSensitivity => {
            blocker("restricted_sensitivity", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::ReviewQueueRetention => {
            blocker("review_queue_retention", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::LocalOnlyRetention => {
            blocker("local_only_retention", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::ExpiringRetention => {
            blocker("expiring_retention", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::ArchiveRetention => {
            blocker("archive_retention", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::MissingReviewEvidence => {
            blocker("missing_review_evidence", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::SupersededByAcceptedMemory { refs } => {
            blocker("superseded_by_accepted_memory", Some(refs.join(",")))
        }
        AcceptedMemoryProjectionPolicyBlocker::UnsafeExportIntent { reason } => {
            blocker("unsafe_export_intent", Some(reason.clone()))
        }
    }
}

fn export_blocker(
    blocker_value: &AcceptedMemoryProjectionExportBlocker,
) -> ControlAcceptedMemoryProjectionWriteBlockerDto {
    match blocker_value {
        AcceptedMemoryProjectionExportBlocker::PolicyDenied => blocker("policy_denied", None),
        AcceptedMemoryProjectionExportBlocker::UnsupportedSchema { schema_version } => {
            blocker("unsupported_schema", Some(schema_version.to_string()))
        }
        AcceptedMemoryProjectionExportBlocker::UnsupportedMemoryKind { kind } => {
            blocker("unsupported_memory_kind", Some(kind.clone()))
        }
        AcceptedMemoryProjectionExportBlocker::UnsafePathRef { reason } => {
            blocker("unsafe_path_ref", Some(reason.clone()))
        }
    }
}

fn admission_blocker(
    blocker_value: &AcceptedMemoryProjectionWriteAdmissionBlocker,
) -> ControlAcceptedMemoryProjectionWriteBlockerDto {
    match blocker_value {
        AcceptedMemoryProjectionWriteAdmissionBlocker::PolicyNotProjectable { status } => {
            blocker("policy_not_projectable", Some(policy_status(status)))
        }
        AcceptedMemoryProjectionWriteAdmissionBlocker::ExportNotStopped { status } => {
            blocker("export_not_stopped", Some(export_status(status)))
        }
        AcceptedMemoryProjectionWriteAdmissionBlocker::ExportBlockersPresent => {
            blocker("export_blockers_present", None)
        }
        AcceptedMemoryProjectionWriteAdmissionBlocker::MissingFileRef => {
            blocker("missing_file_ref", None)
        }
        AcceptedMemoryProjectionWriteAdmissionBlocker::UnsafeFileRef { reason } => {
            blocker("unsafe_file_ref", Some(reason.clone()))
        }
        AcceptedMemoryProjectionWriteAdmissionBlocker::PlanRefMismatch { expected } => {
            blocker("plan_ref_mismatch", Some(expected.clone()))
        }
        AcceptedMemoryProjectionWriteAdmissionBlocker::FileRefMismatch { expected } => {
            blocker("file_ref_mismatch", Some(expected.clone()))
        }
        AcceptedMemoryProjectionWriteAdmissionBlocker::PriorProjectionWriteObserved => {
            blocker("prior_projection_write_observed", None)
        }
        AcceptedMemoryProjectionWriteAdmissionBlocker::PriorScmEffectObserved => {
            blocker("prior_scm_effect_observed", None)
        }
    }
}

fn payload_blocker(
    blocker_value: &AcceptedMemoryProjectionPayloadBlocker,
) -> ControlAcceptedMemoryProjectionWriteBlockerDto {
    match blocker_value {
        AcceptedMemoryProjectionPayloadBlocker::UnsupportedStorageSchema { schema_version } => {
            blocker(
                "unsupported_storage_schema",
                Some(schema_version.to_string()),
            )
        }
        AcceptedMemoryProjectionPayloadBlocker::EncodeFailed { reason } => {
            blocker("encode_failed", Some(reason.clone()))
        }
    }
}

fn memory_status(status: &AcceptedMemoryPolicyStatus) -> String {
    match status {
        AcceptedMemoryPolicyStatus::Stale => "stale",
        AcceptedMemoryPolicyStatus::Superseded => "superseded",
        AcceptedMemoryPolicyStatus::Archived => "archived",
    }
    .to_owned()
}
