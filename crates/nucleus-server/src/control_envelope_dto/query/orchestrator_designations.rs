use nucleus_projects::ProjectId;

use super::ControlQueryDto;
use crate::control_api::{OrchestratorDesignationsQuery, ServerQueryKind};
use crate::control_envelope_dto::ControlApiCodecError;

pub(super) fn orchestrator_designations_query_from_action(
    action: &str,
    project_id: String,
    provider_instance: Option<String>,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "list" => Ok(ServerQueryKind::OrchestratorDesignations(
            OrchestratorDesignationsQuery {
                project_id: ProjectId(project_id),
                provider_instance: provider_instance.filter(|id| !id.trim().is_empty()),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "orchestrator designations query action is not supported: {action}"
        ))),
    }
}

impl TryFrom<&ControlQueryDto> for OrchestratorDesignationsQuery {
    type Error = ControlApiCodecError;

    fn try_from(query: &ControlQueryDto) -> Result<Self, Self::Error> {
        match query {
            ControlQueryDto::OrchestratorDesignations {
                project_id,
                provider_instance,
                ..
            } => Ok(OrchestratorDesignationsQuery {
                project_id: ProjectId(project_id.clone()),
                provider_instance: provider_instance.clone(),
            }),
            _ => Err(ControlApiCodecError::unsupported(
                "query shape is not an orchestrator designations query",
            )),
        }
    }
}
