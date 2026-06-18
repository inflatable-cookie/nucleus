use super::safety::contains_forbidden_steward_term;

/// Proposal target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardProposalTarget {
    Project { project_ref: String },
    Task { task_ref: String },
    TaskSet { task_refs: Vec<String> },
    DocsIndex { index_ref: String },
    ManagementProjection { projection_ref: String },
    ProjectionConflict { conflict_report_ref: String },
    ScmWorkSession { work_session_ref: String },
    ChangeRequestPrep { prep_ref: String },
    Custom(String),
}

/// Proposal kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardProposalKind {
    TaskMetadataNormalization,
    DuplicateTaskDetection,
    BlockedTaskFlag,
    StaleTaskFlag,
    ReadinessHint,
    DocumentationIndexUpdate,
    ProjectOrganizationHint,
    MechanicalSyncRepair,
    SemanticSyncEscalation,
    ManagementCapturePreparation,
    ChangeRequestPreparation,
    Custom(String),
}

/// Proposal review state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardProposalReview {
    Draft,
    NeedsHumanApproval,
    NeedsPolicyApproval,
    AcceptedForLaterMutation,
    Rejected(String),
    Superseded(String),
}

/// One field-level proposed change.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeStewardProposedChange {
    pub field: NativeStewardChangeField,
    pub semantic: NativeStewardChangeSemantic,
    pub before_ref: Option<String>,
    pub after_ref: Option<String>,
    pub rationale: Option<String>,
}

impl NativeStewardProposedChange {
    pub fn uses_reference_only_evidence(&self) -> bool {
        self.before_ref
            .as_ref()
            .map(|value| !contains_forbidden_steward_term(value))
            .unwrap_or(true)
            && self
                .after_ref
                .as_ref()
                .map(|value| !contains_forbidden_steward_term(value))
                .unwrap_or(true)
            && self
                .rationale
                .as_ref()
                .map(|value| !contains_forbidden_steward_term(value))
                .unwrap_or(true)
    }
}

/// Field family named by a proposed change.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardChangeField {
    Title,
    Description,
    AcceptanceCriteria,
    Importance,
    AgentReadiness,
    Blocker,
    Staleness,
    DuplicateLink,
    DocsIndexEntry,
    ProjectGrouping,
    ProjectionConflictResolution,
    ManagementCapturePlan,
    ChangeRequestPrep,
    Custom(String),
}

/// Whether a change is mechanical or meaning-changing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardChangeSemantic {
    Mechanical,
    Semantic,
}

/// Evidence supporting a steward proposal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeStewardEvidenceRef {
    pub source: NativeStewardEvidenceSource,
    pub ref_id: String,
}

impl NativeStewardEvidenceRef {
    pub fn uses_reference_only_evidence(&self) -> bool {
        !contains_forbidden_steward_term(&self.ref_id)
    }
}

/// Source family for proposal evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardEvidenceSource {
    Effigy,
    Scm,
    ProjectionConflict,
    ScmWorkSession,
    ChangeRequestPrep,
    ManagementProjection,
    Validation,
    Task,
    Docs,
    RuntimeReceipt,
    Custom(String),
}
