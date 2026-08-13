use super::body::ControlResponseBodyDto;
use super::records::{
    ControlOrchestrationRunStateCountDto, ControlOrchestrationRunSummaryDto,
};
use nucleus_engine::EngineRunFleetProjection;

pub(super) fn orchestration_runs_body_dto(
    projection: &EngineRunFleetProjection,
) -> ControlResponseBodyDto {
    ControlResponseBodyDto::OrchestrationRuns {
        project_id: projection.project_id.0.clone(),
        runs: projection
            .runs
            .iter()
            .map(ControlOrchestrationRunSummaryDto::from)
            .collect(),
        state_counts: projection
            .state_counts
            .iter()
            .map(ControlOrchestrationRunStateCountDto::from)
            .collect(),
        client_can_mutate: false,
    }
}
