use super::body::ControlResponseBodyDto;
use super::records::{
    ControlPlanningSessionSourceCountsDto, ControlPlanningSessionStatusCountDto,
    ControlPlanningSessionSummaryDto,
};
use crate::planning_sessions_projection::PlanningSessionsProjection;

pub(super) fn planning_sessions_body_dto(
    projection: &PlanningSessionsProjection,
) -> ControlResponseBodyDto {
    ControlResponseBodyDto::PlanningSessions {
        project_id: projection.project_id.0.clone(),
        sessions: projection
            .sessions
            .iter()
            .map(ControlPlanningSessionSummaryDto::from)
            .collect(),
        status_counts: projection
            .status_counts
            .iter()
            .map(ControlPlanningSessionStatusCountDto::from)
            .collect(),
        source_counts: ControlPlanningSessionSourceCountsDto::from(&projection.source_counts),
        client_can_mutate: projection.client_can_mutate,
        provider_execution_available: projection.provider_execution_available,
    }
}
