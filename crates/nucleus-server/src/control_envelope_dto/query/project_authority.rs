use nucleus_projects::ProjectId;

use crate::control_api::{ProjectAuthorityMapQuery, ServerQueryKind};

use super::authority_domains::authority_domain_from_dto;
use super::ControlApiCodecError;

pub(super) fn project_authority_map_query_from_action(
    action: &str,
    project_id: String,
    expected_domains: Vec<String>,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "publication" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "project authority-map query requires a project id",
        )),
        "publication" => Ok(ServerQueryKind::ProjectAuthorityMap(
            ProjectAuthorityMapQuery {
                project_id: ProjectId(project_id),
                expected_domains: expected_domains
                    .into_iter()
                    .map(authority_domain_from_dto)
                    .collect::<Result<Vec<_>, _>>()?,
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported project authority-map query action: {action}"
        ))),
    }
}
