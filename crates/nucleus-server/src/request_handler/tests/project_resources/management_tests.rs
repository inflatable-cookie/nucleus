//! Management projection binding tests, split from the project_resources
//! god file; behavior unchanged.

use super::*;

use crate::commands::ProjectResourceAction;
use nucleus_projects::{
    decode_project_storage_record, ManagementProjectionSyncPolicy, ProjectResourceId,
    ProjectResourceStorageKind,
};

#[test]
fn management_projection_binding_is_explicit_durable_and_repair_aware() {
    let (temp_dir, mut handler) = handler(None);
    assert_accepted(handler.handle(create_request("projection-project", "Projection Project")));
    let mut project_record = project_record(&handler);

    let folder = temp_dir.path().join("plain-folder");
    std::fs::create_dir(&folder).expect("plain folder");
    assert_accepted(handler.handle(resource_request(
        "attach-plain-folder",
        &project_record,
        ProjectResourceAction::Attach { locator: folder },
    )));
    project_record = stored_project_record(&handler, &project_record.id);
    let plain_resource_id = decode_project_storage_record(&project_record.payload.bytes)
        .expect("project")
        .resources[0]
        .resource_id
        .clone();
    assert_rejected_kind(
        handler.handle(resource_request(
            "bind-plain-folder",
            &project_record,
            ProjectResourceAction::SetManagementProjection {
                resource_id: ProjectResourceId(plain_resource_id),
                sync_policy: ManagementProjectionSyncPolicy::Manual,
            },
        )),
        "git resource",
    );

    let repository = temp_dir.path().join("management-repository");
    std::fs::create_dir_all(repository.join(".git")).expect("git repository");
    assert_accepted(handler.handle(resource_request(
        "attach-management-repository",
        &project_record,
        ProjectResourceAction::Attach {
            locator: repository.clone(),
        },
    )));
    project_record = stored_project_record(&handler, &project_record.id);
    let repository_resource_id = decode_project_storage_record(&project_record.payload.bytes)
        .expect("project")
        .resources
        .iter()
        .find(|resource| resource.kind == ProjectResourceStorageKind::GitRepository)
        .expect("repository resource")
        .resource_id
        .clone();

    assert_accepted(handler.handle(resource_request(
        "bind-management-repository",
        &project_record,
        ProjectResourceAction::SetManagementProjection {
            resource_id: ProjectResourceId(repository_resource_id.clone()),
            sync_policy: ManagementProjectionSyncPolicy::Manual,
        },
    )));
    project_record = stored_project_record(&handler, &project_record.id);
    let project = decode_project_storage_record(&project_record.payload.bytes).expect("project");
    let target = project
        .management_projection
        .expect("management projection");
    assert_eq!(target.resource_id, repository_resource_id);
    assert_eq!(target.sync_policy_ref.as_deref(), Some("manual"));

    drop(handler);
    let mut handler = LocalControlRequestHandler::new(
        SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")),
        None,
    );
    project_record = stored_project_record(&handler, &project_record.id);
    let dto = crate::control_envelope_dto::ControlProjectRecordDto::try_from(&project_record)
        .expect("project dto");
    assert_eq!(
        dto.management_resource_id.as_deref(),
        Some(repository_resource_id.as_str())
    );
    assert_eq!(dto.management_sync_policy.as_deref(), Some("manual"));
    assert_eq!(dto.management_projection_status.as_deref(), Some("ready"));
    let resolved = crate::management_projection_state::resolve_management_projection_target(
        handler.state(),
        &project_record.id.0,
    )
    .expect("resolved management projection");
    assert_eq!(resolved.resource_id, repository_resource_id);
    assert_eq!(resolved.sync_policy, "manual");
    assert_eq!(
        resolved.repo_root,
        repository.canonicalize().expect("canonical repository")
    );
    let export =
        crate::management_projection_state::write_project_management_projection_export_files(
            handler.state(),
            &project_record.id.0,
            false,
        )
        .expect("bound management export");
    assert_eq!(export.repo_root, resolved.repo_root);
    assert!(repository.join("nucleus/project.toml").exists());
    let staged =
        crate::management_projection_state::stage_project_management_projection_import_files(
            handler.state(),
            &project_record.id.0,
            vec![nucleus_engine::ManagementProjectionFileRef::project()],
        )
        .expect("bound management import staging");
    assert_eq!(staged.staged.len(), 1);
    assert!(!staged.authoritative_state_mutated);

    std::fs::rename(
        &repository,
        temp_dir.path().join("moved-management-repository"),
    )
    .expect("move repository");
    let dto = crate::control_envelope_dto::ControlProjectRecordDto::try_from(&project_record)
        .expect("missing project dto");
    assert_eq!(dto.management_projection_status.as_deref(), Some("missing"));
    assert!(
        crate::management_projection_state::resolve_management_projection_target(
            handler.state(),
            &project_record.id.0,
        )
        .expect_err("moved repository requires repair")
        .contains("unavailable")
    );

    assert_accepted(handler.handle(resource_request(
        "clear-management-repository",
        &project_record,
        ProjectResourceAction::ClearManagementProjection,
    )));
    project_record = stored_project_record(&handler, &project_record.id);
    let project = decode_project_storage_record(&project_record.payload.bytes).expect("project");
    assert!(project.management_projection.is_none());
    assert_accepted(handler.handle(resource_request(
        "remove-former-management-repository",
        &project_record,
        ProjectResourceAction::Remove {
            resource_id: ProjectResourceId(repository_resource_id),
        },
    )));
}
