//! Sanitized accepted-memory read projection.

use nucleus_memory::{
    AcceptedMemoryStorageRecord, AcceptedMemoryStorageStatus, MemoryConfidenceStorage,
    MemoryProposalStorageKind, MemoryProposalStorageScope, MemoryRetentionStoragePosture,
    MemorySensitivityStorage,
};
use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_counts::{
    confidence_counts, kind_counts, retention_counts, scope_counts, sensitivity_counts,
    status_counts,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjection {
    pub project_id: ProjectId,
    pub memories: Vec<AcceptedMemorySummary>,
    pub status_counts: Vec<AcceptedMemoryStatusCount>,
    pub scope_counts: Vec<AcceptedMemoryScopeCount>,
    pub kind_counts: Vec<AcceptedMemoryKindCount>,
    pub sensitivity_counts: Vec<AcceptedMemorySensitivityCount>,
    pub retention_counts: Vec<AcceptedMemoryRetentionCount>,
    pub confidence_counts: Vec<AcceptedMemoryConfidenceCount>,
    pub source_counts: AcceptedMemorySourceCounts,
    pub client_can_mutate: bool,
    pub projection_written: bool,
    pub embedding_available: bool,
    pub provider_sync_available: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionRecord {
    Accepted(AcceptedMemoryStorageRecord),
    ProposalRecordSkipped { record_id: String },
    UnsupportedRecordSkipped { record_id: String },
    DecodeFailedSkipped { record_id: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemorySummary {
    pub memory_id: String,
    pub source_proposal_id: Option<String>,
    pub scope: AcceptedMemorySummaryScope,
    pub kind: AcceptedMemorySummaryKind,
    pub status: AcceptedMemorySummaryStatus,
    pub sensitivity: AcceptedMemorySensitivity,
    pub retention: AcceptedMemoryRetention,
    pub confidence: AcceptedMemoryConfidence,
    pub created_by_ref: String,
    pub accepted_by_ref: String,
    pub reviewer_ref: String,
    pub source_ref_count: usize,
    pub link_ref_count: usize,
    pub evidence_ref_count: usize,
    pub supersedes_count: usize,
    pub superseded_by_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemorySourceCounts {
    pub accepted_records: usize,
    pub out_of_scope_accepted_records: usize,
    pub skipped_records: usize,
    pub skipped_proposal_records: usize,
    pub skipped_unsupported_records: usize,
    pub skipped_decode_errors: usize,
    pub source_refs: usize,
    pub link_refs: usize,
    pub evidence_refs: usize,
    pub supersession_refs: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryStatusCount {
    pub status: AcceptedMemorySummaryStatus,
    pub count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryScopeCount {
    pub scope: AcceptedMemorySummaryScope,
    pub count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryKindCount {
    pub kind: AcceptedMemorySummaryKind,
    pub count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemorySensitivityCount {
    pub sensitivity: AcceptedMemorySensitivity,
    pub count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryRetentionCount {
    pub retention: AcceptedMemoryRetention,
    pub count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryConfidenceCount {
    pub confidence: AcceptedMemoryConfidence,
    pub count: usize,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum AcceptedMemorySummaryScope {
    Project,
    Task,
    AgentSession,
    RepoMembership,
    Workspace,
    UserPrivate,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum AcceptedMemorySummaryKind {
    Decision,
    Preference,
    Constraint,
    ArchitectureNote,
    ProjectFact,
    TaskContext,
    ValidationLesson,
    Risk,
    OpenQuestion,
    ConversationSummary,
    HandoffSummary,
    ResearchFinding,
    Other(String),
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum AcceptedMemorySummaryStatus {
    Accepted,
    Stale,
    Superseded,
    Archived,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum AcceptedMemorySensitivity {
    PublicProject,
    InternalProject,
    UserPrivate,
    SecretAdjacent,
    Restricted,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum AcceptedMemoryRetention {
    ReviewQueue,
    ProjectContextCandidate,
    LocalOnly,
    Expires,
    Archive,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum AcceptedMemoryConfidence {
    Unknown,
    Low,
    Medium,
    High,
}

impl AcceptedMemoryProjection {
    pub fn from_projection_records(
        project_id: ProjectId,
        records: impl IntoIterator<Item = AcceptedMemoryProjectionRecord>,
    ) -> Self {
        let mut source_counts = AcceptedMemorySourceCounts::empty();
        let mut memories = Vec::new();

        for record in records {
            match record {
                AcceptedMemoryProjectionRecord::Accepted(record) => {
                    source_counts.accepted_records += 1;
                    if accepted_record_belongs_to_project(&record, &project_id) {
                        let summary = AcceptedMemorySummary::from(&record);
                        source_counts.add_summary(&summary);
                        memories.push(summary);
                    } else {
                        source_counts.out_of_scope_accepted_records += 1;
                    }
                }
                AcceptedMemoryProjectionRecord::ProposalRecordSkipped { .. } => {
                    source_counts.skipped_records += 1;
                    source_counts.skipped_proposal_records += 1;
                }
                AcceptedMemoryProjectionRecord::UnsupportedRecordSkipped { .. } => {
                    source_counts.skipped_records += 1;
                    source_counts.skipped_unsupported_records += 1;
                }
                AcceptedMemoryProjectionRecord::DecodeFailedSkipped { .. } => {
                    source_counts.skipped_records += 1;
                    source_counts.skipped_decode_errors += 1;
                }
            }
        }

        Self {
            project_id,
            status_counts: status_counts(&memories),
            scope_counts: scope_counts(&memories),
            kind_counts: kind_counts(&memories),
            sensitivity_counts: sensitivity_counts(&memories),
            retention_counts: retention_counts(&memories),
            confidence_counts: confidence_counts(&memories),
            source_counts,
            memories,
            client_can_mutate: false,
            projection_written: false,
            embedding_available: false,
            provider_sync_available: false,
        }
    }
}

impl From<&AcceptedMemoryStorageRecord> for AcceptedMemorySummary {
    fn from(record: &AcceptedMemoryStorageRecord) -> Self {
        Self {
            memory_id: record.memory_id.clone(),
            source_proposal_id: record.source_proposal_id.clone(),
            scope: AcceptedMemorySummaryScope::from(&record.scope),
            kind: AcceptedMemorySummaryKind::from(&record.kind),
            status: AcceptedMemorySummaryStatus::from(&record.status),
            sensitivity: AcceptedMemorySensitivity::from(&record.sensitivity),
            retention: AcceptedMemoryRetention::from(&record.retention),
            confidence: AcceptedMemoryConfidence::from(&record.confidence),
            created_by_ref: record.actors.created_by_ref.clone(),
            accepted_by_ref: record.actors.accepted_by_ref.clone(),
            reviewer_ref: record.review.reviewer_ref.clone(),
            source_ref_count: record.source_refs.len(),
            link_ref_count: link_ref_count(record),
            evidence_ref_count: record.link_refs.evidence_refs.len(),
            supersedes_count: record.supersession.supersedes.len(),
            superseded_by_count: record.supersession.superseded_by.len(),
        }
    }
}

impl From<&MemoryProposalStorageScope> for AcceptedMemorySummaryScope {
    fn from(scope: &MemoryProposalStorageScope) -> Self {
        match scope {
            MemoryProposalStorageScope::Project { .. } => Self::Project,
            MemoryProposalStorageScope::Task { .. } => Self::Task,
            MemoryProposalStorageScope::AgentSession { .. } => Self::AgentSession,
            MemoryProposalStorageScope::RepoMembership { .. } => Self::RepoMembership,
            MemoryProposalStorageScope::Workspace { .. } => Self::Workspace,
            MemoryProposalStorageScope::UserPrivate => Self::UserPrivate,
        }
    }
}

impl From<&MemoryProposalStorageKind> for AcceptedMemorySummaryKind {
    fn from(kind: &MemoryProposalStorageKind) -> Self {
        match kind {
            MemoryProposalStorageKind::Decision => Self::Decision,
            MemoryProposalStorageKind::Preference => Self::Preference,
            MemoryProposalStorageKind::Constraint => Self::Constraint,
            MemoryProposalStorageKind::ArchitectureNote => Self::ArchitectureNote,
            MemoryProposalStorageKind::ProjectFact => Self::ProjectFact,
            MemoryProposalStorageKind::TaskContext => Self::TaskContext,
            MemoryProposalStorageKind::ValidationLesson => Self::ValidationLesson,
            MemoryProposalStorageKind::Risk => Self::Risk,
            MemoryProposalStorageKind::OpenQuestion => Self::OpenQuestion,
            MemoryProposalStorageKind::ConversationSummary => Self::ConversationSummary,
            MemoryProposalStorageKind::HandoffSummary => Self::HandoffSummary,
            MemoryProposalStorageKind::ResearchFinding => Self::ResearchFinding,
            MemoryProposalStorageKind::Other { label } => Self::Other(label.clone()),
        }
    }
}

impl From<&AcceptedMemoryStorageStatus> for AcceptedMemorySummaryStatus {
    fn from(status: &AcceptedMemoryStorageStatus) -> Self {
        match status {
            AcceptedMemoryStorageStatus::Accepted => Self::Accepted,
            AcceptedMemoryStorageStatus::Stale => Self::Stale,
            AcceptedMemoryStorageStatus::Superseded => Self::Superseded,
            AcceptedMemoryStorageStatus::Archived => Self::Archived,
        }
    }
}

impl From<&MemorySensitivityStorage> for AcceptedMemorySensitivity {
    fn from(sensitivity: &MemorySensitivityStorage) -> Self {
        match sensitivity {
            MemorySensitivityStorage::PublicProject => Self::PublicProject,
            MemorySensitivityStorage::InternalProject => Self::InternalProject,
            MemorySensitivityStorage::UserPrivate => Self::UserPrivate,
            MemorySensitivityStorage::SecretAdjacent => Self::SecretAdjacent,
            MemorySensitivityStorage::Restricted => Self::Restricted,
        }
    }
}

impl From<&MemoryRetentionStoragePosture> for AcceptedMemoryRetention {
    fn from(retention: &MemoryRetentionStoragePosture) -> Self {
        match retention {
            MemoryRetentionStoragePosture::ReviewQueue => Self::ReviewQueue,
            MemoryRetentionStoragePosture::ProjectContextCandidate => Self::ProjectContextCandidate,
            MemoryRetentionStoragePosture::LocalOnly => Self::LocalOnly,
            MemoryRetentionStoragePosture::Expires { .. } => Self::Expires,
            MemoryRetentionStoragePosture::Archive => Self::Archive,
        }
    }
}

impl From<&MemoryConfidenceStorage> for AcceptedMemoryConfidence {
    fn from(confidence: &MemoryConfidenceStorage) -> Self {
        match confidence {
            MemoryConfidenceStorage::Unknown => Self::Unknown,
            MemoryConfidenceStorage::Low => Self::Low,
            MemoryConfidenceStorage::Medium => Self::Medium,
            MemoryConfidenceStorage::High => Self::High,
        }
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

fn link_ref_count(record: &AcceptedMemoryStorageRecord) -> usize {
    record.link_refs.planning_session_refs.len()
        + record.link_refs.exploration_session_refs.len()
        + record.link_refs.planning_artifact_refs.len()
        + record.link_refs.task_seed_refs.len()
        + record.link_refs.research_brief_refs.len()
        + record.link_refs.task_refs.len()
        + record.link_refs.evidence_refs.len()
}
