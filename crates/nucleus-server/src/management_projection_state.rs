//! Server-owned management projection planning helpers.

use nucleus_engine::{export_project_task_projection, ManagementProjectionExportPlan};
use nucleus_local_store::{LocalStoreBackend, LocalStoreError, LocalStoreResult};
use nucleus_projects::{decode_project_storage_record, ProjectStorageRecord};
use nucleus_tasks::{decode_task_storage_record, TaskStorageRecord};

use crate::state::ServerStateService;

pub fn build_management_projection_export_plan<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<ManagementProjectionExportPlan>
where
    B: LocalStoreBackend,
{
    let projects = read_project_projection_records(state)?;
    let tasks = read_task_projection_records(state)?;

    Ok(export_project_task_projection(&projects, &tasks))
}

fn read_project_projection_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ProjectStorageRecord>>
where
    B: LocalStoreBackend,
{
    state
        .projects()
        .list()?
        .iter()
        .map(|record| {
            decode_project_storage_record(&record.payload.bytes).map_err(|error| {
                LocalStoreError::InvalidRecord {
                    reason: error.reason,
                }
            })
        })
        .collect()
}

fn read_task_projection_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<TaskStorageRecord>>
where
    B: LocalStoreBackend,
{
    state
        .tasks()
        .list()?
        .iter()
        .map(|record| {
            decode_task_storage_record(&record.payload.bytes).map_err(|error| {
                LocalStoreError::InvalidRecord {
                    reason: error.reason,
                }
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_seed::{seed_local_project, LocalProjectSeed};
    use crate::state::ServerStateService;
    use crate::task_seed::{seed_local_task, LocalTaskSeed};
    use nucleus_local_store::SqliteBackend;
    use nucleus_projects::ImportanceLevel;
    use nucleus_tasks::{TaskActionType, TaskImportance};

    #[test]
    fn management_projection_export_plan_reads_project_and_task_state() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        seed_local_project(
            &state,
            LocalProjectSeed {
                project_id: "project:nucleus".to_owned(),
                display_name: "Nucleus".to_owned(),
                importance_level: ImportanceLevel::High,
            },
        )
        .expect("seed project");
        seed_local_task(
            &state,
            LocalTaskSeed {
                task_id: "task:projection".to_owned(),
                project_id: "project:nucleus".to_owned(),
                title: "Export projection".to_owned(),
                action_type: TaskActionType::Execute,
                importance: TaskImportance::High,
            },
        )
        .expect("seed task");

        let plan = build_management_projection_export_plan(&state).expect("export plan");
        let json = serde_json::to_string(&plan).expect("plan json");

        assert_eq!(plan.root.relative_path, "nucleus");
        assert_eq!(plan.entries.len(), 2);
        assert!(json.contains("nucleus/project.toml"));
        assert!(json.contains("nucleus/tasks/task:projection.toml"));
        for forbidden in [
            "raw_stdout",
            "terminal_stream",
            "provider_auth",
            "global_display_window_surface",
            "per_project_panel",
            "secret",
        ] {
            assert!(!json.contains(forbidden), "projection leaked {forbidden}");
        }
    }
}
