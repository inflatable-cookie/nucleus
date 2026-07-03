use serde::{Deserialize, Serialize};

use crate::memory_proposals_projection::{
    MemoryProposalRetention, MemoryProposalRetentionCount, MemoryProposalReviewStatus,
    MemoryProposalScopeCount, MemoryProposalSensitivity, MemoryProposalSensitivityCount,
    MemoryProposalSourceCounts, MemoryProposalStatusCount, MemoryProposalSummary,
    MemoryProposalSummaryKind, MemoryProposalSummaryScope, MemoryProposalSummaryStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlMemoryProposalSummaryDto {
    pub proposal_id: String,
    pub scope: String,
    pub kind: String,
    pub status: String,
    pub review_status: String,
    pub sensitivity: String,
    pub retention: String,
    pub source_ref_count: usize,
    pub link_ref_count: usize,
    pub supersedes_count: usize,
    pub superseded_by_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlMemoryProposalStatusCountDto {
    pub status: String,
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlMemoryProposalScopeCountDto {
    pub scope: String,
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlMemoryProposalSensitivityCountDto {
    pub sensitivity: String,
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlMemoryProposalRetentionCountDto {
    pub retention: String,
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlMemoryProposalSourceCountsDto {
    pub proposal_records: usize,
    pub source_refs: usize,
    pub link_refs: usize,
    pub supersession_refs: usize,
}

impl From<&MemoryProposalSummary> for ControlMemoryProposalSummaryDto {
    fn from(summary: &MemoryProposalSummary) -> Self {
        Self {
            proposal_id: summary.proposal_id.clone(),
            scope: scope_dto(&summary.scope),
            kind: kind_dto(&summary.kind),
            status: status_dto(&summary.status),
            review_status: review_status_dto(&summary.review_status),
            sensitivity: sensitivity_dto(&summary.sensitivity),
            retention: retention_dto(&summary.retention),
            source_ref_count: summary.source_ref_count,
            link_ref_count: summary.link_ref_count,
            supersedes_count: summary.supersedes_count,
            superseded_by_count: summary.superseded_by_count,
        }
    }
}

impl From<&MemoryProposalStatusCount> for ControlMemoryProposalStatusCountDto {
    fn from(count: &MemoryProposalStatusCount) -> Self {
        Self {
            status: status_dto(&count.status),
            count: count.count,
        }
    }
}

impl From<&MemoryProposalScopeCount> for ControlMemoryProposalScopeCountDto {
    fn from(count: &MemoryProposalScopeCount) -> Self {
        Self {
            scope: scope_dto(&count.scope),
            count: count.count,
        }
    }
}

impl From<&MemoryProposalSensitivityCount> for ControlMemoryProposalSensitivityCountDto {
    fn from(count: &MemoryProposalSensitivityCount) -> Self {
        Self {
            sensitivity: sensitivity_dto(&count.sensitivity),
            count: count.count,
        }
    }
}

impl From<&MemoryProposalRetentionCount> for ControlMemoryProposalRetentionCountDto {
    fn from(count: &MemoryProposalRetentionCount) -> Self {
        Self {
            retention: retention_dto(&count.retention),
            count: count.count,
        }
    }
}

impl From<&MemoryProposalSourceCounts> for ControlMemoryProposalSourceCountsDto {
    fn from(counts: &MemoryProposalSourceCounts) -> Self {
        Self {
            proposal_records: counts.proposal_records,
            source_refs: counts.source_refs,
            link_refs: counts.link_refs,
            supersession_refs: counts.supersession_refs,
        }
    }
}

fn scope_dto(scope: &MemoryProposalSummaryScope) -> String {
    match scope {
        MemoryProposalSummaryScope::Project => "project",
        MemoryProposalSummaryScope::Task => "task",
        MemoryProposalSummaryScope::AgentSession => "agent_session",
        MemoryProposalSummaryScope::RepoMembership => "repo_membership",
        MemoryProposalSummaryScope::Workspace => "workspace",
        MemoryProposalSummaryScope::UserPrivate => "user_private",
    }
    .to_owned()
}

fn kind_dto(kind: &MemoryProposalSummaryKind) -> String {
    match kind {
        MemoryProposalSummaryKind::Decision => "decision",
        MemoryProposalSummaryKind::Preference => "preference",
        MemoryProposalSummaryKind::Constraint => "constraint",
        MemoryProposalSummaryKind::ArchitectureNote => "architecture_note",
        MemoryProposalSummaryKind::ProjectFact => "project_fact",
        MemoryProposalSummaryKind::TaskContext => "task_context",
        MemoryProposalSummaryKind::ValidationLesson => "validation_lesson",
        MemoryProposalSummaryKind::Risk => "risk",
        MemoryProposalSummaryKind::OpenQuestion => "open_question",
        MemoryProposalSummaryKind::ConversationSummary => "conversation_summary",
        MemoryProposalSummaryKind::HandoffSummary => "handoff_summary",
        MemoryProposalSummaryKind::ResearchFinding => "research_finding",
        MemoryProposalSummaryKind::Other(value) => value,
    }
    .to_owned()
}

fn status_dto(status: &MemoryProposalSummaryStatus) -> String {
    match status {
        MemoryProposalSummaryStatus::Proposed => "proposed",
        MemoryProposalSummaryStatus::ReviewRequested => "review_requested",
        MemoryProposalSummaryStatus::Rejected => "rejected",
        MemoryProposalSummaryStatus::Stale => "stale",
        MemoryProposalSummaryStatus::Superseded => "superseded",
        MemoryProposalSummaryStatus::Archived => "archived",
    }
    .to_owned()
}

fn review_status_dto(status: &MemoryProposalReviewStatus) -> String {
    match status {
        MemoryProposalReviewStatus::Unreviewed => "unreviewed",
        MemoryProposalReviewStatus::Queued => "queued",
        MemoryProposalReviewStatus::NeedsHumanReview => "needs_human_review",
        MemoryProposalReviewStatus::ReviewedForPromotion => "reviewed_for_promotion",
        MemoryProposalReviewStatus::Rejected => "rejected",
        MemoryProposalReviewStatus::Deferred => "deferred",
    }
    .to_owned()
}

fn sensitivity_dto(sensitivity: &MemoryProposalSensitivity) -> String {
    match sensitivity {
        MemoryProposalSensitivity::PublicProject => "public_project",
        MemoryProposalSensitivity::InternalProject => "internal_project",
        MemoryProposalSensitivity::UserPrivate => "user_private",
        MemoryProposalSensitivity::SecretAdjacent => "secret_adjacent",
        MemoryProposalSensitivity::Restricted => "restricted",
    }
    .to_owned()
}

fn retention_dto(retention: &MemoryProposalRetention) -> String {
    match retention {
        MemoryProposalRetention::ReviewQueue => "review_queue",
        MemoryProposalRetention::ProjectContextCandidate => "project_context_candidate",
        MemoryProposalRetention::LocalOnly => "local_only",
        MemoryProposalRetention::Expires => "expires",
        MemoryProposalRetention::Archive => "archive",
    }
    .to_owned()
}
