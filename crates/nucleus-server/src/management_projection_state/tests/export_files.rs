use super::*;

#[test]
fn management_projection_export_plan_reads_project_and_task_state() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
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

#[test]
fn management_projection_export_writes_scoped_project_and_task_files_without_scm_mutation() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
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
    let repo_root = temp_dir.path().join("repo");

    let report = write_management_projection_export_files(ManagementProjectionExportFileRequest {
        repo_root: repo_root.clone(),
        plan,
        overwrite_existing: false,
    })
    .expect("write files");

    assert!(!report.scm_mutation_performed);
    assert_eq!(report.writes.len(), 2);
    assert!(repo_root.join("nucleus/project.toml").exists());
    assert!(repo_root
        .join("nucleus/tasks/task:projection.toml")
        .exists());
    let task_file = std::fs::read_to_string(repo_root.join("nucleus/tasks/task:projection.toml"))
        .expect("task file");
    assert!(task_file.contains("schema_version"));
    assert!(task_file.contains("Export projection"));
    for forbidden in [
        "provider_auth",
        "terminal_stream",
        "secret",
        "client_layout",
    ] {
        assert!(
            !task_file.contains(forbidden),
            "projection leaked {forbidden}"
        );
    }
}

#[test]
fn management_projection_export_rejects_unscoped_file_refs() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let mut plan = ManagementProjectionExportPlan {
        root: nucleus_engine::ManagementProjectionRoot::default(),
        entries: Vec::new(),
    };
    plan.entries
        .push(nucleus_engine::ManagementProjectionExportEntry {
            envelope: nucleus_engine::ManagementProjectionEnvelope {
                schema_version: nucleus_engine::ManagementProjectionSchemaVersion::current(),
                record_id: nucleus_engine::ManagementProjectionRecordId("task:bad".to_owned()),
                record_kind: nucleus_engine::ManagementProjectionRecordKind::Task,
                file_ref: ManagementProjectionFileRef("../outside.toml".to_owned()),
            },
            payload: nucleus_engine::ManagementProjectionPayload::Unsupported {
                payload_kind: "bad".to_owned(),
                retained_payload: "{}".to_owned(),
            },
        });

    let error = write_management_projection_export_files(ManagementProjectionExportFileRequest {
        repo_root: temp_dir.path().join("repo"),
        plan,
        overwrite_existing: false,
    })
    .expect_err("reject unscoped ref");

    assert!(matches!(
        error,
        LocalStoreError::InvalidRecord { reason }
            if reason == "management projection file ref must stay under repo root"
    ));
}
