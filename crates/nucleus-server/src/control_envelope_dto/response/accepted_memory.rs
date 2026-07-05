use super::body::ControlResponseBodyDto;
use super::records::{
    ControlAcceptedMemoryConfidenceCountDto, ControlAcceptedMemoryKindCountDto,
    ControlAcceptedMemoryRetentionCountDto, ControlAcceptedMemoryScopeCountDto,
    ControlAcceptedMemorySensitivityCountDto, ControlAcceptedMemorySourceCountsDto,
    ControlAcceptedMemoryStatusCountDto, ControlAcceptedMemorySummaryDto,
};
use crate::accepted_memory_projection::AcceptedMemoryProjection;

pub(super) fn accepted_memory_body_dto(
    projection: &AcceptedMemoryProjection,
) -> ControlResponseBodyDto {
    ControlResponseBodyDto::AcceptedMemory {
        project_id: projection.project_id.0.clone(),
        memories: projection
            .memories
            .iter()
            .map(ControlAcceptedMemorySummaryDto::from)
            .collect(),
        status_counts: projection
            .status_counts
            .iter()
            .map(ControlAcceptedMemoryStatusCountDto::from)
            .collect(),
        scope_counts: projection
            .scope_counts
            .iter()
            .map(ControlAcceptedMemoryScopeCountDto::from)
            .collect(),
        kind_counts: projection
            .kind_counts
            .iter()
            .map(ControlAcceptedMemoryKindCountDto::from)
            .collect(),
        sensitivity_counts: projection
            .sensitivity_counts
            .iter()
            .map(ControlAcceptedMemorySensitivityCountDto::from)
            .collect(),
        retention_counts: projection
            .retention_counts
            .iter()
            .map(ControlAcceptedMemoryRetentionCountDto::from)
            .collect(),
        confidence_counts: projection
            .confidence_counts
            .iter()
            .map(ControlAcceptedMemoryConfidenceCountDto::from)
            .collect(),
        source_counts: ControlAcceptedMemorySourceCountsDto::from(&projection.source_counts),
        client_can_mutate: projection.client_can_mutate,
        projection_written: projection.projection_written,
        embedding_available: projection.embedding_available,
        provider_sync_available: projection.provider_sync_available,
    }
}
