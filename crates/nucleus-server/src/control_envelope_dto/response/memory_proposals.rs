use super::body::ControlResponseBodyDto;
use super::records::{
    ControlMemoryProposalRetentionCountDto, ControlMemoryProposalScopeCountDto,
    ControlMemoryProposalSensitivityCountDto, ControlMemoryProposalSourceCountsDto,
    ControlMemoryProposalStatusCountDto, ControlMemoryProposalSummaryDto,
};
use crate::memory_proposals_projection::MemoryProposalsProjection;

pub(super) fn memory_proposals_body_dto(
    projection: &MemoryProposalsProjection,
) -> ControlResponseBodyDto {
    ControlResponseBodyDto::MemoryProposals {
        project_id: projection.project_id.0.clone(),
        proposals: projection
            .proposals
            .iter()
            .map(ControlMemoryProposalSummaryDto::from)
            .collect(),
        status_counts: projection
            .status_counts
            .iter()
            .map(ControlMemoryProposalStatusCountDto::from)
            .collect(),
        scope_counts: projection
            .scope_counts
            .iter()
            .map(ControlMemoryProposalScopeCountDto::from)
            .collect(),
        sensitivity_counts: projection
            .sensitivity_counts
            .iter()
            .map(ControlMemoryProposalSensitivityCountDto::from)
            .collect(),
        retention_counts: projection
            .retention_counts
            .iter()
            .map(ControlMemoryProposalRetentionCountDto::from)
            .collect(),
        source_counts: ControlMemoryProposalSourceCountsDto::from(&projection.source_counts),
        client_can_mutate: projection.client_can_mutate,
        provider_execution_available: projection.provider_execution_available,
    }
}
