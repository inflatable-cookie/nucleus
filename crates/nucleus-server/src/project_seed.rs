//! Server-owned local project seed path.

use std::path::{Path, PathBuf};

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use nucleus_projects::{
    decode_project_storage_record, encode_project_storage_payload, encode_project_storage_record,
    ImportanceBaseline, ImportanceLevel, Project, ProjectActivity, ProjectId, ProjectResource,
    ProjectResourceId, ProjectResourceKind, ProjectResourceRole, ProjectRetention, ProjectStatus,
    ResourceLocationStatus, ResourceLocatorRecord, WorkingResourceTarget,
};

use crate::state::ServerStateService;

/// Local project seed input.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalProjectSeed {
    pub project_id: String,
    pub display_name: String,
    pub importance_level: ImportanceLevel,
}

impl LocalProjectSeed {
    /// Default bootstrap seed for local desktop readiness.
    pub fn nucleus_local() -> Self {
        Self {
            project_id: "project:nucleus-local".to_owned(),
            display_name: "Nucleus Local".to_owned(),
            importance_level: ImportanceLevel::Normal,
        }
    }
}

/// Seed one local project record through server-owned state access.
pub fn seed_local_project<B>(
    state: &ServerStateService<B>,
    seed: LocalProjectSeed,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let record_id = PersistenceRecordId(seed.project_id.clone());
    if let Some(existing) = state.projects().get(&record_id)? {
        if let Some(repaired) = repair_existing_local_project_seed(state, &seed, &existing)? {
            return Ok(repaired);
        }
        return Ok(existing);
    }

    let project = project_from_seed(&seed);
    let payload = encode_project_storage_record(&project).map_err(|error| {
        LocalStoreError::InvalidRecord {
            reason: error.reason,
        }
    })?;
    let record = LocalStoreRecord {
        id: record_id,
        domain: PersistenceDomain::Projects,
        kind: PersistenceRecordKind::Project,
        revision_id: RevisionId("rev:seed:1".to_owned()),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: payload,
        },
    };

    state
        .projects()
        .put(record, RevisionExpectation::MustNotExist)
}

fn project_from_seed(seed: &LocalProjectSeed) -> Project {
    Project {
        id: ProjectId(seed.project_id.clone()),
        display_name: seed.display_name.clone(),
        authority_host_ref: "host:embedded-desktop".to_owned(),
        status: ProjectStatus::Active,
        retention: ProjectRetention::Durable,
        importance_baseline: ImportanceBaseline {
            level: seed.importance_level.clone(),
            notes: Some("local seed".to_owned()),
        },
        resources: local_seed_resources(&seed.project_id),
        default_working_resource: local_seed_default_resource(&seed.project_id),
        management_projection: None,
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

fn repair_existing_local_project_seed<B>(
    state: &ServerStateService<B>,
    seed: &LocalProjectSeed,
    existing: &LocalStoreRecord,
) -> LocalStoreResult<Option<LocalStoreRecord>>
where
    B: LocalStoreBackend,
{
    if seed.project_id != LocalProjectSeed::nucleus_local().project_id {
        return Ok(None);
    }

    let Ok(mut decoded) = decode_project_storage_record(&existing.payload.bytes) else {
        return Ok(None);
    };

    let mut record = existing.clone();
    let (revision_id, payload) = if decoded.resources.is_empty() {
        let project = project_from_seed(seed);
        (
            "rev:seed:repo-location:1",
            encode_project_storage_record(&project),
        )
    } else {
        let Some(resource) = decoded.resources.iter_mut().find(|resource| {
            resource.resource_id == "resource:nucleus-local"
                && resource.authority_host_ref == "host:local"
        }) else {
            return Ok(None);
        };
        resource.authority_host_ref = decoded.authority_host_ref.clone();
        (
            "rev:seed:resource-authority:1",
            encode_project_storage_payload(&decoded),
        )
    };
    let payload = payload.map_err(|error| LocalStoreError::InvalidRecord {
        reason: error.reason,
    })?;
    record.revision_id = RevisionId(revision_id.to_owned());
    record.payload = LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes: payload,
    };

    state
        .projects()
        .put(record, RevisionExpectation::Any)
        .map(Some)
}

fn local_seed_resources(project_id: &str) -> Vec<ProjectResource> {
    if project_id != "project:nucleus-local" {
        return Vec::new();
    }

    let Some(path) = infer_local_repo_root() else {
        return Vec::new();
    };

    vec![ProjectResource {
        id: ProjectResourceId("resource:nucleus-local".to_owned()),
        project_id: ProjectId(project_id.to_owned()),
        display_name: "Nucleus repository".to_owned(),
        kind: ProjectResourceKind::GitRepository,
        role: ProjectResourceRole::Working,
        authority_host_ref: "host:embedded-desktop".to_owned(),
        current_locator: Some(path.clone()),
        locator_history: vec![ResourceLocatorRecord {
            locator: path,
            observed_at: None,
            note: Some("local bootstrap seed".to_owned()),
        }],
        git: None,
        default_branch: Some("main".to_owned()),
        location_status: ResourceLocationStatus::Present,
        repair_notes: Vec::new(),
    }]
}

fn local_seed_default_resource(project_id: &str) -> Option<WorkingResourceTarget> {
    (project_id == "project:nucleus-local").then(|| WorkingResourceTarget {
        resource_id: ProjectResourceId("resource:nucleus-local".to_owned()),
        relative_working_directory: None,
    })
}

fn infer_local_repo_root() -> Option<PathBuf> {
    let current = std::env::current_dir().ok()?;
    current
        .ancestors()
        .find(|path| looks_like_nucleus_repo_root(path))
        .map(Path::to_path_buf)
        .or(Some(current))
}

fn looks_like_nucleus_repo_root(path: &Path) -> bool {
    path.join("AGENTS.md").is_file()
        && path.join("effigy.toml").is_file()
        && path.join("apps/desktop").is_dir()
}

#[cfg(test)]
mod tests {
    use nucleus_local_store::SqliteBackend;
    use nucleus_projects::decode_project_storage_record;

    use super::*;
    use crate::control_api::{
        ServerControlRequest, ServerControlRequestKind, ServerControlResponseBody, ServerQuery,
        ServerQueryKind, ServerQueryResult, StateRecordQuery, StateRecordQueryScope,
    };
    use crate::ids::{ClientId, ServerControlRequestId, ServerQueryId};
    use crate::request_handler::LocalControlRequestHandler;
    use crate::state::ServerStateDomain;

    #[test]
    fn local_project_seed_is_idempotent_and_queryable() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let mut handler = LocalControlRequestHandler::new(backend, None);

        let first = seed_local_project(
            handler.state(),
            LocalProjectSeed {
                project_id: "project:seed".to_owned(),
                display_name: "Seed Project".to_owned(),
                importance_level: ImportanceLevel::High,
            },
        )
        .expect("first seed");
        let second = seed_local_project(
            handler.state(),
            LocalProjectSeed {
                project_id: "project:seed".to_owned(),
                display_name: "Changed Name".to_owned(),
                importance_level: ImportanceLevel::Low,
            },
        )
        .expect("second seed");

        assert_eq!(first, second);

        let response = handler.handle(ServerControlRequest {
            id: ServerControlRequestId("request:seed:list".to_owned()),
            client_id: ClientId("client:test".to_owned()),
            kind: ServerControlRequestKind::Query(ServerQuery {
                id: ServerQueryId("query:seed:list".to_owned()),
                client_id: ClientId("client:test".to_owned()),
                kind: ServerQueryKind::Project(StateRecordQuery {
                    domain: ServerStateDomain::Projects,
                    scope: StateRecordQueryScope::List,
                }),
            }),
        });

        assert!(matches!(
            response.body,
            ServerControlResponseBody::Query(ServerQueryResult::StateRecords(records))
                if records.records.len() == 1
        ));
    }

    #[test]
    fn nucleus_local_project_seed_records_repo_location() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);

        let seeded =
            seed_local_project(handler.state(), LocalProjectSeed::nucleus_local()).expect("seed");
        let decoded = decode_project_storage_record(&seeded.payload.bytes).expect("project");

        assert_eq!(decoded.repo_count(), 1);
        assert!(decoded.primary_location().is_some());
    }

    #[test]
    fn nucleus_local_project_seed_repairs_existing_missing_repo_location() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);

        let old_project = Project {
            id: ProjectId("project:nucleus-local".to_owned()),
            display_name: "Nucleus Local".to_owned(),
            authority_host_ref: "host:embedded-desktop".to_owned(),
            status: ProjectStatus::Active,
            retention: ProjectRetention::Durable,
            importance_baseline: ImportanceBaseline {
                level: ImportanceLevel::Normal,
                notes: Some("old seed".to_owned()),
            },
            resources: Vec::new(),
            default_working_resource: None,
            management_projection: None,
            task_ids: Vec::new(),
            workspace_layout_refs: Vec::new(),
            activity: ProjectActivity {
                created_at: None,
                last_focused_at: None,
                last_agent_activity_at: None,
                last_task_activity_at: None,
            },
        };
        let old_record = LocalStoreRecord {
            id: PersistenceRecordId("project:nucleus-local".to_owned()),
            domain: PersistenceDomain::Projects,
            kind: PersistenceRecordKind::Project,
            revision_id: RevisionId("rev:old".to_owned()),
            payload: LocalStoreRecordPayload {
                media_type: Some("application/json".to_owned()),
                bytes: encode_project_storage_record(&old_project).expect("old project"),
            },
        };
        handler
            .state()
            .projects()
            .put(old_record, RevisionExpectation::MustNotExist)
            .expect("old project put");

        let repaired =
            seed_local_project(handler.state(), LocalProjectSeed::nucleus_local()).expect("repair");
        let decoded = decode_project_storage_record(&repaired.payload.bytes).expect("project");

        assert_eq!(repaired.revision_id.0, "rev:seed:repo-location:1");
        assert_eq!(decoded.repo_count(), 1);
        assert!(decoded.primary_location().is_some());
    }

    #[test]
    fn nucleus_local_project_seed_repairs_legacy_resource_authority() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);

        let mut old_project = project_from_seed(&LocalProjectSeed::nucleus_local());
        old_project.resources[0].authority_host_ref = "host:local".to_owned();
        let old_record = LocalStoreRecord {
            id: PersistenceRecordId("project:nucleus-local".to_owned()),
            domain: PersistenceDomain::Projects,
            kind: PersistenceRecordKind::Project,
            revision_id: RevisionId("rev:old-resource-authority".to_owned()),
            payload: LocalStoreRecordPayload {
                media_type: Some("application/json".to_owned()),
                bytes: encode_project_storage_record(&old_project).expect("old project"),
            },
        };
        handler
            .state()
            .projects()
            .put(old_record, RevisionExpectation::MustNotExist)
            .expect("old project put");

        let repaired =
            seed_local_project(handler.state(), LocalProjectSeed::nucleus_local()).expect("repair");
        let decoded = decode_project_storage_record(&repaired.payload.bytes).expect("project");

        assert_eq!(repaired.revision_id.0, "rev:seed:resource-authority:1");
        assert_eq!(
            decoded.resources[0].authority_host_ref,
            "host:embedded-desktop"
        );
    }
}
