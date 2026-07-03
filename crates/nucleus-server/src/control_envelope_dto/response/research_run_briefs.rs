use super::body::ControlResponseBodyDto;
use super::records::{
    ControlResearchObservationKindCountDto, ControlResearchRunBriefSourceCountsDto,
    ControlResearchRunBriefStatusCountDto, ControlResearchRunBriefSummaryDto,
    ControlResearchSourceKindCountDto, ControlResearchSynthesisKindCountDto,
};
use crate::research_run_briefs_projection::ResearchRunBriefsProjection;

pub(super) fn research_run_briefs_body_dto(
    projection: &ResearchRunBriefsProjection,
) -> ControlResponseBodyDto {
    ControlResponseBodyDto::ResearchRunBriefs {
        project_id: projection.project_id.0.clone(),
        runs: projection
            .runs
            .iter()
            .map(ControlResearchRunBriefSummaryDto::from)
            .collect(),
        status_counts: projection
            .status_counts
            .iter()
            .map(ControlResearchRunBriefStatusCountDto::from)
            .collect(),
        source_kind_counts: projection
            .source_kind_counts
            .iter()
            .map(ControlResearchSourceKindCountDto::from)
            .collect(),
        observation_kind_counts: projection
            .observation_kind_counts
            .iter()
            .map(ControlResearchObservationKindCountDto::from)
            .collect(),
        synthesis_kind_counts: projection
            .synthesis_kind_counts
            .iter()
            .map(ControlResearchSynthesisKindCountDto::from)
            .collect(),
        source_counts: ControlResearchRunBriefSourceCountsDto::from(&projection.source_counts),
        client_can_mutate: projection.client_can_mutate,
        provider_execution_available: projection.provider_execution_available,
    }
}
