use nucleus_projects::ProjectId;

use super::ControlQueryDto;
use crate::control_api::{OrchestrationRunsQuery, ServerQueryKind};
use crate::control_envelope_dto::ControlApiCodecError;

pub(super) fn orchestration_runs_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "fleet" => Ok(ServerQueryKind::OrchestrationRuns(OrchestrationRunsQuery {
            project_id: ProjectId(project_id),
        })),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "orchestration runs query action is not supported: {action}"
        ))),
    }
}

impl TryFrom<&ControlQueryDto> for OrchestrationRunsQuery {
    type Error = ControlApiCodecError;

    fn try_from(query: &ControlQueryDto) -> Result<Self, Self::Error> {
        match query {
            ControlQueryDto::OrchestrationRuns { project_id, .. } => {
                Ok(OrchestrationRunsQuery {
                    project_id: ProjectId(project_id.clone()),
                })
            }
            _ => Err(ControlApiCodecError::unsupported(
                "query shape is not an orchestration runs query",
            )),
        }
    }
}
