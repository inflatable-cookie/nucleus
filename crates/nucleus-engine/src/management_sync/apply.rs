use nucleus_core::RevisionId;

use crate::ManagementProjectionRecordId;

/// Stable id for one management projection apply command.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ManagementProjectionApplyCommandId(pub String);

/// Engine-level command vocabulary for applying staged projection records.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionApplyCommand {
    pub command_id: ManagementProjectionApplyCommandId,
    pub actor_ref: String,
    pub target_project_id: String,
    pub targets: Vec<ManagementProjectionApplyRecordTarget>,
    pub validation_report_refs: Vec<String>,
    pub conflict_resolution_refs: Vec<String>,
}

impl ManagementProjectionApplyCommand {
    pub fn mutates_scm(&self) -> bool {
        false
    }

    pub fn requires_explicit_targets(&self) -> bool {
        !self.targets.is_empty()
    }
}

/// One staged projection record targeted for apply.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionApplyRecordTarget {
    pub record_id: ManagementProjectionRecordId,
    pub expected_current_revision: Option<RevisionId>,
}
