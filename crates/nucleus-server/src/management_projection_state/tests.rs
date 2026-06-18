use super::*;
use crate::project_seed::{seed_local_project, LocalProjectSeed};
use crate::state::ServerStateService;
use crate::task_seed::{seed_local_task, LocalTaskSeed};
use super::helpers::{scoped_projection_path, write_projection_document};
use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_engine::{
    ManagementProjectionConflictClass, ManagementProjectionConflictReport,
    ManagementProjectionExportPlan, ManagementProjectionFileDocument, ManagementProjectionFileRef,
    ManagementProjectionPayload, ManagementProjectionRecordId,
    ManagementProjectionSemanticConflictKind, ManagementProjectionValidationStatus,
};
use nucleus_local_store::{LocalStoreError, SqliteBackend};
use nucleus_projects::ImportanceLevel;
use nucleus_tasks::{decode_task_storage_record, TaskActionType, TaskImportance};

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

    #[test]
    fn management_projection_export_writes_scoped_project_and_task_files_without_scm_mutation() {
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
        let repo_root = temp_dir.path().join("repo");

        let report =
            write_management_projection_export_files(ManagementProjectionExportFileRequest {
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
        let task_file =
            std::fs::read_to_string(repo_root.join("nucleus/tasks/task:projection.toml"))
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

        let error =
            write_management_projection_export_files(ManagementProjectionExportFileRequest {
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

    #[test]
    fn management_projection_import_stages_exported_files_without_mutating_state() {
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
            .find(|entry| entry.envelope.file_ref == ManagementProjectionFileRef::task("task:projection"))
            .expect("task entry");
        if let ManagementProjectionPayload::Task(task) = &mut task_entry.payload {
            task.title = "Incoming projection".to_owned();
            task.acceptance_criteria.push(nucleus_tasks::TaskStorageAcceptanceCriterion {
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
        assert_eq!(report.staged[0].validation.status, ManagementProjectionValidationStatus::Valid);
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
        let unsupported_ref =
            ManagementProjectionFileRef("nucleus/tasks/unsupported.toml".to_owned());
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
                    record_id: nucleus_engine::ManagementProjectionRecordId(
                        "task:future".to_owned(),
                    ),
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

    #[test]
    fn management_projection_apply_import_updates_targeted_records_without_scm_mutation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
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
        assert_eq!(decoded_task.title, "Applied projection");
    }

    #[test]
    fn management_projection_apply_import_requires_explicit_targets() {
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
                targets: Vec::new(),
                conflicts: Vec::new(),
            },
        )
        .expect("apply import");

        assert!(!report.authoritative_state_mutated);
        assert!(report.applied.is_empty());
        assert_eq!(report.blocked.len(), 1);
        assert_eq!(
            report.blocked[0].kind,
            ManagementProjectionApplyBlockKind::MissingApplyTarget
        );
    }

    #[test]
    fn management_projection_apply_import_blocks_stale_expected_revision() {
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
        assert_eq!(
            report.blocked[0].kind,
            ManagementProjectionApplyBlockKind::RevisionConflict
        );
        assert!(report.blocked[0].summary.contains("rev:stale"));
    }

    #[test]
    fn management_projection_apply_import_blocks_semantic_conflicts_with_evidence() {
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
        assert_eq!(
            report.blocked[0].kind,
            ManagementProjectionApplyBlockKind::SemanticConflict
        );
        assert_eq!(report.blocked[0].conflict, Some(conflict));
    }

    #[test]
    fn management_projection_apply_import_blocks_invalid_and_unsupported_staged_records() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
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
                schema_version: nucleus_engine::ManagementProjectionSchemaVersion(
                    "future".to_owned(),
                ),
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
            validation: nucleus_engine::validate_projection_envelope(
                &unsupported_doc.envelope,
                &[],
            ),
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
        assert!(report
            .blocked
            .iter()
            .any(|block| block.kind == ManagementProjectionApplyBlockKind::InvalidRecord));
        assert!(report
            .blocked
            .iter()
            .any(|block| block.kind == ManagementProjectionApplyBlockKind::UnsupportedSchema));
    }
