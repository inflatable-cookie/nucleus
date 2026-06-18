/// Stable native steward command id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativeStewardCommandId(pub String);

/// Command class.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardCommandKind {
    ReadOnlyInspection,
    ProposalDrafting,
    ManagementCapturePreparation,
    SyncAssistance,
    EffigyInspection,
    Custom(String),
}

/// Authority scope requested by a command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardCommandScope {
    ReadOnly,
    ProposalOnly,
    ApprovalRequired,
    Unsupported,
    Unknown,
}

/// Command target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardCommandTarget {
    Project { project_ref: String },
    Task { task_ref: String },
    TaskSet { task_refs: Vec<String> },
    EffigyIntegration { integration_ref: String },
    ManagementProjection { projection_ref: String },
    ProjectionConflict { conflict_report_ref: String },
    ScmWorkSession { work_session_ref: String },
    ChangeRequestPrep { prep_ref: String },
    Custom(String),
}

/// Command lifecycle outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardCommandStatus {
    Accepted,
    Rejected(String),
    Blocked(String),
    Completed,
    CompletedWithWarnings,
    Unknown,
}
