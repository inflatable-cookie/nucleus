use serde::{Deserialize, Serialize};

use crate::accepted_memory_projection_diagnostics::{
    AcceptedMemoryProjectionDiagnosticCounts, AcceptedMemoryProjectionDiagnosticEntry,
    AcceptedMemoryProjectionDiagnostics,
};
use crate::accepted_memory_projection_export_plan::{
    AcceptedMemoryProjectionExportBlocker, AcceptedMemoryProjectionExportStatus,
};
use crate::accepted_memory_projection_policy::{
    AcceptedMemoryPolicyStatus, AcceptedMemoryProjectionPolicyBlocker,
    AcceptedMemoryProjectionPolicyStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryProjectionDiagnosticsDto {
    pub project_id: String,
    pub entries: Vec<ControlAcceptedMemoryProjectionEntryDto>,
    pub counts: ControlAcceptedMemoryProjectionCountsDto,
    pub projection_write_performed: bool,
    pub scm_effect_performed: bool,
    pub import_or_apply_performed: bool,
    pub embedding_available: bool,
    pub provider_sync_available: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryProjectionEntryDto {
    pub memory_id: String,
    pub plan_ref: String,
    pub file_ref: Option<String>,
    pub export_status: String,
    pub policy_status: String,
    pub policy_blockers: Vec<ControlAcceptedMemoryProjectionBlockerDto>,
    pub export_blockers: Vec<ControlAcceptedMemoryProjectionBlockerDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryProjectionBlockerDto {
    pub kind: String,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryProjectionCountsDto {
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

impl From<&AcceptedMemoryProjectionDiagnostics> for ControlAcceptedMemoryProjectionDiagnosticsDto {
    fn from(diagnostics: &AcceptedMemoryProjectionDiagnostics) -> Self {
        Self {
            project_id: diagnostics.project_id.0.clone(),
            entries: diagnostics
                .entries
                .iter()
                .map(ControlAcceptedMemoryProjectionEntryDto::from)
                .collect(),
            counts: ControlAcceptedMemoryProjectionCountsDto::from(&diagnostics.counts),
            projection_write_performed: diagnostics.projection_write_performed,
            scm_effect_performed: diagnostics.scm_effect_performed,
            import_or_apply_performed: diagnostics.import_or_apply_performed,
            embedding_available: diagnostics.embedding_available,
            provider_sync_available: diagnostics.provider_sync_available,
        }
    }
}

impl From<&AcceptedMemoryProjectionDiagnosticEntry> for ControlAcceptedMemoryProjectionEntryDto {
    fn from(entry: &AcceptedMemoryProjectionDiagnosticEntry) -> Self {
        Self {
            memory_id: entry.memory_id.clone(),
            plan_ref: entry.plan_ref.clone(),
            file_ref: entry.file_ref.clone(),
            export_status: export_status_dto(&entry.export_status),
            policy_status: policy_status_dto(&entry.policy_status),
            policy_blockers: entry
                .policy_blockers
                .iter()
                .map(policy_blocker_dto)
                .collect(),
            export_blockers: entry
                .export_blockers
                .iter()
                .map(export_blocker_dto)
                .collect(),
        }
    }
}

impl From<&AcceptedMemoryProjectionDiagnosticCounts> for ControlAcceptedMemoryProjectionCountsDto {
    fn from(counts: &AcceptedMemoryProjectionDiagnosticCounts) -> Self {
        Self {
            accepted_records: counts.accepted_records,
            out_of_scope_accepted_records: counts.out_of_scope_accepted_records,
            projectable_records: counts.projectable_records,
            local_only_records: counts.local_only_records,
            blocked_records: counts.blocked_records,
            review_required_records: counts.review_required_records,
            skipped_records: counts.skipped_records,
            skipped_proposal_records: counts.skipped_proposal_records,
            skipped_unsupported_records: counts.skipped_unsupported_records,
            skipped_decode_errors: counts.skipped_decode_errors,
            policy_blockers: counts.policy_blockers,
            export_blockers: counts.export_blockers,
            file_refs: counts.file_refs,
        }
    }
}

fn policy_status_dto(status: &AcceptedMemoryProjectionPolicyStatus) -> String {
    match status {
        AcceptedMemoryProjectionPolicyStatus::Projectable => "projectable",
        AcceptedMemoryProjectionPolicyStatus::LocalOnly => "local_only",
        AcceptedMemoryProjectionPolicyStatus::Blocked => "blocked",
        AcceptedMemoryProjectionPolicyStatus::ReviewRequired => "review_required",
    }
    .to_owned()
}

fn export_status_dto(status: &AcceptedMemoryProjectionExportStatus) -> String {
    match status {
        AcceptedMemoryProjectionExportStatus::Stopped => "stopped",
        AcceptedMemoryProjectionExportStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn policy_blocker_dto(
    blocker: &AcceptedMemoryProjectionPolicyBlocker,
) -> ControlAcceptedMemoryProjectionBlockerDto {
    match blocker {
        AcceptedMemoryProjectionPolicyBlocker::NonAcceptedStatus { status } => {
            blocker_dto("non_accepted_status", Some(memory_status_dto(status)))
        }
        AcceptedMemoryProjectionPolicyBlocker::MissingProjectScope => {
            blocker_dto("missing_project_scope", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::OutOfScopeProject { .. } => {
            blocker_dto("out_of_scope_project", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::UserPrivateScope => {
            blocker_dto("user_private_scope", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::UserPrivateSensitivity => {
            blocker_dto("user_private_sensitivity", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::SecretAdjacentSensitivity => {
            blocker_dto("secret_adjacent_sensitivity", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::RestrictedSensitivity => {
            blocker_dto("restricted_sensitivity", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::ReviewQueueRetention => {
            blocker_dto("review_queue_retention", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::LocalOnlyRetention => {
            blocker_dto("local_only_retention", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::ExpiringRetention => {
            blocker_dto("expiring_retention", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::ArchiveRetention => {
            blocker_dto("archive_retention", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::MissingReviewEvidence => {
            blocker_dto("missing_review_evidence", None)
        }
        AcceptedMemoryProjectionPolicyBlocker::SupersededByAcceptedMemory { refs } => {
            blocker_dto("superseded_by_accepted_memory", Some(refs.join(",")))
        }
        AcceptedMemoryProjectionPolicyBlocker::UnsafeExportIntent { reason } => {
            blocker_dto("unsafe_export_intent", Some(reason.clone()))
        }
    }
}

fn export_blocker_dto(
    blocker: &AcceptedMemoryProjectionExportBlocker,
) -> ControlAcceptedMemoryProjectionBlockerDto {
    match blocker {
        AcceptedMemoryProjectionExportBlocker::PolicyDenied => blocker_dto("policy_denied", None),
        AcceptedMemoryProjectionExportBlocker::UnsupportedSchema { schema_version } => {
            blocker_dto("unsupported_schema", Some(schema_version.to_string()))
        }
        AcceptedMemoryProjectionExportBlocker::UnsupportedMemoryKind { kind } => {
            blocker_dto("unsupported_memory_kind", Some(kind.clone()))
        }
        AcceptedMemoryProjectionExportBlocker::UnsafePathRef { reason } => {
            blocker_dto("unsafe_path_ref", Some(reason.clone()))
        }
    }
}

fn blocker_dto(kind: &str, detail: Option<String>) -> ControlAcceptedMemoryProjectionBlockerDto {
    ControlAcceptedMemoryProjectionBlockerDto {
        kind: kind.to_owned(),
        detail,
    }
}

fn memory_status_dto(status: &AcceptedMemoryPolicyStatus) -> String {
    match status {
        AcceptedMemoryPolicyStatus::Stale => "stale",
        AcceptedMemoryPolicyStatus::Superseded => "superseded",
        AcceptedMemoryPolicyStatus::Archived => "archived",
    }
    .to_owned()
}
