//! Git-backed projection record boundary types.

use std::time::SystemTime;

/// Root path for the committable project-management projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionRoot {
    pub relative_path: String,
    pub visible_by_default: bool,
}

/// Relative path to a projected record under the projection root.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProjectionRecordPath(pub String);

/// Stable id for a projected record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProjectionRecordId(pub String);

/// Projection schema version marker.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProjectionSchemaVersion(pub String);

/// Projection record revision marker.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProjectionRecordRevision(pub String);

/// Projected record kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectionRecordKind {
    Project,
    RepoMembership,
    Task,
    Index,
    ArtifactReference,
    Custom(String),
}

/// Common metadata every projected record should preserve.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionRecordEnvelope {
    pub schema_version: ProjectionSchemaVersion,
    pub record_id: ProjectionRecordId,
    pub kind: ProjectionRecordKind,
    pub path: ProjectionRecordPath,
    pub revision: Option<ProjectionRecordRevision>,
    pub updated_at: Option<SystemTime>,
}

/// State classes that must not be committed into projection records by default.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectionExcludedStateKind {
    SecretMaterial,
    ProviderAuthMaterial,
    ProviderNativeTranscript,
    LiveRuntimeEventStream,
    LiveAgentSession,
    TerminalState,
    BrowserState,
    LocalCache,
    LocalIndex,
    MachineSpecificAbsolutePath,
    RawValidationOutput,
    Custom(String),
}

/// Projection validation outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectionValidationStatus {
    Valid,
    ValidWithWarnings,
    Invalid,
    UnsupportedSchema,
}

/// Validation report for a projected record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionValidationReport {
    pub record_id: Option<ProjectionRecordId>,
    pub path: ProjectionRecordPath,
    pub status: ProjectionValidationStatus,
    pub issues: Vec<ProjectionValidationIssue>,
}

/// Single validation issue found in a projected record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionValidationIssue {
    pub kind: ProjectionValidationIssueKind,
    pub field: Option<String>,
    pub message: Option<String>,
}

/// Validation issue category.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectionValidationIssueKind {
    MissingRequiredField,
    InvalidIdentifier,
    UnsupportedSchemaVersion,
    UnknownRecordKind,
    InvalidReference,
    ExcludedStatePresent(ProjectionExcludedStateKind),
    SemanticConflict,
    RequiresRepair,
    Custom(String),
}

/// Migration posture for a projected record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectionMigrationPosture {
    Current,
    ReadOnlyUntilMigrated,
    MechanicalMigrationAvailable,
    HumanApprovalRequired,
    Unsupported,
}

/// Planned migration action.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionMigrationPlan {
    pub record_id: ProjectionRecordId,
    pub from_schema: ProjectionSchemaVersion,
    pub to_schema: ProjectionSchemaVersion,
    pub posture: ProjectionMigrationPosture,
    pub actions: Vec<ProjectionMigrationAction>,
}

/// Migration action category.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectionMigrationAction {
    AddDefaultedField(String),
    RenameField { from: String, to: String },
    NormalizeIdentifier(String),
    SplitRecord(String),
    RequiresHumanDecision(String),
    Unsupported(String),
    Custom(String),
}
