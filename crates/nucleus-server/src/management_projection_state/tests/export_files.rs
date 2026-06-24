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
        issues: Vec::new(),
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

#[test]
fn planning_projection_export_writes_scoped_planning_files_without_scm_mutation() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let repo_root = temp_dir.path().join("repo");
    let plan = nucleus_engine::export_project_planning_projection(
        &[planning_artifact("artifact:roadmap")],
        &[planning_task_seed("seed:projection")],
    );

    let report =
        write_planning_management_projection_export_files(ManagementProjectionExportFileRequest {
            repo_root: repo_root.clone(),
            plan,
            overwrite_existing: false,
        })
        .expect("write planning projection files");

    assert!(!report.scm_mutation_performed);
    assert_eq!(report.writes.len(), 2);
    assert!(repo_root
        .join("nucleus/planning/artifact:roadmap.toml")
        .exists());
    assert!(repo_root
        .join("nucleus/planning/task-seeds/seed:projection.toml")
        .exists());

    let seed_file =
        std::fs::read_to_string(repo_root.join("nucleus/planning/task-seeds/seed:projection.toml"))
            .expect("seed file");
    assert!(seed_file.contains("planning_task_seed"));
    assert!(!seed_file.contains("kind = \"task\""));
    for forbidden in ["provider_auth", "raw_provider_payload", "secret"] {
        assert!(
            !seed_file.contains(forbidden),
            "projection leaked {forbidden}"
        );
    }
}

#[test]
fn planning_projection_file_write_diagnostics_count_materialized_files() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let repo_root = temp_dir.path().join("repo");
    let plan = nucleus_engine::export_project_planning_projection(
        &[planning_artifact("artifact:roadmap")],
        &[planning_task_seed("seed:projection")],
    );
    let report =
        write_planning_management_projection_export_files(ManagementProjectionExportFileRequest {
            repo_root,
            plan: plan.clone(),
            overwrite_existing: false,
        })
        .expect("write planning projection files");

    let diagnostics = planning_projection_file_write_diagnostics(&plan, Some(&report));
    let debug = format!("{diagnostics:?}");

    assert_eq!(diagnostics.materialized_planning_artifact_files, 1);
    assert_eq!(diagnostics.materialized_planning_task_seed_files, 1);
    assert_eq!(diagnostics.invalid_ref_count, 0);
    assert_eq!(diagnostics.unsupported_record_count, 0);
    assert_eq!(diagnostics.encode_failure_count, 0);
    assert_eq!(diagnostics.skipped_write_count, 0);
    assert!(diagnostics.issues.is_empty());
    assert!(!diagnostics.import_or_apply_authority);
    assert!(!diagnostics.scm_mutation_authority);
    assert!(!debug.contains("raw_provider_payload"));
    assert!(!debug.contains("credential"));
}

#[test]
fn planning_projection_file_write_diagnostics_count_blocked_writes() {
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
    let non_planning_plan = build_management_projection_export_plan(&state).expect("project plan");
    let unresolved_issue_plan = nucleus_engine::export_project_planning_projection(
        &[planning_artifact("../artifact")],
        &[planning_task_seed("seed:projection")],
    );

    let non_planning_diagnostics =
        planning_projection_file_write_diagnostics(&non_planning_plan, None);
    let unresolved_issue_diagnostics =
        planning_projection_file_write_diagnostics(&unresolved_issue_plan, None);

    assert_eq!(non_planning_diagnostics.unsupported_record_count, 1);
    assert_eq!(non_planning_diagnostics.skipped_write_count, 1);
    assert!(non_planning_diagnostics.issues.iter().any(|issue| {
        issue.class == PlanningProjectionFileWriteDiagnosticIssueClass::UnsupportedRecord
            && issue.file_ref == Some(ManagementProjectionFileRef::project())
    }));

    assert_eq!(unresolved_issue_diagnostics.invalid_ref_count, 1);
    assert_eq!(unresolved_issue_diagnostics.skipped_write_count, 0);
    assert!(unresolved_issue_diagnostics.issues.iter().any(|issue| {
        issue.class == PlanningProjectionFileWriteDiagnosticIssueClass::InvalidRef
            && issue
                .summary
                .contains("unsafe management projection file id")
    }));
    assert!(!unresolved_issue_diagnostics.import_or_apply_authority);
    assert!(!unresolved_issue_diagnostics.scm_mutation_authority);
}

#[test]
fn planning_projection_export_blocks_unresolved_export_issues_before_writes() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let repo_root = temp_dir.path().join("repo");
    let plan = nucleus_engine::export_project_planning_projection(
        &[planning_artifact("../artifact")],
        &[planning_task_seed("seed:projection")],
    );

    let error =
        write_planning_management_projection_export_files(ManagementProjectionExportFileRequest {
            repo_root: repo_root.clone(),
            plan,
            overwrite_existing: false,
        })
        .expect_err("unresolved issues should block writes");

    assert!(matches!(
        error,
        LocalStoreError::TransactionRejected { reason }
            if reason == "planning projection export has unresolved issues: 1"
    ));
    assert!(!repo_root.exists());
}

#[test]
fn planning_projection_export_rejects_non_planning_entries() {
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
    let plan = build_management_projection_export_plan(&state).expect("project export plan");

    let error =
        write_planning_management_projection_export_files(ManagementProjectionExportFileRequest {
            repo_root: temp_dir.path().join("repo"),
            plan,
            overwrite_existing: false,
        })
        .expect_err("non-planning entries should be rejected");

    assert!(matches!(
        error,
        LocalStoreError::UnsupportedRecordKind { reason }
            if reason == "planning projection export accepts only planning artifact and planning task seed records"
    ));
}

fn planning_artifact(id: &str) -> nucleus_engine::EnginePlanningArtifactRecord {
    nucleus_engine::EnginePlanningArtifactRecord {
        artifact_id: nucleus_engine::EnginePlanningArtifactId(id.to_owned()),
        project_id: nucleus_projects::ProjectId("project:nucleus".to_owned()),
        kind: nucleus_engine::EnginePlanningArtifactKind::RoadmapOutline,
        title: "Roadmap outline".to_owned(),
        body: nucleus_engine::EnginePlanningArtifactBody::Text(
            "Accepted planning projection content.".to_owned(),
        ),
        status: nucleus_engine::EnginePlanningArtifactStatus::Accepted,
        source_planning_session_ref: Some(nucleus_engine::EnginePlanningSessionId(
            "planning-session:one".to_owned(),
        )),
        source_research_run_refs: Vec::new(),
        source_memory_refs: Vec::new(),
        supersedes: Vec::new(),
        superseded_by: Vec::new(),
        projection_ref: None,
        review: nucleus_engine::EnginePlanningReviewState::Accepted {
            reviewer_ref: "user:tom".to_owned(),
        },
    }
}

fn planning_task_seed(id: &str) -> nucleus_engine::EngineTaskSeedCandidateRecord {
    nucleus_engine::EngineTaskSeedCandidateRecord {
        seed_id: nucleus_engine::EngineTaskSeedId(id.to_owned()),
        project_id: nucleus_projects::ProjectId("project:nucleus".to_owned()),
        source_artifact_id: Some(nucleus_engine::EnginePlanningArtifactId(
            "artifact:roadmap".to_owned(),
        )),
        title: "Write planning projection files".to_owned(),
        problem_statement: "Planning projection needs deterministic files.".to_owned(),
        suggested_action_type: TaskActionType::Plan,
        suggested_importance: TaskImportance::High,
        acceptance_criteria_draft: vec![nucleus_tasks::AcceptanceCriterion {
            text: "Projection file is scoped".to_owned(),
            required: true,
        }],
        context_refs: Vec::new(),
        blocking_questions: Vec::new(),
        agent_readiness_hints: nucleus_engine::EngineTaskSeedAgentReadinessHints {
            suggested_readiness: nucleus_tasks::AgentReadiness {
                ready_for_agent: true,
                required_context_refs: Vec::new(),
                allowed_actions: vec![TaskActionType::Plan],
                stop_conditions: Vec::new(),
                validation_commands: Vec::new(),
            },
            capability_hints: Vec::new(),
            validation_hint_refs: Vec::new(),
        },
        review: nucleus_engine::EnginePlanningReviewState::Accepted {
            reviewer_ref: "user:tom".to_owned(),
        },
        promotion: nucleus_engine::EngineTaskSeedPromotionState::ReadyForPromotion,
    }
}
