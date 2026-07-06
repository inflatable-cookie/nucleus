//! Persistence identity and storage location types.

/// Stable persisted record id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct PersistenceRecordId(pub String);

/// Persisted state domain.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PersistenceDomain {
    Projects,
    Tasks,
    TaskHistory,
    SharedMemory,
    Planning,
    DeepResearch,
    ProjectTooling,
    Workspaces,
    AgentSessions,
    AdapterRegistry,
    ModelRoutes,
    ServerConfig,
    EventJournal,
    CommandEvidence,
    ArtifactMetadata,
    RuntimeEffects,
    ClientAuth,
}

/// Persisted record category.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PersistenceRecordKind {
    Project,
    RepoMembership,
    Task,
    TaskHistoryEntry,
    SharedMemoryRecord,
    SharedMemoryReviewReceipt,
    PlanningSession,
    PlanningArtifact,
    PlanningImportApplyPlan,
    PlanningImportActiveApplyAdmission,
    TaskSeed,
    ResearchRun,
    ResearchQuestion,
    ResearchSource,
    ResearchObservation,
    ResearchSynthesis,
    ProjectToolIntegration,
    EffigyIntegration,
    WorkspaceLayout,
    AgentSession,
    AdapterInstance,
    ModelRoute,
    ServerConfig,
    Event,
    CommandEvidence,
    ArtifactMetadata,
    RuntimeEffect,
    ClientAuth,
}

/// Storage backend family. This is not a concrete backend selection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageBackendKind {
    EmbeddedDatabase,
    Filesystem,
    RemoteDatabase,
    Custom(String),
}

/// Storage location identity from the server's point of view.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageLocation {
    ServerDataRoot,
    ProjectLocalPath(String),
    RemoteEndpoint(String),
    Custom(String),
}

/// Stable persisted record envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PersistenceRecord {
    pub id: PersistenceRecordId,
    pub domain: PersistenceDomain,
    pub kind: PersistenceRecordKind,
    pub revision_id: super::RevisionId,
}
