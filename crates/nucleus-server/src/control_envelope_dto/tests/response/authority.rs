use crate::client_protocol::{
    ProjectAuthorityDomainPublication, ProjectAuthorityMapPublicationRecord,
    ProjectAuthorityPublicationState, ProjectAuthorityValidationIssue,
};
use crate::control_api::{
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult,
};
use crate::control_envelope_dto::*;
use crate::host_authority::ProjectAuthorityDomain;
use crate::ids::ServerControlRequestId;
use crate::EngineHostId;
use nucleus_projects::ProjectId;

#[test]
fn response_envelope_dto_serializes_project_authority_map() {
    let record = ProjectAuthorityMapPublicationRecord {
        project_id: ProjectId("project:authority".to_owned()),
        domains: vec![
            ProjectAuthorityDomainPublication {
                domain: ProjectAuthorityDomain::Execution,
                state: ProjectAuthorityPublicationState::Assigned {
                    authoritative_host_id: EngineHostId("host:remote-worker".to_owned()),
                    fallback_host_ids: vec![EngineHostId("host:local".to_owned())],
                    mutation_allowed: true,
                },
                note: Some("remote execution host".to_owned()),
            },
            ProjectAuthorityDomainPublication {
                domain: ProjectAuthorityDomain::Projection,
                state: ProjectAuthorityPublicationState::MutationDenied {
                    authoritative_host_id: EngineHostId("host:local".to_owned()),
                    fallback_host_ids: Vec::new(),
                },
                note: None,
            },
        ],
        issues: vec![ProjectAuthorityValidationIssue::DomainUnassigned {
            domain: ProjectAuthorityDomain::Task,
        }],
    };
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:authority-map".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::ProjectAuthorityMap(record)),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlResponseEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");

    assert!(matches!(
        decoded.body,
        ControlResponseBodyDto::ProjectAuthorityMap { record }
            if record.project_id == "project:authority"
                && record.domains.len() == 2
                && record.domains[0].domain == "execution"
                && record.domains[0].state == "assigned"
                && record.domains[0].authoritative_host_id.as_deref()
                    == Some("host:remote-worker")
                && record.domains[1].state == "mutation_denied"
                && record.issues.len() == 1
    ));
}
