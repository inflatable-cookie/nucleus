//! Project storage codec tests, split from the storage_codec god file;
//! behavior unchanged.

use std::path::PathBuf;
use std::time::Duration;
use std::time::UNIX_EPOCH;

use crate::{
    GitRemoteMetadata, ImportanceBaseline, ImportanceLevel, ManagementProjectionTarget,
    Project, ProjectActivity, ProjectId, ProjectResource, ProjectResourceId,
    ProjectResourceKind, ProjectResourceRole, ProjectRetention, ProjectStatus,
    ResourceLocationStatus, ResourceLocatorRecord, WorkingResourceTarget,
};

use super::*;

fn project(resources: Vec<ProjectResource>) -> Project {
    Project {
        id: ProjectId("project:nucleus".to_owned()),
        display_name: "Nucleus".to_owned(),
        authority_host_ref: "host:local".to_owned(),
        status: ProjectStatus::Active,
        retention: ProjectRetention::Durable,
        importance_baseline: ImportanceBaseline {
            level: ImportanceLevel::High,
            notes: Some("foundation".to_owned()),
        },
        default_working_resource: resources.first().map(|resource| WorkingResourceTarget {
            resource_id: resource.id.clone(),
            relative_working_directory: None,
        }),
        management_projection: resources
            .iter()
            .find(|resource| resource.kind == ProjectResourceKind::GitRepository)
            .map(|resource| ManagementProjectionTarget {
                resource_id: resource.id.clone(),
                sync_policy_ref: Some("manual".to_owned()),
            }),
        resources,
        task_ids: Vec::new(),
        workspace_layout_refs: Vec::new(),
        activity: ProjectActivity {
            created_at: None,
            last_focused_at: None,
            last_agent_activity_at: None,
            last_task_activity_at: None,
        },
    }
}

#[test]
fn zero_resource_project_round_trips() {
    let bytes = encode_project_storage_record(&project(Vec::new())).expect("encode project");
    let decoded = decode_project_storage_record(&bytes).expect("decode project");

    assert_eq!(decoded.schema_version, PROJECT_STORAGE_SCHEMA_VERSION);
    assert_eq!(decoded.authority_host_ref, "host:local");
    assert_eq!(decoded.retention, ProjectRetentionStorage::Durable);
    assert!(decoded.resources.is_empty());
    assert_eq!(decoded.primary_location(), None);
    assert_eq!(
        decoded.location_status(),
        ProjectStorageLocationStatus::NotRecorded
    );
}

#[test]
fn schema_v2_project_defaults_authority_host_during_decode() {
    let mut value: serde_json::Value = serde_json::from_slice(
        &encode_project_storage_record(&project(Vec::new())).expect("encode project"),
    )
    .expect("project json");
    value["schema_version"] = serde_json::json!(2);
    value
        .as_object_mut()
        .expect("project object")
        .remove("authority_host_ref");

    let decoded = decode_project_storage_record(
        &serde_json::to_vec(&value).expect("encode schema v2 fixture"),
    )
    .expect("decode schema v2 project");

    assert_eq!(decoded.schema_version, PROJECT_STORAGE_SCHEMA_VERSION);
    assert_eq!(decoded.authority_host_ref, "host:local");
}

#[test]
fn resource_metadata_and_defaults_round_trip() {
    let resource = ProjectResource {
        id: ProjectResourceId("resource:nucleus".to_owned()),
        project_id: ProjectId("project:nucleus".to_owned()),
        display_name: "Nucleus repository".to_owned(),
        kind: ProjectResourceKind::GitRepository,
        role: ProjectResourceRole::Working,
        authority_host_ref: "host:local".to_owned(),
        current_locator: Some(PathBuf::from("/tmp/nucleus")),
        locator_history: vec![ResourceLocatorRecord {
            locator: PathBuf::from("/old/nucleus"),
            observed_at: Some(UNIX_EPOCH + Duration::from_secs(10)),
            note: Some("moved".to_owned()),
        }],
        git: Some(GitRemoteMetadata {
            remote_name: Some("origin".to_owned()),
            remote_url: Some("git@example.com:nucleus.git".to_owned()),
            repository_id_hint: Some("nucleus".to_owned()),
        }),
        default_branch: Some("main".to_owned()),
        location_status: ResourceLocationStatus::Present,
        repair_notes: vec!["verified".to_owned()],
    };

    let decoded = decode_project_storage_record(
        &encode_project_storage_record(&project(vec![resource])).expect("encode project"),
    )
    .expect("decode project");

    assert_eq!(decoded.repo_count(), 1);
    assert_eq!(decoded.primary_location(), Some("/tmp/nucleus"));
    assert_eq!(
        decoded.resources[0].locator_history[0].observed_at_unix_ms,
        Some(10_000)
    );
    assert_eq!(decoded.resources[0].repair_notes, vec!["verified"]);
    assert_eq!(
        decoded
            .management_projection
            .as_ref()
            .map(|target| target.resource_id.as_str()),
        Some("resource:nucleus")
    );
}

#[test]
fn folder_and_git_resources_round_trip_without_conflating_repo_count() {
    let folder = ProjectResource {
        id: ProjectResourceId("resource:docs".to_owned()),
        project_id: ProjectId("project:nucleus".to_owned()),
        display_name: "Documentation".to_owned(),
        kind: ProjectResourceKind::FilesystemFolder,
        role: ProjectResourceRole::Working,
        authority_host_ref: "host:remote-build".to_owned(),
        current_locator: Some(PathBuf::from("/srv/docs")),
        locator_history: Vec::new(),
        git: None,
        default_branch: None,
        location_status: ResourceLocationStatus::Present,
        repair_notes: Vec::new(),
    };
    let repository = ProjectResource {
        id: ProjectResourceId("resource:api".to_owned()),
        project_id: ProjectId("project:nucleus".to_owned()),
        display_name: "API".to_owned(),
        kind: ProjectResourceKind::GitRepository,
        role: ProjectResourceRole::Reference,
        authority_host_ref: "host:remote-build".to_owned(),
        current_locator: None,
        locator_history: Vec::new(),
        git: None,
        default_branch: Some("main".to_owned()),
        location_status: ResourceLocationStatus::Missing,
        repair_notes: vec!["checkout not attached".to_owned()],
    };

    let decoded = decode_project_storage_record(
        &encode_project_storage_record(&project(vec![folder, repository]))
            .expect("encode project"),
    )
    .expect("decode project");

    assert_eq!(decoded.resources.len(), 2);
    assert_eq!(decoded.repo_count(), 1);
    assert_eq!(decoded.primary_location(), Some("/srv/docs"));
    assert_eq!(decoded.resources[0].authority_host_ref, "host:remote-build");
    assert_eq!(
        decoded.location_status(),
        ProjectStorageLocationStatus::Mixed
    );
}

#[test]
fn legacy_display_record_migrates_without_changing_project_id() {
    let bytes = br#"{"project_id":"project:legacy","display_name":"Legacy","status":"active","importance_level":"normal","repo_count":1,"primary_location":"/tmp/legacy","location_status":"present"}"#;
    let decoded = decode_project_storage_record(bytes).expect("decode legacy project");

    assert_eq!(decoded.schema_version, PROJECT_STORAGE_SCHEMA_VERSION);
    assert_eq!(decoded.project_id, "project:legacy");
    assert_eq!(decoded.retention, ProjectRetentionStorage::Durable);
    assert_eq!(decoded.repo_count(), 1);
    assert_eq!(decoded.primary_location(), Some("/tmp/legacy"));
}

#[test]
fn future_project_storage_schema_fails_closed() {
    let bytes = br#"{"schema_version":99,"project_id":"project:future"}"#;
    let error = decode_project_storage_record(bytes).expect_err("future schema");

    assert!(error
        .reason
        .contains("unsupported project storage schema version"));
}
