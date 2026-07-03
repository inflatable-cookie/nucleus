//! Sanitized planning session read model.

use std::collections::BTreeMap;

use nucleus_planning::{
    ExplorationSessionStorageRecord, PlanningSessionStorageKind, PlanningSessionStorageRecord,
    PlanningSessionStorageStatus, PlanningSourceStorageKind,
};
use nucleus_projects::ProjectId;

/// Read-only project-scoped planning session projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningSessionsProjection {
    pub project_id: ProjectId,
    pub sessions: Vec<PlanningSessionSummary>,
    pub status_counts: Vec<PlanningSessionStatusCount>,
    pub source_counts: PlanningSessionSourceCounts,
    pub client_can_mutate: bool,
    pub provider_execution_available: bool,
}

/// Sanitized planning session summary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningSessionSummary {
    pub session_id: String,
    pub kind: PlanningSessionSummaryKind,
    pub status: PlanningSessionSummaryStatus,
    pub prompt_or_template_refs: Vec<String>,
    pub participant_count: usize,
    pub source_ref_count: usize,
    pub source_kind_counts: Vec<PlanningSessionSourceKindCount>,
    pub output_refs: PlanningSessionOutputRefs,
}

/// Count of planning sessions by status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningSessionStatusCount {
    pub status: PlanningSessionSummaryStatus,
    pub count: usize,
}

/// Count of source refs by source kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningSessionSourceKindCount {
    pub kind: PlanningSessionSourceKind,
    pub count: usize,
}

/// Aggregate source counts for a project-scoped query.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningSessionSourceCounts {
    pub planning_session_records: usize,
    pub exploration_session_records: usize,
    pub prompt_or_template_refs: usize,
    pub participant_refs: usize,
    pub source_refs: usize,
    pub output_refs: usize,
}

/// Sanitized output refs attached to a planning session.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PlanningSessionOutputRefs {
    pub artifact_refs: Vec<String>,
    pub task_seed_refs: Vec<String>,
    pub memory_proposal_refs: Vec<String>,
    pub research_run_brief_refs: Vec<String>,
}

/// Planning session kind for client-safe projections.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum PlanningSessionSummaryKind {
    ProjectIntake,
    VisionDefinition,
    Ideation,
    ArchitecturePlanning,
    ResearchPlanning,
    DeepResearch,
    RoadmapPlanning,
    TaskBreakdown,
    DecisionReview,
    Other(String),
}

/// Planning session status for client-safe projections.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum PlanningSessionSummaryStatus {
    Draft,
    Active,
    Paused,
    Review,
    Accepted,
    Superseded,
    Archived,
}

/// Source kind bucket. Source ref values are intentionally not exposed here.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum PlanningSessionSourceKind {
    OperatorPrompt,
    ConversationSummary,
    TranscriptRef,
    ExistingDocument,
    ResearchRun,
    Memory,
    Task,
    ProjectionFile,
    Other(String),
}

impl PlanningSessionsProjection {
    /// Compose a sanitized project-scoped projection from decoded storage records.
    pub fn from_storage_records(
        project_id: ProjectId,
        planning_sessions: Vec<PlanningSessionStorageRecord>,
        exploration_sessions: Vec<ExplorationSessionStorageRecord>,
    ) -> Self {
        let sessions: Vec<_> = planning_sessions
            .iter()
            .filter(|session| session.project_id == project_id.0)
            .map(PlanningSessionSummary::from)
            .collect();

        let status_counts = status_counts(&sessions);
        let source_counts = PlanningSessionSourceCounts::from_records(
            &sessions,
            &exploration_sessions,
            &project_id,
        );

        Self {
            project_id,
            sessions,
            status_counts,
            source_counts,
            client_can_mutate: false,
            provider_execution_available: false,
        }
    }
}

impl From<&PlanningSessionStorageRecord> for PlanningSessionSummary {
    fn from(record: &PlanningSessionStorageRecord) -> Self {
        let output_refs = PlanningSessionOutputRefs {
            artifact_refs: record.output_refs.artifact_refs.clone(),
            task_seed_refs: record.output_refs.task_seed_refs.clone(),
            memory_proposal_refs: record.output_refs.memory_proposal_refs.clone(),
            research_run_brief_refs: record.output_refs.research_run_brief_refs.clone(),
        };
        Self {
            session_id: record.session_id.clone(),
            kind: PlanningSessionSummaryKind::from(&record.kind),
            status: PlanningSessionSummaryStatus::from(&record.status),
            prompt_or_template_refs: record.prompt_or_template_refs.clone(),
            participant_count: record.participants.len(),
            source_ref_count: record.source_refs.len(),
            source_kind_counts: source_kind_counts(
                record.source_refs.iter().map(|source| &source.kind),
            ),
            output_refs,
        }
    }
}

impl PlanningSessionSourceCounts {
    fn from_records(
        sessions: &[PlanningSessionSummary],
        exploration_sessions: &[ExplorationSessionStorageRecord],
        project_id: &ProjectId,
    ) -> Self {
        let exploration_session_records = exploration_sessions
            .iter()
            .filter(|session| session.project_id.as_deref() == Some(project_id.0.as_str()))
            .count();
        Self {
            planning_session_records: sessions.len(),
            exploration_session_records,
            prompt_or_template_refs: sessions
                .iter()
                .map(|session| session.prompt_or_template_refs.len())
                .sum(),
            participant_refs: sessions
                .iter()
                .map(|session| session.participant_count)
                .sum(),
            source_refs: sessions
                .iter()
                .map(|session| session.source_ref_count)
                .sum(),
            output_refs: sessions
                .iter()
                .map(|session| session.output_refs.total_refs())
                .sum(),
        }
    }
}

impl PlanningSessionOutputRefs {
    fn total_refs(&self) -> usize {
        self.artifact_refs.len()
            + self.task_seed_refs.len()
            + self.memory_proposal_refs.len()
            + self.research_run_brief_refs.len()
    }
}

impl From<&PlanningSessionStorageKind> for PlanningSessionSummaryKind {
    fn from(kind: &PlanningSessionStorageKind) -> Self {
        match kind {
            PlanningSessionStorageKind::ProjectIntake => Self::ProjectIntake,
            PlanningSessionStorageKind::VisionDefinition => Self::VisionDefinition,
            PlanningSessionStorageKind::Ideation => Self::Ideation,
            PlanningSessionStorageKind::ArchitecturePlanning => Self::ArchitecturePlanning,
            PlanningSessionStorageKind::ResearchPlanning => Self::ResearchPlanning,
            PlanningSessionStorageKind::DeepResearch => Self::DeepResearch,
            PlanningSessionStorageKind::RoadmapPlanning => Self::RoadmapPlanning,
            PlanningSessionStorageKind::TaskBreakdown => Self::TaskBreakdown,
            PlanningSessionStorageKind::DecisionReview => Self::DecisionReview,
            PlanningSessionStorageKind::Other(value) => Self::Other(value.clone()),
        }
    }
}

impl From<&PlanningSessionStorageStatus> for PlanningSessionSummaryStatus {
    fn from(status: &PlanningSessionStorageStatus) -> Self {
        match status {
            PlanningSessionStorageStatus::Draft => Self::Draft,
            PlanningSessionStorageStatus::Active => Self::Active,
            PlanningSessionStorageStatus::Paused => Self::Paused,
            PlanningSessionStorageStatus::Review => Self::Review,
            PlanningSessionStorageStatus::Accepted => Self::Accepted,
            PlanningSessionStorageStatus::Superseded => Self::Superseded,
            PlanningSessionStorageStatus::Archived => Self::Archived,
        }
    }
}

impl From<&PlanningSourceStorageKind> for PlanningSessionSourceKind {
    fn from(kind: &PlanningSourceStorageKind) -> Self {
        match kind {
            PlanningSourceStorageKind::OperatorPrompt => Self::OperatorPrompt,
            PlanningSourceStorageKind::ConversationSummary => Self::ConversationSummary,
            PlanningSourceStorageKind::TranscriptRef => Self::TranscriptRef,
            PlanningSourceStorageKind::ExistingDocument => Self::ExistingDocument,
            PlanningSourceStorageKind::ResearchRun => Self::ResearchRun,
            PlanningSourceStorageKind::Memory => Self::Memory,
            PlanningSourceStorageKind::Task => Self::Task,
            PlanningSourceStorageKind::ProjectionFile => Self::ProjectionFile,
            PlanningSourceStorageKind::Other(value) => Self::Other(value.clone()),
        }
    }
}

fn status_counts(sessions: &[PlanningSessionSummary]) -> Vec<PlanningSessionStatusCount> {
    let mut counts = BTreeMap::<PlanningSessionSummaryStatus, usize>::new();
    for session in sessions {
        *counts.entry(session.status.clone()).or_default() += 1;
    }
    counts
        .into_iter()
        .map(|(status, count)| PlanningSessionStatusCount { status, count })
        .collect()
}

fn source_kind_counts<'a>(
    kinds: impl Iterator<Item = &'a PlanningSourceStorageKind>,
) -> Vec<PlanningSessionSourceKindCount> {
    let mut counts = BTreeMap::<PlanningSessionSourceKind, usize>::new();
    for kind in kinds {
        *counts
            .entry(PlanningSessionSourceKind::from(kind))
            .or_default() += 1;
    }
    counts
        .into_iter()
        .map(|(kind, count)| PlanningSessionSourceKindCount { kind, count })
        .collect()
}

#[cfg(test)]
mod tests {
    use nucleus_planning::{
        ExplorationPromotionStorageRefs, ExplorationSessionStorageRecord,
        ExplorationSessionStorageStatus, ExplorationStorageMode, PlanningOutputStorageRefs,
        PlanningParticipantStorageRef, PlanningParticipantStorageRole, PlanningSourceStorageRef,
    };

    use super::*;

    #[test]
    fn projection_sanitizes_source_refs_and_counts_outputs() {
        let projection = PlanningSessionsProjection::from_storage_records(
            ProjectId("project:nucleus".to_owned()),
            vec![PlanningSessionStorageRecord {
                schema_version: 1,
                session_id: "planning-session:nucleus:intake".to_owned(),
                project_id: "project:nucleus".to_owned(),
                kind: PlanningSessionStorageKind::ProjectIntake,
                status: PlanningSessionStorageStatus::Active,
                prompt_or_template_refs: vec!["template:intake".to_owned()],
                participants: vec![PlanningParticipantStorageRef {
                    actor_ref: "user:tom".to_owned(),
                    role: PlanningParticipantStorageRole::Human,
                }],
                source_refs: vec![PlanningSourceStorageRef {
                    source_ref: "transcript:private".to_owned(),
                    kind: PlanningSourceStorageKind::TranscriptRef,
                }],
                output_refs: PlanningOutputStorageRefs {
                    artifact_refs: vec!["artifact:vision".to_owned()],
                    task_seed_refs: vec!["seed:next".to_owned()],
                    memory_proposal_refs: Vec::new(),
                    research_run_brief_refs: Vec::new(),
                },
            }],
            vec![ExplorationSessionStorageRecord {
                schema_version: 1,
                session_id: "exploration:nucleus:planning".to_owned(),
                project_id: Some("project:nucleus".to_owned()),
                title: "Planning".to_owned(),
                scope_prompt: "Explore planning.".to_owned(),
                mode: ExplorationStorageMode::OpenEnded,
                status: ExplorationSessionStorageStatus::Active,
                participants: Vec::new(),
                source_conversation_refs: Vec::new(),
                questions: Vec::new(),
                assumptions: Vec::new(),
                options: Vec::new(),
                notes: Vec::new(),
                promotion_refs: ExplorationPromotionStorageRefs::default(),
            }],
        );

        assert_eq!(projection.sessions.len(), 1);
        assert_eq!(projection.source_counts.planning_session_records, 1);
        assert_eq!(projection.source_counts.exploration_session_records, 1);
        assert_eq!(projection.source_counts.output_refs, 2);
        assert_eq!(projection.sessions[0].source_kind_counts[0].count, 1);
        assert!(!projection.client_can_mutate);
        assert!(!projection.provider_execution_available);
    }
}
