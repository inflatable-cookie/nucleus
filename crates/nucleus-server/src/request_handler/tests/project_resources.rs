//! Project resource command tests, split from the project_resources god
//! file; behavior unchanged.

use super::*;

use crate::commands::{
    ProjectCommand, ProjectCreateCommand, ProjectResourceAction, ProjectResourceCommand,
};
use nucleus_core::PersistenceRecordId;

mod attachments_tests;
mod management_tests;

pub(super) fn create_request(idempotency_key: &str, display_name: &str) -> ServerControlRequest {
    ServerControlRequest {
        id: ServerControlRequestId(format!("request:{idempotency_key}")),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId(format!("command:{idempotency_key}")),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Project(ProjectCommand::Create(ProjectCreateCommand {
                display_name: display_name.to_owned(),
                transient: false,
                actor_ref: "operator:test".to_owned(),
                authority_host_ref: "host:embedded-desktop".to_owned(),
                idempotency_key: idempotency_key.to_owned(),
            })),
        }),
    }
}

pub(super) fn resource_request(
    command_id: &str,
    record: &nucleus_local_store::LocalStoreRecord,
    action: ProjectResourceAction,
) -> ServerControlRequest {
    command_request(command_id, resource_command(record, action, command_id))
}

pub(super) fn resource_command(
    record: &nucleus_local_store::LocalStoreRecord,
    action: ProjectResourceAction,
    idempotency_key: &str,
) -> ProjectResourceCommand {
    ProjectResourceCommand {
        project_id: ProjectId(record.id.0.clone()),
        expected_revision: record.revision_id.clone(),
        actor_ref: "operator:test".to_owned(),
        authority_host_ref: "host:embedded-desktop".to_owned(),
        idempotency_key: idempotency_key.to_owned(),
        action,
    }
}

pub(super) fn command_request(
    command_id: &str,
    command: ProjectResourceCommand,
) -> ServerControlRequest {
    ServerControlRequest {
        id: ServerControlRequestId(format!("request:{command_id}")),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId(format!("command:{command_id}")),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Project(ProjectCommand::Resource(command)),
        }),
    }
}

pub(super) fn project_record(
    handler: &LocalControlRequestHandler<SqliteBackend>,
) -> nucleus_local_store::LocalStoreRecord {
    handler
        .state()
        .projects()
        .list()
        .expect("list")
        .into_iter()
        .find(|record| record.kind == PersistenceRecordKind::Project)
        .expect("project")
}

pub(super) fn stored_project_record(
    handler: &LocalControlRequestHandler<SqliteBackend>,
    id: &PersistenceRecordId,
) -> nucleus_local_store::LocalStoreRecord {
    handler
        .state()
        .projects()
        .get(id)
        .expect("get project")
        .expect("project")
}

pub(super) fn assert_accepted(response: crate::control_api::ServerControlResponse) {
    assert_eq!(response.status, ServerControlResponseStatus::Accepted);
}

pub(super) fn assert_rejected_kind(response: crate::control_api::ServerControlResponse, kind: &str) {
    assert_eq!(response.status, ServerControlResponseStatus::Rejected);
    assert!(format!("{response:?}").to_lowercase().contains(kind));
}
