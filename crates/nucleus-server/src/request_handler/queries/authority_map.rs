use crate::client_protocol::ProjectAuthorityMapPublicationRecord;
use crate::control_api::{ProjectAuthorityMapQuery, ServerControlError, ServerQueryResult};

pub(super) fn project_authority_map_query(
    query: ProjectAuthorityMapQuery,
) -> Result<ServerQueryResult, ServerControlError> {
    Ok(ServerQueryResult::ProjectAuthorityMap(
        ProjectAuthorityMapPublicationRecord::deferred(
            query.project_id,
            "authority-map persistence is not implemented",
        ),
    ))
}
