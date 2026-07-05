use super::body::ControlResponseBodyDto;
use super::records::ControlAcceptedMemoryReviewReadinessDto;
use crate::accepted_memory_review_readiness::AcceptedMemoryReviewReadiness;

pub(super) fn accepted_memory_review_readiness_body_dto(
    readiness: &AcceptedMemoryReviewReadiness,
) -> ControlResponseBodyDto {
    ControlResponseBodyDto::AcceptedMemoryReviewReadiness {
        readiness: ControlAcceptedMemoryReviewReadinessDto::from(readiness),
    }
}
