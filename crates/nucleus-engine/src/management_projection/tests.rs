use super::*;
use nucleus_projects::{ProjectStorageImportanceLevel, ProjectStorageRecord, ProjectStorageStatus};
use nucleus_tasks::{
    TaskStorageAcceptanceCriterion, TaskStorageActionType, TaskStorageActivityState,
    TaskStorageImportance, TaskStorageRecord,
};

    #[test]
    fn management_projection_names_first_shared_file_refs() {
        assert_eq!(ManagementProjectionRoot::default().relative_path, "nucleus");
        assert!(ManagementProjectionRoot::default().visible_by_default);
        assert_eq!(
            ManagementProjectionFileRef::project().0,
            "nucleus/project.toml"
        );
        assert_eq!(
            ManagementProjectionFileRef::repo_membership("repo:one").0,
            "nucleus/repos/repo:one.toml"
        );
        assert_eq!(
            ManagementProjectionFileRef::task("task:one").0,
            "nucleus/tasks/task:one.toml"
        );
        assert_eq!(
            ManagementProjectionFileRef::indexes_readme().0,
            "nucleus/indexes/README.md"
        );
        assert_eq!(
            ManagementProjectionFileRef::artifacts_readme().0,
            "nucleus/artifacts/README.md"
        );
    }

    #[test]
    fn management_projection_export_plan_contains_only_shared_project_task_state() {
        let project = ProjectStorageRecord {
            project_id: "project:nucleus".to_owned(),
            display_name: "Nucleus".to_owned(),
            status: ProjectStorageStatus::Active,
            importance_level: ProjectStorageImportanceLevel::High,
        };
        let task = TaskStorageRecord {
            task_id: "task:projection".to_owned(),
            project_id: "project:nucleus".to_owned(),
            title: "Export projection".to_owned(),
            description: Some("Export shared management state.".to_owned()),
            acceptance_criteria: vec![TaskStorageAcceptanceCriterion {
                text: "Plan is management-only".to_owned(),
                required: true,
            }],
            importance: TaskStorageImportance::High,
            action_type: TaskStorageActionType::Execute,
            activity: TaskStorageActivityState::Ready,
            assignment_intent: Some("agent:steward".to_owned()),
            agent_ready: true,
            required_context_refs: vec!["docs/contracts/011-scm-forge-sync-contract.md".to_owned()],
            allowed_actions: vec![TaskStorageActionType::Execute],
            stop_conditions: vec!["Stop before SCM mutation".to_owned()],
            validation_commands: vec!["cargo check --workspace".to_owned()],
        };

        let plan = export_project_task_projection(&[project], &[task]);
        let json = serde_json::to_string(&plan).expect("serialize plan");

        assert_eq!(plan.entries.len(), 2);
        assert!(json.contains("nucleus/project.toml"));
        assert!(json.contains("nucleus/tasks/task:projection.toml"));
        for forbidden in [
            "raw_stdout",
            "raw_stderr",
            "terminal_stream",
            "browser_state",
            "provider_auth",
            "client_layout",
            "global_display_window_surface",
            "per_project_panel",
            "secret",
        ] {
            assert!(!json.contains(forbidden), "projection leaked {forbidden}");
        }
    }

    #[test]
    fn management_projection_file_document_round_trips_project_and_task_entries() {
        let project = ProjectStorageRecord {
            project_id: "project:nucleus".to_owned(),
            display_name: "Nucleus".to_owned(),
            status: ProjectStorageStatus::Active,
            importance_level: ProjectStorageImportanceLevel::High,
        };
        let task = TaskStorageRecord {
            task_id: "task:projection".to_owned(),
            project_id: "project:nucleus".to_owned(),
            title: "Export projection".to_owned(),
            description: None,
            acceptance_criteria: Vec::new(),
            importance: TaskStorageImportance::Normal,
            action_type: TaskStorageActionType::Execute,
            activity: TaskStorageActivityState::Ready,
            assignment_intent: None,
            agent_ready: false,
            required_context_refs: Vec::new(),
            allowed_actions: vec![TaskStorageActionType::Execute],
            stop_conditions: Vec::new(),
            validation_commands: Vec::new(),
        };
        let plan = export_project_task_projection(&[project], &[task]);

        let documents = plan
            .entries
            .into_iter()
            .map(projection_file_document_from_entry)
            .collect::<Vec<_>>();
        let round_tripped = documents
            .iter()
            .map(|document| {
                let bytes =
                    encode_management_projection_file_document(document).expect("encode document");
                decode_management_projection_file_document(&bytes).expect("decode document")
            })
            .collect::<Vec<_>>();

        assert_eq!(round_tripped, documents);
        assert!(round_tripped.iter().all(|document| {
            document.envelope.schema_version == ManagementProjectionSchemaVersion::current()
        }));
        assert!(round_tripped.iter().any(|document| {
            document.envelope.file_ref == ManagementProjectionFileRef::project()
        }));
        assert!(round_tripped.iter().any(|document| {
            document.envelope.file_ref == ManagementProjectionFileRef::task("task:projection")
        }));
    }

    #[test]
    fn management_projection_file_document_preserves_explicit_unsupported_payloads() {
        let document = ManagementProjectionFileDocument {
            envelope: ManagementProjectionEnvelope {
                schema_version: ManagementProjectionSchemaVersion::current(),
                record_id: ManagementProjectionRecordId("future:1".to_owned()),
                record_kind: ManagementProjectionRecordKind::Custom("future_kind".to_owned()),
                file_ref: ManagementProjectionFileRef("nucleus/custom/future:1.json".to_owned()),
            },
            payload: ManagementProjectionPayload::Unsupported {
                payload_kind: "future_kind".to_owned(),
                retained_payload: "{\"field\":\"value\"}".to_owned(),
            },
        };

        let bytes = encode_management_projection_file_document(&document).expect("encode");
        let decoded = decode_management_projection_file_document(&bytes).expect("decode");

        assert_eq!(decoded, document);
        assert!(matches!(
            decoded.payload,
            ManagementProjectionPayload::Unsupported {
                payload_kind,
                retained_payload,
            } if payload_kind == "future_kind" && retained_payload.contains("field")
        ));
    }

    #[test]
    fn management_projection_file_codec_excludes_runtime_secret_and_layout_state() {
        let task = TaskStorageRecord {
            task_id: "task:safe".to_owned(),
            project_id: "project:nucleus".to_owned(),
            title: "Safe projection".to_owned(),
            description: Some("Only shared task intent is exported.".to_owned()),
            acceptance_criteria: Vec::new(),
            importance: TaskStorageImportance::Normal,
            action_type: TaskStorageActionType::Check,
            activity: TaskStorageActivityState::Ready,
            assignment_intent: Some("agent:steward".to_owned()),
            agent_ready: false,
            required_context_refs: Vec::new(),
            allowed_actions: vec![TaskStorageActionType::Check],
            stop_conditions: Vec::new(),
            validation_commands: vec!["effigy qa".to_owned()],
        };
        let entry = export_project_task_projection(&[], &[task])
            .entries
            .into_iter()
            .next()
            .expect("task entry");
        let document = projection_file_document_from_entry(entry);
        let bytes = encode_management_projection_file_document(&document).expect("encode");
        let toml = String::from_utf8(bytes).expect("toml");

        for forbidden in [
            "raw_stdout",
            "raw_stderr",
            "terminal_stream",
            "provider_auth",
            "provider_native_transcript",
            "live_runtime_event_stream",
            "browser_state",
            "client_layout",
            "global_display_window_surface",
            "per_project_panel",
            "secret",
            "local_cache",
        ] {
            assert!(!toml.contains(forbidden), "projection leaked {forbidden}");
        }
    }

    #[test]
    fn management_projection_validation_preserves_invalid_and_unsupported_records() {
        let invalid = ManagementProjectionEnvelope {
            schema_version: ManagementProjectionSchemaVersion::current(),
            record_id: ManagementProjectionRecordId(String::new()),
            record_kind: ManagementProjectionRecordKind::Task,
            file_ref: ManagementProjectionFileRef("outside/task.toml".to_owned()),
        };
        let unsupported = ManagementProjectionEnvelope {
            schema_version: ManagementProjectionSchemaVersion("future".to_owned()),
            record_id: ManagementProjectionRecordId("task:future".to_owned()),
            record_kind: ManagementProjectionRecordKind::Task,
            file_ref: ManagementProjectionFileRef::task("task:future"),
        };

        let invalid_report = validate_projection_envelope(
            &invalid,
            &[ManagementProjectionExcludedStateMarker::PerProjectPanelLayout],
        );
        let unsupported_report = validate_projection_envelope(&unsupported, &[]);

        assert_eq!(
            invalid_report.status,
            ManagementProjectionValidationStatus::Invalid
        );
        assert_eq!(
            unsupported_report.status,
            ManagementProjectionValidationStatus::UnsupportedSchema
        );
        assert!(invalid_report.issues.iter().any(|issue| {
            issue.kind == ManagementProjectionValidationIssueKind::ExcludedStatePresent
        }));
        assert_eq!(unsupported_report.record_id, Some(unsupported.record_id));
    }

    #[test]
    fn management_projection_conflict_reports_separate_schema_and_semantic_conflicts() {
        let schema = ManagementProjectionConflictReport {
            conflict_id: "conflict:schema:1".to_owned(),
            file_ref: ManagementProjectionFileRef::task("task:broken"),
            local_record_ref: None,
            incoming_record_ref: Some(ManagementProjectionRecordId("task:broken".to_owned())),
            class: ManagementProjectionConflictClass::Schema(
                ManagementProjectionSchemaConflictKind::InvalidRecordShape,
            ),
            summary: "invalid task record shape".to_owned(),
        };
        let semantic = ManagementProjectionConflictReport {
            conflict_id: "conflict:semantic:1".to_owned(),
            file_ref: ManagementProjectionFileRef::task("task:meaning"),
            local_record_ref: Some(ManagementProjectionRecordId("task:meaning".to_owned())),
            incoming_record_ref: Some(ManagementProjectionRecordId("task:meaning".to_owned())),
            class: ManagementProjectionConflictClass::Semantic(
                ManagementProjectionSemanticConflictKind::AcceptanceCriteriaRewrite,
            ),
            summary: "acceptance criteria changed meaning".to_owned(),
        };
        let unsupported = ManagementProjectionConflictReport {
            conflict_id: "conflict:unsupported:1".to_owned(),
            file_ref: ManagementProjectionFileRef("nucleus/custom/future.toml".to_owned()),
            local_record_ref: None,
            incoming_record_ref: Some(ManagementProjectionRecordId("future:1".to_owned())),
            class: ManagementProjectionConflictClass::Unsupported(
                ManagementProjectionUnsupportedConflictKind::UnsupportedSchemaPreserved,
            ),
            summary: "unsupported schema preserved for later migration".to_owned(),
        };
        let scm = ManagementProjectionConflictReport {
            conflict_id: "conflict:scm:1".to_owned(),
            file_ref: ManagementProjectionFileRef::task("task:changed"),
            local_record_ref: Some(ManagementProjectionRecordId("task:changed".to_owned())),
            incoming_record_ref: Some(ManagementProjectionRecordId("task:changed".to_owned())),
            class: ManagementProjectionConflictClass::Scm(
                ManagementProjectionScmConflictKind::FileChangedDuringImport,
            ),
            summary: "projection file changed while import was staged".to_owned(),
        };
        let reports = vec![schema, semantic, unsupported, scm];
        let replayed = reports.clone();
        let json = serde_json::to_string(&reports).expect("conflict json");

        assert_eq!(reports, replayed);
        assert!(json.contains("schema"));
        assert!(json.contains("semantic"));
        assert!(json.contains("unsupported"));
        assert!(json.contains("scm"));
        for forbidden in ["raw_stdout", "terminal_stream", "provider_auth", "secret"] {
            assert!(!json.contains(forbidden), "conflict leaked {forbidden}");
        }
    }
