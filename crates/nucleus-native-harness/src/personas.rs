//! Native harness persona records.

/// Stable native persona id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativePersonaId(pub String);

/// Nucleus-owned persona record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativePersona {
    pub id: NativePersonaId,
    pub role: NativePersonaRole,
    pub display_name: String,
    pub capabilities: Vec<NativePersonaCapability>,
    pub policy: NativePersonaPolicy,
}

/// Built-in native persona role.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativePersonaRole {
    ProjectSteward,
    TaskTriage,
    DocumentationMaintainer,
    SyncConflictAssistant,
    ValidationSummarizer,
    ResearchLibrarian,
    LightweightLocalHelper,
    Custom(String),
}

/// Capability exposed by a native persona.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativePersonaCapability {
    InspectProjectState,
    InspectTaskState,
    NormalizeTaskMetadata,
    PrepareManagementCommit,
    CommitManagementState,
    PushManagementState,
    ReconcileMechanicalConflict,
    ProposeSemanticConflictResolution,
    DeleteTask,
    RewriteTaskHistory,
    SummarizeTaskHistory,
    SummarizeValidation,
    UpdateDocsIndexes,
    LinkForgeObjects,
    RequestHumanDecision,
    Custom(String),
}

/// Policy limits for a native persona.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativePersonaPolicy {
    pub sync_authority: NativeSyncAuthority,
    pub local_model_allowed: bool,
    pub cloud_model_allowed: bool,
    pub approval_required_for_privileged_actions: bool,
    pub may_commit_management_state: bool,
    pub may_push_management_state: bool,
    pub may_modify_code: bool,
}

/// Sync authority granted to a native persona.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeSyncAuthority {
    None,
    ProposeOnly,
    PrepareManagementCommit,
    CommitManagementState,
    PushManagementState,
}
