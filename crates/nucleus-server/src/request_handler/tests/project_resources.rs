use super::*;
use crate::commands::{
    ProjectCommand, ProjectCreateCommand, ProjectResourceAction, ProjectResourceCommand,
};
use nucleus_core::PersistenceRecordId;
use nucleus_projects::{
    decode_project_storage_record, ProjectResourceId, ProjectResourceRole,
    ProjectResourceStorageKind, ProjectResourceStorageRole,
};

#[test]
fn resource_commands_attach_detect_update_repair_and_remove_without_touching_files() {
    let (temp_dir, mut handler) = handler(None);
    assert_eq!(
        handler
            .handle(create_request("resource-project", "Resource Project"))
            .status,
        ServerControlResponseStatus::Accepted
    );
    let mut project_record = project_record(&handler);

    let folder = temp_dir.path().join("plain-folder");
    std::fs::create_dir(&folder).expect("plain folder");
    let attach_folder = resource_request(
        "attach-folder",
        &project_record,
        ProjectResourceAction::Attach {
            locator: folder.clone(),
        },
    );
    assert_accepted(handler.handle(attach_folder.clone()));
    assert_accepted(handler.handle(attach_folder));
    project_record = stored_project_record(&handler, &project_record.id);
    let project = decode_project_storage_record(&project_record.payload.bytes).expect("project");
    let folder_resource = project.resources.first().expect("folder resource");
    let folder_resource_id = folder_resource.resource_id.clone();
    assert_eq!(
        folder_resource.kind,
        ProjectResourceStorageKind::FilesystemFolder
    );
    assert_eq!(
        project
            .default_working_resource
            .as_ref()
            .map(|target| target.resource_id.as_str()),
        Some(folder_resource_id.as_str())
    );

    let repository = temp_dir.path().join("repository");
    let nested = repository.join("src");
    std::fs::create_dir_all(repository.join(".git")).expect("git marker");
    std::fs::create_dir(&nested).expect("nested folder");
    assert_accepted(handler.handle(resource_request(
        "attach-repository",
        &project_record,
        ProjectResourceAction::Attach { locator: nested },
    )));
    project_record = stored_project_record(&handler, &project_record.id);
    let project = decode_project_storage_record(&project_record.payload.bytes).expect("project");
    let git_resource = project.resources.get(1).expect("git resource");
    assert_eq!(git_resource.kind, ProjectResourceStorageKind::GitRepository);
    assert_eq!(
        git_resource.current_locator.as_deref(),
        Some(
            std::fs::canonicalize(&repository)
                .expect("repository path")
                .to_string_lossy()
                .as_ref()
        )
    );

    assert_accepted(handler.handle(resource_request(
        "update-folder",
        &project_record,
        ProjectResourceAction::Update {
            resource_id: ProjectResourceId(folder_resource_id.clone()),
            display_name: Some("Reference files".to_owned()),
            role: Some(ProjectResourceRole::Reference),
            set_as_default: Some(false),
        },
    )));
    project_record = stored_project_record(&handler, &project_record.id);
    let project = decode_project_storage_record(&project_record.payload.bytes).expect("project");
    let folder_resource = project
        .resource(&folder_resource_id)
        .expect("folder resource");
    assert_eq!(folder_resource.display_name, "Reference files");
    assert_eq!(folder_resource.role, ProjectResourceStorageRole::Reference);
    assert!(project.default_working_resource.is_none());

    let moved_folder = temp_dir.path().join("moved-folder");
    std::fs::rename(&folder, &moved_folder).expect("move folder");
    assert_accepted(handler.handle(resource_request(
        "repair-folder",
        &project_record,
        ProjectResourceAction::Repair {
            resource_id: ProjectResourceId(folder_resource_id.clone()),
            locator: moved_folder.clone(),
        },
    )));
    project_record = stored_project_record(&handler, &project_record.id);
    let project = decode_project_storage_record(&project_record.payload.bytes).expect("project");
    let repaired = project
        .resource(&folder_resource_id)
        .expect("repaired resource");
    assert_eq!(repaired.resource_id, folder_resource_id);
    assert_eq!(
        repaired.current_locator.as_deref(),
        Some(
            std::fs::canonicalize(&moved_folder)
                .expect("moved path")
                .to_string_lossy()
                .as_ref()
        )
    );
    assert!(repaired.locator_history.len() >= 3);

    assert_accepted(handler.handle(resource_request(
        "remove-folder",
        &project_record,
        ProjectResourceAction::Remove {
            resource_id: ProjectResourceId(folder_resource_id),
        },
    )));
    let project_record = stored_project_record(&handler, &project_record.id);
    let project = decode_project_storage_record(&project_record.payload.bytes).expect("project");
    assert_eq!(project.resources.len(), 1);
    assert!(moved_folder.is_dir());
}

#[test]
fn resource_command_requires_project_host_revision_and_actor() {
    let (temp_dir, mut handler) = handler(None);
    handler.handle(create_request("resource-authority", "Authority Project"));
    let project_record = project_record(&handler);
    let folder = temp_dir.path().join("folder");
    std::fs::create_dir(&folder).expect("folder");

    let mut wrong_host = resource_command(
        &project_record,
        ProjectResourceAction::Attach {
            locator: folder.clone(),
        },
        "wrong-host",
    );
    wrong_host.authority_host_ref = "host:remote".to_owned();
    assert_rejected_kind(
        handler.handle(command_request("wrong-host", wrong_host)),
        "unauthorized",
    );

    let mut stale = resource_command(
        &project_record,
        ProjectResourceAction::Attach {
            locator: folder.clone(),
        },
        "stale",
    );
    stale.expected_revision = RevisionId("rev:stale".to_owned());
    assert_rejected_kind(handler.handle(command_request("stale", stale)), "conflict");

    let mut missing_actor = resource_command(
        &project_record,
        ProjectResourceAction::Attach { locator: folder },
        "missing-actor",
    );
    missing_actor.actor_ref.clear();
    assert_rejected_kind(
        handler.handle(command_request("missing-actor", missing_actor)),
        "invalidrequest",
    );
}

#[test]
fn failed_movement_repair_keeps_project_and_resource_identity_intact() {
    let (temp_dir, mut handler) = handler(None);
    assert_accepted(handler.handle(create_request("repair-project", "Repair Project")));
    let mut project_record = project_record(&handler);
    let original = temp_dir.path().join("original-folder");
    std::fs::create_dir(&original).expect("original folder");
    assert_accepted(handler.handle(resource_request(
        "attach-original",
        &project_record,
        ProjectResourceAction::Attach {
            locator: original.clone(),
        },
    )));
    project_record = stored_project_record(&handler, &project_record.id);
    let before = decode_project_storage_record(&project_record.payload.bytes).expect("project");
    let resource_id = before.resources[0].resource_id.clone();
    let replacement = temp_dir.path().join("replacement-repository");
    std::fs::create_dir_all(replacement.join(".git")).expect("replacement repository");
    std::fs::remove_dir(&original).expect("move original away");

    assert_rejected_kind(
        handler.handle(resource_request(
            "repair-with-wrong-kind",
            &project_record,
            ProjectResourceAction::Repair {
                resource_id: ProjectResourceId(resource_id.clone()),
                locator: replacement,
            },
        )),
        "invalidrequest",
    );

    let after_record = stored_project_record(&handler, &project_record.id);
    let after = decode_project_storage_record(&after_record.payload.bytes).expect("project");
    assert_eq!(after_record.revision_id, project_record.revision_id);
    assert_eq!(after.project_id, before.project_id);
    assert_eq!(after.resources[0].resource_id, resource_id);
    assert_eq!(
        after.resources[0].current_locator,
        before.resources[0].current_locator
    );
}

fn create_request(idempotency_key: &str, display_name: &str) -> ServerControlRequest {
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

fn resource_request(
    command_id: &str,
    record: &nucleus_local_store::LocalStoreRecord,
    action: ProjectResourceAction,
) -> ServerControlRequest {
    command_request(command_id, resource_command(record, action, command_id))
}

fn resource_command(
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

fn command_request(command_id: &str, command: ProjectResourceCommand) -> ServerControlRequest {
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

fn project_record(
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

fn stored_project_record(
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

fn assert_accepted(response: crate::control_api::ServerControlResponse) {
    assert_eq!(response.status, ServerControlResponseStatus::Accepted);
}

fn assert_rejected_kind(response: crate::control_api::ServerControlResponse, kind: &str) {
    assert_eq!(response.status, ServerControlResponseStatus::Rejected);
    assert!(format!("{response:?}").to_lowercase().contains(kind));
}
