use super::*;
use crate::commands::{
    ProjectCommand, ProjectCreateCommand, ProjectLifecycleAction, ProjectLifecycleCommand,
};
use crate::project_lifecycle::read_project_lifecycle_receipts;
use nucleus_core::PersistenceRecordId;
use nucleus_projects::{decode_project_storage_record, ProjectStorageStatus};

#[test]
fn project_create_is_name_only_resource_free_and_durable_across_reopen() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let database_path = temp_dir.path().join("nucleus.sqlite");
    let backend = SqliteBackend::new(database_path.clone());
    let mut handler = LocalControlRequestHandler::new(backend, None);

    let response = handler.handle(create_request("create:one", "Empty Project"));
    assert_eq!(response.status, ServerControlResponseStatus::Accepted);

    let records = handler.state().projects().list().expect("project records");
    let project_record = records
        .iter()
        .find(|record| record.kind == PersistenceRecordKind::Project)
        .expect("created project");
    let project = decode_project_storage_record(&project_record.payload.bytes).expect("project");
    assert_eq!(project.display_name, "Empty Project");
    assert_eq!(project.authority_host_ref, "host:embedded-desktop");
    assert!(project.resources.is_empty());
    assert_eq!(
        project.retention,
        nucleus_projects::ProjectRetentionStorage::Durable
    );

    let reopened = LocalControlRequestHandler::new(SqliteBackend::new(database_path), None);
    let receipts = read_project_lifecycle_receipts(reopened.state()).expect("receipts");
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].action, "create");
    assert_eq!(receipts[0].project_id, project.project_id);
}

#[test]
fn project_lifecycle_enforces_revision_host_and_idempotency() {
    let (_temp_dir, mut handler) = handler(None);
    assert_eq!(
        handler
            .handle(create_request("create:two", "Before"))
            .status,
        ServerControlResponseStatus::Accepted
    );
    let project_record = project_record(&handler);

    let stale = lifecycle_request(
        "rename:stale",
        &project_record.id.0,
        "rev:stale",
        "rename:stale",
        "host:embedded-desktop",
        ProjectLifecycleAction::Rename {
            display_name: "After".to_owned(),
        },
    );
    assert_rejected_kind(handler.handle(stale), "conflict");

    let wrong_host = lifecycle_request(
        "rename:host",
        &project_record.id.0,
        &project_record.revision_id.0,
        "rename:host",
        "host:remote",
        ProjectLifecycleAction::Rename {
            display_name: "After".to_owned(),
        },
    );
    assert_rejected_kind(handler.handle(wrong_host), "unauthorized");

    let rename = lifecycle_request(
        "rename:ok",
        &project_record.id.0,
        &project_record.revision_id.0,
        "rename:stable",
        "host:embedded-desktop",
        ProjectLifecycleAction::Rename {
            display_name: "After".to_owned(),
        },
    );
    assert_eq!(
        handler.handle(rename.clone()).status,
        ServerControlResponseStatus::Accepted
    );
    assert_eq!(
        handler.handle(rename).status,
        ServerControlResponseStatus::Accepted
    );

    let conflict = lifecycle_request(
        "rename:conflict",
        &project_record.id.0,
        &project_record.revision_id.0,
        "rename:stable",
        "host:embedded-desktop",
        ProjectLifecycleAction::Park,
    );
    assert_rejected_kind(handler.handle(conflict), "conflict");

    let stored = handler
        .state()
        .projects()
        .get(&project_record.id)
        .expect("get")
        .expect("project");
    let project = decode_project_storage_record(&stored.payload.bytes).expect("decode");
    assert_eq!(project.display_name, "After");
}

#[test]
fn deletion_refuses_retained_work_and_removes_only_empty_projects() {
    let (_temp_dir, mut handler) = handler(None);
    seed_local_project(handler.state(), LocalProjectSeed::nucleus_local()).expect("seed");
    let seeded = handler
        .state()
        .projects()
        .get(&PersistenceRecordId("project:nucleus-local".to_owned()))
        .expect("get")
        .expect("seeded");
    let refused = lifecycle_request(
        "delete:retained",
        "project:nucleus-local",
        &seeded.revision_id.0,
        "delete:retained",
        "host:embedded-desktop",
        ProjectLifecycleAction::Delete,
    );
    let response = handler.handle(refused);
    assert_rejected_kind(response.clone(), "invalidrequest");
    assert!(format!("{response:?}").contains("retained resources=1"));

    assert_eq!(
        handler
            .handle(create_request("create:empty", "Disposable"))
            .status,
        ServerControlResponseStatus::Accepted
    );
    let empty = handler
        .state()
        .projects()
        .list()
        .expect("list")
        .into_iter()
        .filter(|record| record.kind == PersistenceRecordKind::Project)
        .find(|record| {
            decode_project_storage_record(&record.payload.bytes)
                .is_ok_and(|project| project.display_name == "Disposable")
        })
        .expect("empty project");
    let delete = lifecycle_request(
        "delete:empty",
        &empty.id.0,
        &empty.revision_id.0,
        "delete:empty",
        "host:embedded-desktop",
        ProjectLifecycleAction::Delete,
    );
    assert_eq!(
        handler.handle(delete.clone()).status,
        ServerControlResponseStatus::Accepted
    );
    assert_eq!(
        handler.handle(delete).status,
        ServerControlResponseStatus::Accepted
    );
    assert!(handler
        .state()
        .projects()
        .get(&empty.id)
        .expect("get deleted")
        .is_none());
}

#[test]
fn park_archive_and_restore_persist_status_history() {
    let (_temp_dir, mut handler) = handler(None);
    handler.handle(create_request("create:status", "Status Project"));
    let mut record = project_record(&handler);
    for (index, action, expected_status) in [
        (
            1,
            ProjectLifecycleAction::Park,
            ProjectStorageStatus::Parked,
        ),
        (
            2,
            ProjectLifecycleAction::Archive,
            ProjectStorageStatus::Archived,
        ),
        (
            3,
            ProjectLifecycleAction::Restore,
            ProjectStorageStatus::Active,
        ),
    ] {
        let request = lifecycle_request(
            &format!("status:{index}"),
            &record.id.0,
            &record.revision_id.0,
            &format!("status:{index}"),
            "host:embedded-desktop",
            action,
        );
        assert_eq!(
            handler.handle(request).status,
            ServerControlResponseStatus::Accepted
        );
        record = handler
            .state()
            .projects()
            .get(&record.id)
            .expect("get")
            .expect("project");
        assert_eq!(
            decode_project_storage_record(&record.payload.bytes)
                .expect("decode")
                .status,
            expected_status
        );
    }
    assert_eq!(
        read_project_lifecycle_receipts(handler.state())
            .expect("receipts")
            .len(),
        4
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
                actor_ref: "operator:test".to_owned(),
                authority_host_ref: "host:embedded-desktop".to_owned(),
                idempotency_key: idempotency_key.to_owned(),
            })),
        }),
    }
}

fn lifecycle_request(
    command_id: &str,
    project_id: &str,
    revision: &str,
    idempotency_key: &str,
    host: &str,
    action: ProjectLifecycleAction,
) -> ServerControlRequest {
    ServerControlRequest {
        id: ServerControlRequestId(format!("request:{command_id}")),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId(format!("command:{command_id}")),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Project(ProjectCommand::Lifecycle(ProjectLifecycleCommand {
                project_id: ProjectId(project_id.to_owned()),
                expected_revision: RevisionId(revision.to_owned()),
                actor_ref: "operator:test".to_owned(),
                authority_host_ref: host.to_owned(),
                idempotency_key: idempotency_key.to_owned(),
                action,
            })),
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

fn assert_rejected_kind(response: crate::control_api::ServerControlResponse, kind: &str) {
    assert_eq!(response.status, ServerControlResponseStatus::Rejected);
    assert!(format!("{response:?}").to_lowercase().contains(kind));
}
