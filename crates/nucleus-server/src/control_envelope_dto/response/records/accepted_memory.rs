use serde::{Deserialize, Serialize};

use crate::accepted_memory_projection::{
    AcceptedMemoryConfidence, AcceptedMemoryConfidenceCount, AcceptedMemoryKindCount,
    AcceptedMemoryRetention, AcceptedMemoryRetentionCount, AcceptedMemoryScopeCount,
    AcceptedMemorySensitivity, AcceptedMemorySensitivityCount, AcceptedMemorySourceCounts,
    AcceptedMemoryStatusCount, AcceptedMemorySummary, AcceptedMemorySummaryKind,
    AcceptedMemorySummaryScope, AcceptedMemorySummaryStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemorySummaryDto {
    pub memory_id: String,
    pub source_proposal_id: Option<String>,
    pub scope: String,
    pub kind: String,
    pub status: String,
    pub sensitivity: String,
    pub retention: String,
    pub confidence: String,
    pub created_by_ref: String,
    pub accepted_by_ref: String,
    pub reviewer_ref: String,
    pub source_ref_count: usize,
    pub link_ref_count: usize,
    pub evidence_ref_count: usize,
    pub supersedes_count: usize,
    pub superseded_by_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryStatusCountDto {
    pub status: String,
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryScopeCountDto {
    pub scope: String,
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryKindCountDto {
    pub kind: String,
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemorySensitivityCountDto {
    pub sensitivity: String,
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryRetentionCountDto {
    pub retention: String,
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryConfidenceCountDto {
    pub confidence: String,
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemorySourceCountsDto {
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

impl From<&AcceptedMemorySummary> for ControlAcceptedMemorySummaryDto {
    fn from(summary: &AcceptedMemorySummary) -> Self {
        Self {
            memory_id: summary.memory_id.clone(),
            source_proposal_id: summary.source_proposal_id.clone(),
            scope: scope_dto(&summary.scope),
            kind: kind_dto(&summary.kind),
            status: status_dto(&summary.status),
            sensitivity: sensitivity_dto(&summary.sensitivity),
            retention: retention_dto(&summary.retention),
            confidence: confidence_dto(&summary.confidence),
            created_by_ref: summary.created_by_ref.clone(),
            accepted_by_ref: summary.accepted_by_ref.clone(),
            reviewer_ref: summary.reviewer_ref.clone(),
            source_ref_count: summary.source_ref_count,
            link_ref_count: summary.link_ref_count,
            evidence_ref_count: summary.evidence_ref_count,
            supersedes_count: summary.supersedes_count,
            superseded_by_count: summary.superseded_by_count,
        }
    }
}

impl From<&AcceptedMemoryStatusCount> for ControlAcceptedMemoryStatusCountDto {
    fn from(count: &AcceptedMemoryStatusCount) -> Self {
        Self {
            status: status_dto(&count.status),
            count: count.count,
        }
    }
}

impl From<&AcceptedMemoryScopeCount> for ControlAcceptedMemoryScopeCountDto {
    fn from(count: &AcceptedMemoryScopeCount) -> Self {
        Self {
            scope: scope_dto(&count.scope),
            count: count.count,
        }
    }
}

impl From<&AcceptedMemoryKindCount> for ControlAcceptedMemoryKindCountDto {
    fn from(count: &AcceptedMemoryKindCount) -> Self {
        Self {
            kind: kind_dto(&count.kind),
            count: count.count,
        }
    }
}

impl From<&AcceptedMemorySensitivityCount> for ControlAcceptedMemorySensitivityCountDto {
    fn from(count: &AcceptedMemorySensitivityCount) -> Self {
        Self {
            sensitivity: sensitivity_dto(&count.sensitivity),
            count: count.count,
        }
    }
}

impl From<&AcceptedMemoryRetentionCount> for ControlAcceptedMemoryRetentionCountDto {
    fn from(count: &AcceptedMemoryRetentionCount) -> Self {
        Self {
            retention: retention_dto(&count.retention),
            count: count.count,
        }
    }
}

impl From<&AcceptedMemoryConfidenceCount> for ControlAcceptedMemoryConfidenceCountDto {
    fn from(count: &AcceptedMemoryConfidenceCount) -> Self {
        Self {
            confidence: confidence_dto(&count.confidence),
            count: count.count,
        }
    }
}

impl From<&AcceptedMemorySourceCounts> for ControlAcceptedMemorySourceCountsDto {
    fn from(counts: &AcceptedMemorySourceCounts) -> Self {
        Self {
            accepted_records: counts.accepted_records,
            out_of_scope_accepted_records: counts.out_of_scope_accepted_records,
            skipped_records: counts.skipped_records,
            skipped_proposal_records: counts.skipped_proposal_records,
            skipped_unsupported_records: counts.skipped_unsupported_records,
            skipped_decode_errors: counts.skipped_decode_errors,
            source_refs: counts.source_refs,
            link_refs: counts.link_refs,
            evidence_refs: counts.evidence_refs,
            supersession_refs: counts.supersession_refs,
        }
    }
}

fn scope_dto(scope: &AcceptedMemorySummaryScope) -> String {
    match scope {
        AcceptedMemorySummaryScope::Project => "project",
        AcceptedMemorySummaryScope::Task => "task",
        AcceptedMemorySummaryScope::AgentSession => "agent_session",
        AcceptedMemorySummaryScope::RepoMembership => "repo_membership",
        AcceptedMemorySummaryScope::Workspace => "workspace",
        AcceptedMemorySummaryScope::UserPrivate => "user_private",
    }
    .to_owned()
}

fn kind_dto(kind: &AcceptedMemorySummaryKind) -> String {
    match kind {
        AcceptedMemorySummaryKind::Decision => "decision",
        AcceptedMemorySummaryKind::Preference => "preference",
        AcceptedMemorySummaryKind::Constraint => "constraint",
        AcceptedMemorySummaryKind::ArchitectureNote => "architecture_note",
        AcceptedMemorySummaryKind::ProjectFact => "project_fact",
        AcceptedMemorySummaryKind::TaskContext => "task_context",
        AcceptedMemorySummaryKind::ValidationLesson => "validation_lesson",
        AcceptedMemorySummaryKind::Risk => "risk",
        AcceptedMemorySummaryKind::OpenQuestion => "open_question",
        AcceptedMemorySummaryKind::ConversationSummary => "conversation_summary",
        AcceptedMemorySummaryKind::HandoffSummary => "handoff_summary",
        AcceptedMemorySummaryKind::ResearchFinding => "research_finding",
        AcceptedMemorySummaryKind::Other(value) => value,
    }
    .to_owned()
}

fn status_dto(status: &AcceptedMemorySummaryStatus) -> String {
    match status {
        AcceptedMemorySummaryStatus::Accepted => "accepted",
        AcceptedMemorySummaryStatus::Stale => "stale",
        AcceptedMemorySummaryStatus::Superseded => "superseded",
        AcceptedMemorySummaryStatus::Archived => "archived",
    }
    .to_owned()
}

fn sensitivity_dto(sensitivity: &AcceptedMemorySensitivity) -> String {
    match sensitivity {
        AcceptedMemorySensitivity::PublicProject => "public_project",
        AcceptedMemorySensitivity::InternalProject => "internal_project",
        AcceptedMemorySensitivity::UserPrivate => "user_private",
        AcceptedMemorySensitivity::SecretAdjacent => "secret_adjacent",
        AcceptedMemorySensitivity::Restricted => "restricted",
    }
    .to_owned()
}

fn retention_dto(retention: &AcceptedMemoryRetention) -> String {
    match retention {
        AcceptedMemoryRetention::ReviewQueue => "review_queue",
        AcceptedMemoryRetention::ProjectContextCandidate => "project_context_candidate",
        AcceptedMemoryRetention::LocalOnly => "local_only",
        AcceptedMemoryRetention::Expires => "expires",
        AcceptedMemoryRetention::Archive => "archive",
    }
    .to_owned()
}

fn confidence_dto(confidence: &AcceptedMemoryConfidence) -> String {
    match confidence {
        AcceptedMemoryConfidence::Unknown => "unknown",
        AcceptedMemoryConfidence::Low => "low",
        AcceptedMemoryConfidence::Medium => "medium",
        AcceptedMemoryConfidence::High => "high",
    }
    .to_owned()
}
