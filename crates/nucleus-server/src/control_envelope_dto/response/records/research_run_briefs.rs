use serde::{Deserialize, Serialize};

use crate::research_run_briefs_projection::{
    ResearchObservationKindCount, ResearchObservationKindSummary, ResearchRunBriefSourceCounts,
    ResearchRunBriefStatusCount, ResearchRunBriefSummary, ResearchRunBriefSummaryStatus,
    ResearchSourceKindCount, ResearchSourceKindSummary, ResearchSynthesisKindCount,
    ResearchSynthesisKindSummary,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlResearchRunBriefSummaryDto {
    pub run_id: String,
    pub status: String,
    #[ts(as = "u32")]
    pub source_plan_ref_count: usize,
    #[ts(as = "u32")]
    pub question_count: usize,
    #[ts(as = "u32")]
    pub source_ref_count: usize,
    #[ts(as = "u32")]
    pub observation_ref_count: usize,
    #[ts(as = "u32")]
    pub synthesis_ref_count: usize,
    #[ts(as = "u32")]
    pub promotion_target_ref_count: usize,
    #[ts(as = "u32")]
    pub coverage_ref_count: usize,
    #[ts(as = "u32")]
    pub gap_ref_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlResearchRunBriefStatusCountDto {
    pub status: String,
    #[ts(as = "u32")]
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlResearchSourceKindCountDto {
    pub kind: String,
    #[ts(as = "u32")]
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlResearchObservationKindCountDto {
    pub kind: String,
    #[ts(as = "u32")]
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlResearchSynthesisKindCountDto {
    pub kind: String,
    #[ts(as = "u32")]
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlResearchRunBriefSourceCountsDto {
    #[ts(as = "u32")]
    pub run_records: usize,
    #[ts(as = "u32")]
    pub source_plan_refs: usize,
    #[ts(as = "u32")]
    pub questions: usize,
    #[ts(as = "u32")]
    pub source_refs: usize,
    #[ts(as = "u32")]
    pub observation_refs: usize,
    #[ts(as = "u32")]
    pub synthesis_refs: usize,
    #[ts(as = "u32")]
    pub promotion_target_refs: usize,
    #[ts(as = "u32")]
    pub coverage_refs: usize,
    #[ts(as = "u32")]
    pub gap_refs: usize,
}

impl From<&ResearchRunBriefSummary> for ControlResearchRunBriefSummaryDto {
    fn from(summary: &ResearchRunBriefSummary) -> Self {
        Self {
            run_id: summary.run_id.clone(),
            status: status_dto(&summary.status),
            source_plan_ref_count: summary.source_plan_ref_count,
            question_count: summary.question_count,
            source_ref_count: summary.source_ref_count,
            observation_ref_count: summary.observation_ref_count,
            synthesis_ref_count: summary.synthesis_ref_count,
            promotion_target_ref_count: summary.promotion_target_ref_count,
            coverage_ref_count: summary.coverage_ref_count,
            gap_ref_count: summary.gap_ref_count,
        }
    }
}

impl From<&ResearchRunBriefStatusCount> for ControlResearchRunBriefStatusCountDto {
    fn from(count: &ResearchRunBriefStatusCount) -> Self {
        Self {
            status: status_dto(&count.status),
            count: count.count,
        }
    }
}

impl From<&ResearchSourceKindCount> for ControlResearchSourceKindCountDto {
    fn from(count: &ResearchSourceKindCount) -> Self {
        Self {
            kind: source_kind_dto(&count.kind),
            count: count.count,
        }
    }
}

impl From<&ResearchObservationKindCount> for ControlResearchObservationKindCountDto {
    fn from(count: &ResearchObservationKindCount) -> Self {
        Self {
            kind: observation_kind_dto(&count.kind),
            count: count.count,
        }
    }
}

impl From<&ResearchSynthesisKindCount> for ControlResearchSynthesisKindCountDto {
    fn from(count: &ResearchSynthesisKindCount) -> Self {
        Self {
            kind: synthesis_kind_dto(&count.kind),
            count: count.count,
        }
    }
}

impl From<&ResearchRunBriefSourceCounts> for ControlResearchRunBriefSourceCountsDto {
    fn from(counts: &ResearchRunBriefSourceCounts) -> Self {
        Self {
            run_records: counts.run_records,
            source_plan_refs: counts.source_plan_refs,
            questions: counts.questions,
            source_refs: counts.source_refs,
            observation_refs: counts.observation_refs,
            synthesis_refs: counts.synthesis_refs,
            promotion_target_refs: counts.promotion_target_refs,
            coverage_refs: counts.coverage_refs,
            gap_refs: counts.gap_refs,
        }
    }
}

fn status_dto(status: &ResearchRunBriefSummaryStatus) -> String {
    match status {
        ResearchRunBriefSummaryStatus::Proposed => "proposed",
        ResearchRunBriefSummaryStatus::Active => "active",
        ResearchRunBriefSummaryStatus::Paused => "paused",
        ResearchRunBriefSummaryStatus::Blocked => "blocked",
        ResearchRunBriefSummaryStatus::Synthesized => "synthesized",
        ResearchRunBriefSummaryStatus::Accepted => "accepted",
        ResearchRunBriefSummaryStatus::Superseded => "superseded",
        ResearchRunBriefSummaryStatus::Archived => "archived",
    }
    .to_owned()
}

fn source_kind_dto(kind: &ResearchSourceKindSummary) -> String {
    match kind {
        ResearchSourceKindSummary::WebPage => "web_page",
        ResearchSourceKindSummary::OfficialDocs => "official_docs",
        ResearchSourceKindSummary::SourceRepository => "source_repository",
        ResearchSourceKindSummary::CodeFile => "code_file",
        ResearchSourceKindSummary::IssueOrDiscussion => "issue_or_discussion",
        ResearchSourceKindSummary::Paper => "paper",
        ResearchSourceKindSummary::Pdf => "pdf",
        ResearchSourceKindSummary::PackageRegistry => "package_registry",
        ResearchSourceKindSummary::LocalFile => "local_file",
        ResearchSourceKindSummary::HumanNote => "human_note",
        ResearchSourceKindSummary::ModelGeneratedLead => "model_generated_lead",
        ResearchSourceKindSummary::Custom(value) => value,
    }
    .to_owned()
}

fn observation_kind_dto(kind: &ResearchObservationKindSummary) -> String {
    match kind {
        ResearchObservationKindSummary::Evidence => "evidence",
        ResearchObservationKindSummary::Inference => "inference",
        ResearchObservationKindSummary::Speculation => "speculation",
        ResearchObservationKindSummary::Recommendation => "recommendation",
    }
    .to_owned()
}

fn synthesis_kind_dto(kind: &ResearchSynthesisKindSummary) -> String {
    match kind {
        ResearchSynthesisKindSummary::Answer => "answer",
        ResearchSynthesisKindSummary::Recommendation => "recommendation",
        ResearchSynthesisKindSummary::DecisionSupport => "decision_support",
        ResearchSynthesisKindSummary::PlanningInput => "planning_input",
        ResearchSynthesisKindSummary::TaskSeedGroup => "task_seed_group",
        ResearchSynthesisKindSummary::Custom(value) => value,
    }
    .to_owned()
}
