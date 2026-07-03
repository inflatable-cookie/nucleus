//! Sanitized research run brief read model.

use std::collections::BTreeMap;

use nucleus_projects::ProjectId;
use nucleus_research::{
    ResearchObservationStorageKind, ResearchRunBriefStorageRecord, ResearchRunBriefStorageStatus,
    ResearchSourceStorageKind, ResearchSynthesisStorageKind,
};

/// Read-only project-scoped research run brief projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchRunBriefsProjection {
    pub project_id: ProjectId,
    pub runs: Vec<ResearchRunBriefSummary>,
    pub status_counts: Vec<ResearchRunBriefStatusCount>,
    pub source_kind_counts: Vec<ResearchSourceKindCount>,
    pub observation_kind_counts: Vec<ResearchObservationKindCount>,
    pub synthesis_kind_counts: Vec<ResearchSynthesisKindCount>,
    pub source_counts: ResearchRunBriefSourceCounts,
    pub client_can_mutate: bool,
    pub provider_execution_available: bool,
}

/// Sanitized research run brief summary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchRunBriefSummary {
    pub run_id: String,
    pub status: ResearchRunBriefSummaryStatus,
    pub source_plan_ref_count: usize,
    pub question_count: usize,
    pub source_ref_count: usize,
    pub observation_ref_count: usize,
    pub synthesis_ref_count: usize,
    pub promotion_target_ref_count: usize,
    pub coverage_ref_count: usize,
    pub gap_ref_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchRunBriefSourceCounts {
    pub run_records: usize,
    pub source_plan_refs: usize,
    pub questions: usize,
    pub source_refs: usize,
    pub observation_refs: usize,
    pub synthesis_refs: usize,
    pub promotion_target_refs: usize,
    pub coverage_refs: usize,
    pub gap_refs: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchRunBriefStatusCount {
    pub status: ResearchRunBriefSummaryStatus,
    pub count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchSourceKindCount {
    pub kind: ResearchSourceKindSummary,
    pub count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchObservationKindCount {
    pub kind: ResearchObservationKindSummary,
    pub count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchSynthesisKindCount {
    pub kind: ResearchSynthesisKindSummary,
    pub count: usize,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ResearchRunBriefSummaryStatus {
    Proposed,
    Active,
    Paused,
    Blocked,
    Synthesized,
    Accepted,
    Superseded,
    Archived,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ResearchSourceKindSummary {
    WebPage,
    OfficialDocs,
    SourceRepository,
    CodeFile,
    IssueOrDiscussion,
    Paper,
    Pdf,
    PackageRegistry,
    LocalFile,
    HumanNote,
    ModelGeneratedLead,
    Custom(String),
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ResearchObservationKindSummary {
    Evidence,
    Inference,
    Speculation,
    Recommendation,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ResearchSynthesisKindSummary {
    Answer,
    Recommendation,
    DecisionSupport,
    PlanningInput,
    TaskSeedGroup,
    Custom(String),
}

impl ResearchRunBriefsProjection {
    pub fn from_storage_records(
        project_id: ProjectId,
        records: Vec<ResearchRunBriefStorageRecord>,
    ) -> Self {
        let records: Vec<_> = records
            .into_iter()
            .filter(|record| record.project_id.as_deref() == Some(project_id.0.as_str()))
            .collect();
        let runs: Vec<_> = records.iter().map(ResearchRunBriefSummary::from).collect();

        Self {
            project_id,
            status_counts: status_counts(&runs),
            source_kind_counts: source_kind_counts(&records),
            observation_kind_counts: observation_kind_counts(&records),
            synthesis_kind_counts: synthesis_kind_counts(&records),
            source_counts: ResearchRunBriefSourceCounts::from_summaries(&runs),
            runs,
            client_can_mutate: false,
            provider_execution_available: false,
        }
    }
}

impl From<&ResearchRunBriefStorageRecord> for ResearchRunBriefSummary {
    fn from(record: &ResearchRunBriefStorageRecord) -> Self {
        Self {
            run_id: record.run_id.clone(),
            status: ResearchRunBriefSummaryStatus::from(&record.status),
            source_plan_ref_count: record.source_plan_refs.len(),
            question_count: record.questions.len(),
            source_ref_count: record.source_refs.len(),
            observation_ref_count: record.observation_refs.len(),
            synthesis_ref_count: record.synthesis_refs.len(),
            promotion_target_ref_count: record
                .synthesis_refs
                .iter()
                .map(|synthesis| {
                    synthesis.promotion_targets.memory_proposal_refs.len()
                        + synthesis.promotion_targets.planning_artifact_refs.len()
                        + synthesis.promotion_targets.task_seed_refs.len()
                        + synthesis.promotion_targets.source_evidence_refs.len()
                })
                .sum(),
            coverage_ref_count: record.coverage.covered_refs.len(),
            gap_ref_count: record.coverage.gap_refs.len()
                + record
                    .questions
                    .iter()
                    .map(|question| question.open_gap_refs.len())
                    .sum::<usize>()
                + record
                    .synthesis_refs
                    .iter()
                    .map(|synthesis| synthesis.gap_refs.len())
                    .sum::<usize>(),
        }
    }
}

impl ResearchRunBriefSourceCounts {
    fn from_summaries(summaries: &[ResearchRunBriefSummary]) -> Self {
        Self {
            run_records: summaries.len(),
            source_plan_refs: summaries
                .iter()
                .map(|summary| summary.source_plan_ref_count)
                .sum(),
            questions: summaries.iter().map(|summary| summary.question_count).sum(),
            source_refs: summaries
                .iter()
                .map(|summary| summary.source_ref_count)
                .sum(),
            observation_refs: summaries
                .iter()
                .map(|summary| summary.observation_ref_count)
                .sum(),
            synthesis_refs: summaries
                .iter()
                .map(|summary| summary.synthesis_ref_count)
                .sum(),
            promotion_target_refs: summaries
                .iter()
                .map(|summary| summary.promotion_target_ref_count)
                .sum(),
            coverage_refs: summaries
                .iter()
                .map(|summary| summary.coverage_ref_count)
                .sum(),
            gap_refs: summaries.iter().map(|summary| summary.gap_ref_count).sum(),
        }
    }
}

impl From<&ResearchRunBriefStorageStatus> for ResearchRunBriefSummaryStatus {
    fn from(status: &ResearchRunBriefStorageStatus) -> Self {
        match status {
            ResearchRunBriefStorageStatus::Proposed => Self::Proposed,
            ResearchRunBriefStorageStatus::Active => Self::Active,
            ResearchRunBriefStorageStatus::Paused => Self::Paused,
            ResearchRunBriefStorageStatus::Blocked => Self::Blocked,
            ResearchRunBriefStorageStatus::Synthesized => Self::Synthesized,
            ResearchRunBriefStorageStatus::Accepted => Self::Accepted,
            ResearchRunBriefStorageStatus::Superseded => Self::Superseded,
            ResearchRunBriefStorageStatus::Archived => Self::Archived,
        }
    }
}

impl From<&ResearchSourceStorageKind> for ResearchSourceKindSummary {
    fn from(kind: &ResearchSourceStorageKind) -> Self {
        match kind {
            ResearchSourceStorageKind::WebPage => Self::WebPage,
            ResearchSourceStorageKind::OfficialDocs => Self::OfficialDocs,
            ResearchSourceStorageKind::SourceRepository => Self::SourceRepository,
            ResearchSourceStorageKind::CodeFile => Self::CodeFile,
            ResearchSourceStorageKind::IssueOrDiscussion => Self::IssueOrDiscussion,
            ResearchSourceStorageKind::Paper => Self::Paper,
            ResearchSourceStorageKind::Pdf => Self::Pdf,
            ResearchSourceStorageKind::PackageRegistry => Self::PackageRegistry,
            ResearchSourceStorageKind::LocalFile => Self::LocalFile,
            ResearchSourceStorageKind::HumanNote => Self::HumanNote,
            ResearchSourceStorageKind::ModelGeneratedLead => Self::ModelGeneratedLead,
            ResearchSourceStorageKind::Custom(value) => Self::Custom(value.clone()),
        }
    }
}

impl From<&ResearchObservationStorageKind> for ResearchObservationKindSummary {
    fn from(kind: &ResearchObservationStorageKind) -> Self {
        match kind {
            ResearchObservationStorageKind::Evidence => Self::Evidence,
            ResearchObservationStorageKind::Inference => Self::Inference,
            ResearchObservationStorageKind::Speculation => Self::Speculation,
            ResearchObservationStorageKind::Recommendation => Self::Recommendation,
        }
    }
}

impl From<&ResearchSynthesisStorageKind> for ResearchSynthesisKindSummary {
    fn from(kind: &ResearchSynthesisStorageKind) -> Self {
        match kind {
            ResearchSynthesisStorageKind::Answer => Self::Answer,
            ResearchSynthesisStorageKind::Recommendation => Self::Recommendation,
            ResearchSynthesisStorageKind::DecisionSupport => Self::DecisionSupport,
            ResearchSynthesisStorageKind::PlanningInput => Self::PlanningInput,
            ResearchSynthesisStorageKind::TaskSeedGroup => Self::TaskSeedGroup,
            ResearchSynthesisStorageKind::Custom(value) => Self::Custom(value.clone()),
        }
    }
}

fn status_counts(summaries: &[ResearchRunBriefSummary]) -> Vec<ResearchRunBriefStatusCount> {
    let mut counts = BTreeMap::<ResearchRunBriefSummaryStatus, usize>::new();
    for summary in summaries {
        *counts.entry(summary.status).or_default() += 1;
    }
    counts
        .into_iter()
        .map(|(status, count)| ResearchRunBriefStatusCount { status, count })
        .collect()
}

fn source_kind_counts(records: &[ResearchRunBriefStorageRecord]) -> Vec<ResearchSourceKindCount> {
    let mut counts = BTreeMap::<ResearchSourceKindSummary, usize>::new();
    for kind in records
        .iter()
        .flat_map(|record| record.source_refs.iter().map(|source| &source.kind))
    {
        *counts
            .entry(ResearchSourceKindSummary::from(kind))
            .or_default() += 1;
    }
    counts
        .into_iter()
        .map(|(kind, count)| ResearchSourceKindCount { kind, count })
        .collect()
}

fn observation_kind_counts(
    records: &[ResearchRunBriefStorageRecord],
) -> Vec<ResearchObservationKindCount> {
    let mut counts = BTreeMap::<ResearchObservationKindSummary, usize>::new();
    for kind in records.iter().flat_map(|record| {
        record
            .observation_refs
            .iter()
            .map(|observation| &observation.kind)
    }) {
        *counts
            .entry(ResearchObservationKindSummary::from(kind))
            .or_default() += 1;
    }
    counts
        .into_iter()
        .map(|(kind, count)| ResearchObservationKindCount { kind, count })
        .collect()
}

fn synthesis_kind_counts(
    records: &[ResearchRunBriefStorageRecord],
) -> Vec<ResearchSynthesisKindCount> {
    let mut counts = BTreeMap::<ResearchSynthesisKindSummary, usize>::new();
    for kind in records.iter().flat_map(|record| {
        record
            .synthesis_refs
            .iter()
            .map(|synthesis| &synthesis.kind)
    }) {
        *counts
            .entry(ResearchSynthesisKindSummary::from(kind))
            .or_default() += 1;
    }
    counts
        .into_iter()
        .map(|(kind, count)| ResearchSynthesisKindCount { kind, count })
        .collect()
}

#[cfg(test)]
mod tests;
