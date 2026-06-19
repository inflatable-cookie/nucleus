use super::*;

#[test]
fn management_projection_apply_import_updates_targeted_records_without_scm_mutation() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db_path = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db_path.clone()));
    seed_local_project(
        &state,
        LocalProjectSeed {
            project_id: "project:nucleus".to_owned(),
            display_name: "Old Nucleus".to_owned(),
            importance_level: ImportanceLevel::High,
        },
    )
    .expect("seed project");
    seed_local_task(
        &state,
        LocalTaskSeed {
            task_id: "task:projection".to_owned(),
            project_id: "project:nucleus".to_owned(),
            title: "Old projection".to_owned(),
            action_type: TaskActionType::Execute,
            importance: TaskImportance::High,
        },
    )
    .expect("seed task");
    let mut plan = build_management_projection_export_plan(&state).expect("export plan");
    for entry in &mut plan.entries {
        if let ManagementProjectionPayload::Task(task) = &mut entry.payload {
            task.title = "Applied projection".to_owned();
        }
    }
    let repo_root = temp_dir.path().join("repo");
    let file_refs = plan
        .entries
        .iter()
        .map(|entry| entry.envelope.file_ref.clone())
        .collect::<Vec<_>>();
    write_management_projection_export_files(ManagementProjectionExportFileRequest {
        repo_root: repo_root.clone(),
        plan,
        overwrite_existing: false,
    })
    .expect("write projection files");
    let staging =
        stage_management_projection_import_files(ManagementProjectionImportStagingRequest {
            repo_root,
            file_refs,
        })
        .expect("stage import");

    let report = apply_management_projection_import(
        &state,
        ManagementProjectionImportApplyRequest {
            staged: staging.staged,
            targets: vec![
                ManagementProjectionApplyTarget {
                    record_id: ManagementProjectionRecordId("project:nucleus".to_owned()),
                    expected_current_revision: Some(RevisionId("rev:seed:1".to_owned())),
                },
                ManagementProjectionApplyTarget {
                    record_id: ManagementProjectionRecordId("task:projection".to_owned()),
                    expected_current_revision: Some(RevisionId("rev:task-seed:1".to_owned())),
                },
            ],
            conflicts: Vec::new(),
        },
    )
    .expect("apply import");
    let task = state
        .tasks()
        .get(&PersistenceRecordId("task:projection".to_owned()))
        .expect("task get")
        .expect("task record");
    let decoded_task = decode_task_storage_record(&task.payload.bytes).expect("decode task");

    assert!(report.authoritative_state_mutated);
    assert!(!report.scm_mutation_performed);
    assert!(report.blocked.is_empty());
    assert_eq!(report.applied.len(), 2);
    assert_eq!(report.receipts.len(), 2);
    assert!(report
        .receipts
        .iter()
        .all(|receipt| receipt.status == EngineRuntimeReceiptStatus::Completed));
    assert_eq!(decoded_task.title, "Applied projection");

    let restarted = ServerStateService::new(SqliteBackend::new(db_path));
    let receipts = read_runtime_receipts(&restarted).expect("read receipts");
    let json = serde_json::to_string(&receipts).expect("receipt json");
    assert_eq!(receipts.len(), 2);
    assert!(json.contains("management_projection_apply"));
    for forbidden in [
        "Old projection",
        "Applied projection",
        "raw_stdout",
        "provider_auth",
        "secret",
    ] {
        assert!(!json.contains(forbidden), "receipt leaked {forbidden}");
    }
}

#[test]
fn management_projection_apply_import_requires_explicit_targets() {
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
            title: "Projection task".to_owned(),
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
    let staging =
        stage_management_projection_import_files(ManagementProjectionImportStagingRequest {
            repo_root,
            file_refs,
        })
        .expect("stage import");

    let report = apply_management_projection_import(
        &state,
        ManagementProjectionImportApplyRequest {
            staged: staging.staged,
            targets: vec![ManagementProjectionApplyTarget {
                record_id: ManagementProjectionRecordId("project:nucleus".to_owned()),
                expected_current_revision: Some(RevisionId("rev:seed:1".to_owned())),
            }],
            conflicts: Vec::new(),
        },
    )
    .expect("apply import");

    assert!(!report.authoritative_state_mutated);
    assert!(report.applied.is_empty());
    assert_eq!(report.blocked.len(), 1);
    assert_eq!(report.receipts.len(), 2);
    assert_eq!(
        report.blocked[0].kind,
        ManagementProjectionApplyBlockKind::MissingApplyTarget
    );
    assert!(report.blocked[0].receipt_id.is_some());
    assert!(report.receipts.iter().any(|receipt| {
        receipt.status == EngineRuntimeReceiptStatus::Blocked
            && receipt.summary.as_deref().unwrap_or("").contains("skipped")
    }));
}

#[test]
fn management_projection_apply_import_blocks_stale_expected_revision() {
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
    let plan = build_management_projection_export_plan(&state).expect("export plan");
    let repo_root = temp_dir.path().join("repo");
    write_management_projection_export_files(ManagementProjectionExportFileRequest {
        repo_root: repo_root.clone(),
        plan,
        overwrite_existing: false,
    })
    .expect("write projection files");
    let staging =
        stage_management_projection_import_files(ManagementProjectionImportStagingRequest {
            repo_root,
            file_refs: vec![ManagementProjectionFileRef::project()],
        })
        .expect("stage import");

    let report = apply_management_projection_import(
        &state,
        ManagementProjectionImportApplyRequest {
            staged: staging.staged,
            targets: vec![ManagementProjectionApplyTarget {
                record_id: ManagementProjectionRecordId("project:nucleus".to_owned()),
                expected_current_revision: Some(RevisionId("rev:stale".to_owned())),
            }],
            conflicts: Vec::new(),
        },
    )
    .expect("apply import");

    assert!(!report.authoritative_state_mutated);
    assert!(report.applied.is_empty());
    assert_eq!(report.blocked.len(), 1);
    assert_eq!(report.receipts.len(), 1);
    assert_eq!(
        report.blocked[0].kind,
        ManagementProjectionApplyBlockKind::RevisionConflict
    );
    assert!(report.blocked[0].receipt_id.is_some());
    assert!(report.blocked[0].summary.contains("rev:stale"));
}

#[test]
fn management_projection_apply_import_blocks_semantic_conflicts_with_evidence() {
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
    for entry in &mut plan.entries {
        if let ManagementProjectionPayload::Task(task) = &mut entry.payload {
            task.title = "Incoming projection".to_owned();
        }
    }
    let repo_root = temp_dir.path().join("repo");
    write_management_projection_export_files(ManagementProjectionExportFileRequest {
        repo_root: repo_root.clone(),
        plan,
        overwrite_existing: false,
    })
    .expect("write projection files");
    let staging =
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

    let report = apply_management_projection_import(
        &state,
        ManagementProjectionImportApplyRequest {
            staged: staging.staged,
            targets: vec![ManagementProjectionApplyTarget {
                record_id: ManagementProjectionRecordId("task:projection".to_owned()),
                expected_current_revision: Some(RevisionId("rev:task-seed:1".to_owned())),
            }],
            conflicts: vec![conflict.clone()],
        },
    )
    .expect("apply import");

    assert!(!report.authoritative_state_mutated);
    assert_eq!(report.blocked.len(), 1);
    assert_eq!(report.receipts.len(), 1);
    assert_eq!(
        report.blocked[0].kind,
        ManagementProjectionApplyBlockKind::SemanticConflict
    );
    assert_eq!(
        report.receipts[0].status,
        EngineRuntimeReceiptStatus::WaitingForApproval
    );
    assert_eq!(report.blocked[0].conflict, Some(conflict));
}

#[test]
fn management_projection_apply_import_blocks_invalid_and_unsupported_staged_records() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let invalid_doc = ManagementProjectionFileDocument {
        envelope: nucleus_engine::ManagementProjectionEnvelope {
            schema_version: nucleus_engine::ManagementProjectionSchemaVersion::current(),
            record_id: ManagementProjectionRecordId(String::new()),
            record_kind: nucleus_engine::ManagementProjectionRecordKind::Task,
            file_ref: ManagementProjectionFileRef::task("invalid"),
        },
        payload: ManagementProjectionPayload::Unsupported {
            payload_kind: "task".to_owned(),
            retained_payload: "{}".to_owned(),
        },
    };
    let unsupported_doc = ManagementProjectionFileDocument {
        envelope: nucleus_engine::ManagementProjectionEnvelope {
            schema_version: nucleus_engine::ManagementProjectionSchemaVersion("future".to_owned()),
            record_id: ManagementProjectionRecordId("task:future".to_owned()),
            record_kind: nucleus_engine::ManagementProjectionRecordKind::Task,
            file_ref: ManagementProjectionFileRef::task("task:future"),
        },
        payload: ManagementProjectionPayload::Unsupported {
            payload_kind: "task".to_owned(),
            retained_payload: "{}".to_owned(),
        },
    };
    let invalid = ManagementProjectionStagedFile {
        file_ref: invalid_doc.envelope.file_ref.clone(),
        path: temp_dir.path().join("repo/nucleus/tasks/invalid.toml"),
        validation: nucleus_engine::validate_projection_envelope(&invalid_doc.envelope, &[]),
        document: invalid_doc,
    };
    let unsupported = ManagementProjectionStagedFile {
        file_ref: unsupported_doc.envelope.file_ref.clone(),
        path: temp_dir.path().join("repo/nucleus/tasks/task:future.toml"),
        validation: nucleus_engine::validate_projection_envelope(&unsupported_doc.envelope, &[]),
        document: unsupported_doc,
    };

    let report = apply_management_projection_import(
        &state,
        ManagementProjectionImportApplyRequest {
            staged: vec![invalid, unsupported],
            targets: vec![
                ManagementProjectionApplyTarget {
                    record_id: ManagementProjectionRecordId(String::new()),
                    expected_current_revision: None,
                },
                ManagementProjectionApplyTarget {
                    record_id: ManagementProjectionRecordId("task:future".to_owned()),
                    expected_current_revision: None,
                },
            ],
            conflicts: Vec::new(),
        },
    )
    .expect("apply import");

    assert!(!report.authoritative_state_mutated);
    assert!(report.applied.is_empty());
    assert_eq!(report.receipts.len(), 2);
    assert!(report
        .blocked
        .iter()
        .any(|block| block.kind == ManagementProjectionApplyBlockKind::InvalidRecord));
    assert!(report
        .blocked
        .iter()
        .any(|block| block.kind == ManagementProjectionApplyBlockKind::UnsupportedSchema));
    assert!(report
        .receipts
        .iter()
        .all(|receipt| receipt.status == EngineRuntimeReceiptStatus::Blocked));
}
