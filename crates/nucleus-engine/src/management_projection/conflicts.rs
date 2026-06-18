use serde::{Deserialize, Serialize};

use super::types::{ManagementProjectionFileRef, ManagementProjectionRecordId};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionConflictReport {
    pub conflict_id: String,
    pub file_ref: ManagementProjectionFileRef,
    pub local_record_ref: Option<ManagementProjectionRecordId>,
    pub incoming_record_ref: Option<ManagementProjectionRecordId>,
    pub class: ManagementProjectionConflictClass,
    pub summary: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "class", content = "kind", rename_all = "snake_case")]
pub enum ManagementProjectionConflictClass {
    Schema(ManagementProjectionSchemaConflictKind),
    Semantic(ManagementProjectionSemanticConflictKind),
    Unsupported(ManagementProjectionUnsupportedConflictKind),
    Scm(ManagementProjectionScmConflictKind),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionSchemaConflictKind {
    InvalidRecordShape,
    UnsupportedSchema,
    MissingRequiredField,
    UnknownRecordKind,
    ExcludedStatePresent,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionSemanticConflictKind {
    ProjectIdentityMismatch,
    RepoMembershipMeaningChange,
    TaskDeletionVersusUpdate,
    IncompatibleTaskStatus,
    AcceptanceCriteriaRewrite,
    AssignmentIntentMismatch,
    MeaningfulHistoryRewrite,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionUnsupportedConflictKind {
    UnsupportedRecordKind,
    UnsupportedPayloadKind,
    UnsupportedSchemaPreserved,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionScmConflictKind {
    WorkingCopyDirty,
    FileChangedDuringExport,
    FileChangedDuringImport,
    ProjectionPathConflict,
    SyncBaseUnknown,
    AdapterConflict(String),
}
