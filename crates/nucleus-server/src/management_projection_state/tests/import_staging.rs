use super::*;

#[test]
fn management_projection_import_stages_exported_files_without_mutating_state() {
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
    let file_refs = plan
        .entries
        .iter()
        .map(|entry| entry.envelope.file_ref.clone())
        .collect::<Vec<_>>();
    let repo_root = temp_dir.path().join("repo");
    write_management_projection_export_files(ManagementProjectionExportFileRequest {
        repo_root: repo_root.clone(),
        plan,
        overwrite_existing: false,
    })
    .expect("write projection files");

    let report =
        stage_management_projection_import_files(ManagementProjectionImportStagingRequest {
            repo_root,
            file_refs,
        })
        .expect("stage import");

    assert!(!report.authoritative_state_mutated);
    assert_eq!(report.staged.len(), 2);
    assert!(report.invalid.is_empty());
    assert!(report.unsupported.is_empty());
    assert!(report.staged.iter().any(|staged| {
        staged.file_ref == ManagementProjectionFileRef::task("task:projection")
            && staged.validation.status == ManagementProjectionValidationStatus::Valid
    }));
}

#[test]
fn management_projection_import_stages_divergent_task_for_conflict_review() {
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
            title: "Local projection".to_owned(),
            action_type: TaskActionType::Execute,
            importance: TaskImportance::High,
        },
    )
    .expect("seed task");
    let mut plan = build_management_projection_export_plan(&state).expect("export plan");
    let task_entry = plan
        .entries
        .iter_mut()
        .find(|entry| {
            entry.envelope.file_ref == ManagementProjectionFileRef::task("task:projection")
        })
        .expect("task entry");
    if let ManagementProjectionPayload::Task(task) = &mut task_entry.payload {
        task.title = "Incoming projection".to_owned();
        task.acceptance_criteria
            .push(nucleus_tasks::TaskStorageAcceptanceCriterion {
                text: "Incoming criteria".to_owned(),
                required: true,
            });
    }
    let repo_root = temp_dir.path().join("repo");
    write_management_projection_export_files(ManagementProjectionExportFileRequest {
        repo_root: repo_root.clone(),
        plan,
        overwrite_existing: false,
    })
    .expect("write divergent projection");

    let report =
        stage_management_projection_import_files(ManagementProjectionImportStagingRequest {
            repo_root,
            file_refs: vec![ManagementProjectionFileRef::task("task:projection")],
        })
        .expect("stage import");
    let conflict = ManagementProjectionConflictReport {
        conflict_id: "conflict:task:projection:title".to_owned(),
        file_ref: ManagementProjectionFileRef::task("task:projection"),
        local_record_ref: Some(ManagementProjectionRecordId("task:projection".to_owned())),
        incoming_record_ref: Some(ManagementProjectionRecordId("task:projection".to_owned())),
        class: ManagementProjectionConflictClass::Semantic(
            ManagementProjectionSemanticConflictKind::AcceptanceCriteriaRewrite,
        ),
        summary: "incoming task projection diverges from local task state".to_owned(),
    };

    assert!(!report.authoritative_state_mutated);
    assert_eq!(report.staged.len(), 1);
    assert_eq!(
        report.staged[0].validation.status,
        ManagementProjectionValidationStatus::Valid
    );
    assert!(matches!(
        &report.staged[0].document.payload,
        ManagementProjectionPayload::Task(task)
            if task.title == "Incoming projection"
                && task.acceptance_criteria.iter().any(|criterion| {
                    criterion.text == "Incoming criteria"
                })
    ));
    assert_eq!(
        conflict.class,
        ManagementProjectionConflictClass::Semantic(
            ManagementProjectionSemanticConflictKind::AcceptanceCriteriaRewrite
        )
    );
}

#[test]
fn management_projection_import_reports_invalid_and_unsupported_files_separately() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let repo_root = temp_dir.path().join("repo");
    let invalid_ref = ManagementProjectionFileRef("nucleus/tasks/invalid.toml".to_owned());
    let unsupported_ref = ManagementProjectionFileRef("nucleus/tasks/unsupported.toml".to_owned());
    let invalid_path = scoped_projection_path(&repo_root, &invalid_ref).expect("invalid path");
    let unsupported_path =
        scoped_projection_path(&repo_root, &unsupported_ref).expect("unsupported path");
    std::fs::create_dir_all(invalid_path.parent().expect("parent")).expect("mkdir");
    std::fs::write(&invalid_path, b"not = [valid").expect("write invalid");
    write_projection_document(
        &ManagementProjectionFileDocument {
            envelope: nucleus_engine::ManagementProjectionEnvelope {
                schema_version: nucleus_engine::ManagementProjectionSchemaVersion(
                    "future".to_owned(),
                ),
                record_id: nucleus_engine::ManagementProjectionRecordId("task:future".to_owned()),
                record_kind: nucleus_engine::ManagementProjectionRecordKind::Task,
                file_ref: unsupported_ref.clone(),
            },
            payload: nucleus_engine::ManagementProjectionPayload::Unsupported {
                payload_kind: "task".to_owned(),
                retained_payload: "{}".to_owned(),
            },
        },
        &unsupported_path,
    )
    .expect("write unsupported");

    let report =
        stage_management_projection_import_files(ManagementProjectionImportStagingRequest {
            repo_root,
            file_refs: vec![invalid_ref.clone(), unsupported_ref.clone()],
        })
        .expect("stage import");

    assert!(report.staged.is_empty());
    assert_eq!(report.invalid.len(), 1);
    assert_eq!(report.unsupported.len(), 1);
    assert_eq!(report.invalid[0].file_ref, invalid_ref);
    assert_eq!(report.unsupported[0].file_ref, unsupported_ref);
    assert!(!report.authoritative_state_mutated);
}
