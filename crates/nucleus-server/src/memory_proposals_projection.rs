//! Sanitized memory proposal read model.

use std::collections::BTreeMap;

use nucleus_memory::{
    MemoryProposalStorageKind, MemoryProposalStorageRecord, MemoryProposalStorageScope,
    MemoryProposalStorageStatus, MemoryRetentionStoragePosture, MemoryReviewStorageStatus,
    MemorySensitivityStorage,
};
use nucleus_projects::ProjectId;

/// Read-only project-scoped memory proposal projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalsProjection {
    pub project_id: ProjectId,
    pub proposals: Vec<MemoryProposalSummary>,
    pub status_counts: Vec<MemoryProposalStatusCount>,
    pub scope_counts: Vec<MemoryProposalScopeCount>,
    pub sensitivity_counts: Vec<MemoryProposalSensitivityCount>,
    pub retention_counts: Vec<MemoryProposalRetentionCount>,
    pub source_counts: MemoryProposalSourceCounts,
    pub client_can_mutate: bool,
    pub provider_execution_available: bool,
}

/// Sanitized memory proposal summary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalSummary {
    pub proposal_id: String,
    pub scope: MemoryProposalSummaryScope,
    pub kind: MemoryProposalSummaryKind,
    pub status: MemoryProposalSummaryStatus,
    pub review_status: MemoryProposalReviewStatus,
    pub sensitivity: MemoryProposalSensitivity,
    pub retention: MemoryProposalRetention,
    pub source_ref_count: usize,
    pub link_ref_count: usize,
    pub supersedes_count: usize,
    pub superseded_by_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalSourceCounts {
    pub proposal_records: usize,
    pub source_refs: usize,
    pub link_refs: usize,
    pub supersession_refs: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalStatusCount {
    pub status: MemoryProposalSummaryStatus,
    pub count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalScopeCount {
    pub scope: MemoryProposalSummaryScope,
    pub count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalSensitivityCount {
    pub sensitivity: MemoryProposalSensitivity,
    pub count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalRetentionCount {
    pub retention: MemoryProposalRetention,
    pub count: usize,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum MemoryProposalSummaryScope {
    Project,
    Task,
    AgentSession,
    RepoMembership,
    Workspace,
    UserPrivate,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum MemoryProposalSummaryKind {
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
pub enum MemoryProposalSummaryStatus {
    Proposed,
    ReviewRequested,
    Rejected,
    Stale,
    Superseded,
    Archived,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum MemoryProposalReviewStatus {
    Unreviewed,
    Queued,
    NeedsHumanReview,
    ReviewedForPromotion,
    Rejected,
    Deferred,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum MemoryProposalSensitivity {
    PublicProject,
    InternalProject,
    UserPrivate,
    SecretAdjacent,
    Restricted,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum MemoryProposalRetention {
    ReviewQueue,
    ProjectContextCandidate,
    LocalOnly,
    Expires,
    Archive,
}

impl MemoryProposalsProjection {
    pub fn from_storage_records(
        project_id: ProjectId,
        records: Vec<MemoryProposalStorageRecord>,
    ) -> Self {
        let proposals: Vec<_> = records
            .iter()
            .filter(|record| record_belongs_to_project(record, &project_id))
            .map(MemoryProposalSummary::from)
            .collect();

        Self {
            project_id,
            status_counts: status_counts(&proposals),
            scope_counts: scope_counts(&proposals),
            sensitivity_counts: sensitivity_counts(&proposals),
            retention_counts: retention_counts(&proposals),
            source_counts: MemoryProposalSourceCounts::from_summaries(&proposals),
            proposals,
            client_can_mutate: false,
            provider_execution_available: false,
        }
    }
}

impl From<&MemoryProposalStorageRecord> for MemoryProposalSummary {
    fn from(record: &MemoryProposalStorageRecord) -> Self {
        Self {
            proposal_id: record.proposal_id.clone(),
            scope: MemoryProposalSummaryScope::from(&record.scope),
            kind: MemoryProposalSummaryKind::from(&record.kind),
            status: MemoryProposalSummaryStatus::from(&record.status),
            review_status: MemoryProposalReviewStatus::from(&record.review.status),
            sensitivity: MemoryProposalSensitivity::from(&record.sensitivity),
            retention: MemoryProposalRetention::from(&record.retention),
            source_ref_count: record.source_refs.len(),
            link_ref_count: record.link_refs.planning_session_refs.len()
                + record.link_refs.exploration_session_refs.len()
                + record.link_refs.planning_artifact_refs.len()
                + record.link_refs.task_seed_refs.len()
                + record.link_refs.research_brief_refs.len()
                + record.link_refs.task_refs.len()
                + record.link_refs.evidence_refs.len(),
            supersedes_count: record.supersession.supersedes.len(),
            superseded_by_count: record.supersession.superseded_by.len(),
        }
    }
}

impl MemoryProposalSourceCounts {
    fn from_summaries(summaries: &[MemoryProposalSummary]) -> Self {
        Self {
            proposal_records: summaries.len(),
            source_refs: summaries
                .iter()
                .map(|summary| summary.source_ref_count)
                .sum(),
            link_refs: summaries.iter().map(|summary| summary.link_ref_count).sum(),
            supersession_refs: summaries
                .iter()
                .map(|summary| summary.supersedes_count + summary.superseded_by_count)
                .sum(),
        }
    }
}

impl From<&MemoryProposalStorageScope> for MemoryProposalSummaryScope {
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

impl From<&MemoryProposalStorageKind> for MemoryProposalSummaryKind {
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

impl From<&MemoryProposalStorageStatus> for MemoryProposalSummaryStatus {
    fn from(status: &MemoryProposalStorageStatus) -> Self {
        match status {
            MemoryProposalStorageStatus::Proposed => Self::Proposed,
            MemoryProposalStorageStatus::ReviewRequested => Self::ReviewRequested,
            MemoryProposalStorageStatus::Rejected => Self::Rejected,
            MemoryProposalStorageStatus::Stale => Self::Stale,
            MemoryProposalStorageStatus::Superseded => Self::Superseded,
            MemoryProposalStorageStatus::Archived => Self::Archived,
        }
    }
}

impl From<&MemoryReviewStorageStatus> for MemoryProposalReviewStatus {
    fn from(status: &MemoryReviewStorageStatus) -> Self {
        match status {
            MemoryReviewStorageStatus::Unreviewed => Self::Unreviewed,
            MemoryReviewStorageStatus::Queued => Self::Queued,
            MemoryReviewStorageStatus::NeedsHumanReview => Self::NeedsHumanReview,
            MemoryReviewStorageStatus::ReviewedForPromotion => Self::ReviewedForPromotion,
            MemoryReviewStorageStatus::Rejected => Self::Rejected,
            MemoryReviewStorageStatus::Deferred => Self::Deferred,
        }
    }
}

impl From<&MemorySensitivityStorage> for MemoryProposalSensitivity {
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

impl From<&MemoryRetentionStoragePosture> for MemoryProposalRetention {
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

fn record_belongs_to_project(record: &MemoryProposalStorageRecord, project_id: &ProjectId) -> bool {
    matches!(
        &record.scope,
        MemoryProposalStorageScope::Project { project_ref } if project_ref == &project_id.0
    )
}

fn status_counts(summaries: &[MemoryProposalSummary]) -> Vec<MemoryProposalStatusCount> {
    counted(summaries.iter().map(|summary| summary.status.clone()))
        .into_iter()
        .map(|(status, count)| MemoryProposalStatusCount { status, count })
        .collect()
}

fn scope_counts(summaries: &[MemoryProposalSummary]) -> Vec<MemoryProposalScopeCount> {
    counted(summaries.iter().map(|summary| summary.scope.clone()))
        .into_iter()
        .map(|(scope, count)| MemoryProposalScopeCount { scope, count })
        .collect()
}

fn sensitivity_counts(summaries: &[MemoryProposalSummary]) -> Vec<MemoryProposalSensitivityCount> {
    counted(summaries.iter().map(|summary| summary.sensitivity.clone()))
        .into_iter()
        .map(|(sensitivity, count)| MemoryProposalSensitivityCount { sensitivity, count })
        .collect()
}

fn retention_counts(summaries: &[MemoryProposalSummary]) -> Vec<MemoryProposalRetentionCount> {
    counted(summaries.iter().map(|summary| summary.retention.clone()))
        .into_iter()
        .map(|(retention, count)| MemoryProposalRetentionCount { retention, count })
        .collect()
}

fn counted<T>(values: impl Iterator<Item = T>) -> BTreeMap<T, usize>
where
    T: Ord,
{
    let mut counts = BTreeMap::new();
    for value in values {
        *counts.entry(value).or_insert(0) += 1;
    }
    counts
}

#[cfg(test)]
mod tests {
    use nucleus_memory::{
        MemoryConfidenceStorage, MemoryLinkStorageRefs, MemoryReviewStorageState,
        MemorySourceStorageKind, MemorySourceStorageRef, MemorySupersessionStorageRefs,
        MEMORY_STORAGE_SCHEMA_VERSION,
    };

    use super::*;

    #[test]
    fn projection_filters_project_records_and_hides_body() {
        let projection = MemoryProposalsProjection::from_storage_records(
            ProjectId("project:nucleus".to_owned()),
            vec![
                proposal("memory-proposal:1", "project:nucleus"),
                proposal("memory-proposal:2", "project:other"),
            ],
        );

        assert_eq!(projection.proposals.len(), 1);
        assert_eq!(projection.proposals[0].proposal_id, "memory-proposal:1");
        assert_eq!(projection.source_counts.proposal_records, 1);
        assert_eq!(projection.source_counts.source_refs, 1);
        assert_eq!(projection.source_counts.link_refs, 2);
        assert_eq!(projection.source_counts.supersession_refs, 1);
        assert!(!projection.client_can_mutate);
        assert!(!projection.provider_execution_available);
    }

    fn proposal(id: &str, project_ref: &str) -> MemoryProposalStorageRecord {
        MemoryProposalStorageRecord {
            schema_version: MEMORY_STORAGE_SCHEMA_VERSION,
            proposal_id: id.to_owned(),
            scope: MemoryProposalStorageScope::Project {
                project_ref: project_ref.to_owned(),
            },
            kind: MemoryProposalStorageKind::Decision,
            status: MemoryProposalStorageStatus::Proposed,
            title: "Hidden from projection".to_owned(),
            summary: "Hidden from projection".to_owned(),
            detail: Some("Hidden from projection".to_owned()),
            source_refs: vec![MemorySourceStorageRef {
                kind: MemorySourceStorageKind::PlanningSession,
                source_ref: "planning-session:1".to_owned(),
                evidence_ref: Some("evidence:1".to_owned()),
            }],
            link_refs: MemoryLinkStorageRefs {
                planning_session_refs: vec!["planning-session:1".to_owned()],
                task_refs: vec!["task:1".to_owned()],
                ..MemoryLinkStorageRefs::default()
            },
            confidence: MemoryConfidenceStorage::High,
            review: MemoryReviewStorageState {
                status: MemoryReviewStorageStatus::NeedsHumanReview,
                reviewer_ref: None,
                note: None,
            },
            sensitivity: MemorySensitivityStorage::SecretAdjacent,
            retention: MemoryRetentionStoragePosture::ReviewQueue,
            supersession: MemorySupersessionStorageRefs {
                supersedes: vec!["memory-proposal:old".to_owned()],
                superseded_by: Vec::new(),
            },
            proposed_at: None,
            updated_at: None,
        }
    }
}
