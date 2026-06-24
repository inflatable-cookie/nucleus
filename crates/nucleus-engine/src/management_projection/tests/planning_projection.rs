use crate::{
    decode_management_projection_file_document, encode_management_projection_file_document,
    export_project_planning_projection, planning_projection_export_diagnostics,
    validate_projection_file_document, EnginePlanningArtifactBody, EnginePlanningArtifactId,
    EnginePlanningArtifactKind, EnginePlanningArtifactRecord, EnginePlanningArtifactStatus,
    EnginePlanningReviewState, EnginePlanningSessionId, EngineTaskSeedAgentReadinessHints,
    EngineTaskSeedCandidateRecord, EngineTaskSeedId, EngineTaskSeedPromotionState,
    ManagementProjectionEnvelope, ManagementProjectionExportIssueKind,
    ManagementProjectionFileDocument, ManagementProjectionFileRef, ManagementProjectionPayload,
    ManagementProjectionPlanningReviewState, ManagementProjectionPlanningTaskSeedRecord,
    ManagementProjectionRecordId, ManagementProjectionRecordKind,
    ManagementProjectionSchemaVersion, ManagementProjectionValidationIssueKind,
    ManagementProjectionValidationStatus, PlanningStorageAgentReadiness,
    PlanningStorageAgentReadinessHints, PlanningStorageTaskActionType,
    PlanningStorageTaskImportance, PlanningTaskSeedStoragePromotionState,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::{AcceptanceCriterion, AgentReadiness, TaskActionType, TaskImportance};

#[test]
fn management_projection_file_document_round_trips_planning_payloads() {
    let artifact = planning_artifact("artifact:roadmap");
    let seed = planning_task_seed("seed:projection");
    let plan = export_project_planning_projection(&[artifact], &[seed]);
    let documents = plan
        .entries
        .into_iter()
        .map(crate::projection_file_document_from_entry)
        .collect::<Vec<_>>();

    for document in documents {
        let bytes = encode_management_projection_file_document(&document).expect("encode");
        let toml = String::from_utf8(bytes.clone()).expect("toml");
        let decoded = decode_management_projection_file_document(&bytes).expect("decode");
        let report = validate_projection_file_document(&decoded, &[]);

        assert_eq!(decoded, document);
        assert_eq!(report.status, ManagementProjectionValidationStatus::Valid);
        assert!(toml.contains("planning_artifact") || toml.contains("planning_task_seed"));
        assert!(!toml.contains("kind = \"task\""));
        for forbidden in [
            "raw_transcript",
            "raw_provider_payload",
            "credential",
            "browser_cache",
            "restricted_memory",
            "private_brainstorming",
        ] {
            assert!(!toml.contains(forbidden), "projection leaked {forbidden}");
        }
    }
}

#[test]
fn management_projection_export_plan_contains_planning_records_without_task_mutation() {
    let artifact = planning_artifact("artifact:roadmap");
    let seed = planning_task_seed("seed:projection");

    let plan = export_project_planning_projection(&[artifact], &[seed]);
    let file_refs = plan
        .entries
        .iter()
        .map(|entry| entry.envelope.file_ref.0.clone())
        .collect::<Vec<_>>();
    let json = serde_json::to_string(&plan).expect("planning export json");

    assert!(plan.issues.is_empty());
    assert_eq!(
        file_refs,
        vec![
            "nucleus/planning/artifact:roadmap.toml".to_owned(),
            "nucleus/planning/task-seeds/seed:projection.toml".to_owned()
        ]
    );
    assert!(plan.entries.iter().any(|entry| {
        entry.envelope.record_kind == ManagementProjectionRecordKind::PlanningArtifact
    }));
    assert!(plan.entries.iter().any(|entry| {
        entry.envelope.record_kind == ManagementProjectionRecordKind::PlanningTaskSeed
    }));
    assert!(!json.contains("kind = \"task\""));
    assert!(!json.contains("raw_provider_payload"));
    assert!(!json.contains("credential"));
}

#[test]
fn management_projection_export_plan_reports_invalid_planning_file_refs() {
    let artifact = planning_artifact("../artifact");
    let seed = planning_task_seed("seed/unsafe");

    let plan = export_project_planning_projection(&[artifact], &[seed]);

    assert!(plan.entries.is_empty());
    assert_eq!(plan.issues.len(), 2);
    assert!(plan
        .issues
        .iter()
        .all(|issue| issue.kind == ManagementProjectionExportIssueKind::InvalidFileRef));
    assert!(plan.issues.iter().any(|issue| {
        issue.field.as_deref() == Some("artifact_id")
            && issue
                .summary
                .contains("unsafe management projection file id")
    }));
    assert!(plan
        .issues
        .iter()
        .any(|issue| issue.field.as_deref() == Some("seed_id")));
}

#[test]
fn management_projection_planning_export_diagnostics_are_read_only() {
    let exportable_artifact = planning_artifact("artifact:roadmap");
    let blocked_artifact = planning_artifact("../artifact");
    let exportable_seed = planning_task_seed("seed:projection");

    let plan = export_project_planning_projection(
        &[exportable_artifact, blocked_artifact],
        &[exportable_seed],
    );
    let diagnostics = planning_projection_export_diagnostics(&plan);
    let json = serde_json::to_string(&diagnostics).expect("diagnostics json");

    assert_eq!(diagnostics.exportable_planning_artifacts, 1);
    assert_eq!(diagnostics.exportable_planning_task_seeds, 1);
    assert_eq!(diagnostics.blocked_records, 1);
    assert_eq!(diagnostics.unsupported_records, 0);
    assert_eq!(diagnostics.decode_failed_records, 0);
    assert!(!diagnostics.file_write_authority);
    assert!(!diagnostics.scm_mutation_authority);
    assert!(!json.contains("credential"));
    assert!(!json.contains("raw_provider_payload"));
}

#[test]
fn management_projection_validates_planning_record_kind_mismatches() {
    let document = ManagementProjectionFileDocument {
        envelope: ManagementProjectionEnvelope {
            schema_version: ManagementProjectionSchemaVersion::current(),
            record_id: ManagementProjectionRecordId("seed:projection".to_owned()),
            record_kind: ManagementProjectionRecordKind::Task,
            file_ref: ManagementProjectionFileRef::try_planning_task_seed("seed:projection")
                .expect("seed file ref"),
        },
        payload: ManagementProjectionPayload::PlanningTaskSeed(
            ManagementProjectionPlanningTaskSeedRecord {
                seed_id: "seed:projection".to_owned(),
                project_id: "project:nucleus".to_owned(),
                source_artifact_id: None,
                title: "Seed".to_owned(),
                problem_statement: "Seed problem".to_owned(),
                suggested_action_type: PlanningStorageTaskActionType::Plan,
                suggested_importance: PlanningStorageTaskImportance::Normal,
                acceptance_criteria_draft: Vec::new(),
                context_refs: Vec::new(),
                blocking_questions: Vec::new(),
                agent_readiness_hints: PlanningStorageAgentReadinessHints {
                    suggested_readiness: PlanningStorageAgentReadiness {
                        ready_for_agent: false,
                        required_context_refs: Vec::new(),
                        allowed_actions: vec![PlanningStorageTaskActionType::Plan],
                        stop_conditions: Vec::new(),
                        validation_commands: Vec::new(),
                    },
                    capability_hints: Vec::new(),
                    validation_hint_refs: Vec::new(),
                },
                review: ManagementProjectionPlanningReviewState::Draft,
                promotion: PlanningTaskSeedStoragePromotionState::NotReady {
                    reason: "review first".to_owned(),
                },
            },
        ),
    };

    let report = validate_projection_file_document(&document, &[]);

    assert_eq!(report.status, ManagementProjectionValidationStatus::Invalid);
    assert!(report.issues.iter().any(|issue| {
        issue.kind == ManagementProjectionValidationIssueKind::MismatchedRecordKind
    }));
}

#[test]
fn management_projection_file_document_rejects_unknown_record_kind() {
    let document = br#"
[envelope]
schema_version = "nucleus.management_projection.v1"
record_id = "seed:unknown-kind"
record_kind = "unknown_planning_kind"
file_ref = "nucleus/planning/task-seeds/seed:unknown-kind.toml"

[payload]
kind = "planning_task_seed"
"#;

    let error = decode_management_projection_file_document(document).expect_err("decode error");

    assert!(error.reason.contains("unknown variant"));
}

fn planning_artifact(artifact_id: &str) -> EnginePlanningArtifactRecord {
    EnginePlanningArtifactRecord {
        artifact_id: EnginePlanningArtifactId(artifact_id.to_owned()),
        project_id: ProjectId("project:nucleus".to_owned()),
        kind: EnginePlanningArtifactKind::RoadmapOutline,
        title: "Roadmap outline".to_owned(),
        body: EnginePlanningArtifactBody::Text("Accepted shared planning text.".to_owned()),
        status: EnginePlanningArtifactStatus::Accepted,
        source_planning_session_ref: Some(EnginePlanningSessionId(
            "planning-session:one".to_owned(),
        )),
        source_research_run_refs: vec!["research:shape".to_owned()],
        source_memory_refs: vec!["memory:accepted-context".to_owned()],
        supersedes: vec![EnginePlanningArtifactId("artifact:old".to_owned())],
        superseded_by: Vec::new(),
        projection_ref: Some(format!("nucleus/planning/{artifact_id}.toml")),
        review: EnginePlanningReviewState::Accepted {
            reviewer_ref: "user:tom".to_owned(),
        },
    }
}

fn planning_task_seed(seed_id: &str) -> EngineTaskSeedCandidateRecord {
    EngineTaskSeedCandidateRecord {
        seed_id: EngineTaskSeedId(seed_id.to_owned()),
        project_id: ProjectId("project:nucleus".to_owned()),
        source_artifact_id: Some(EnginePlanningArtifactId("artifact:roadmap".to_owned())),
        title: "Project planning state".to_owned(),
        problem_statement: "Planning state needs a shared projection payload.".to_owned(),
        suggested_action_type: TaskActionType::Plan,
        suggested_importance: TaskImportance::High,
        acceptance_criteria_draft: vec![AcceptanceCriterion {
            text: "Task seed is not encoded as a task".to_owned(),
            required: true,
        }],
        context_refs: vec!["docs/contracts/014-structured-project-planning-contract.md".to_owned()],
        blocking_questions: Vec::new(),
        agent_readiness_hints: EngineTaskSeedAgentReadinessHints {
            suggested_readiness: AgentReadiness {
                ready_for_agent: true,
                required_context_refs: vec![
                    "docs/architecture/planning-management-projection-shape.md".to_owned(),
                ],
                allowed_actions: vec![TaskActionType::Plan],
                stop_conditions: vec!["Stop before projection import".to_owned()],
                validation_commands: vec![
                    "cargo test -p nucleus-engine management_projection".to_owned()
                ],
            },
            capability_hints: vec!["rust".to_owned()],
            validation_hint_refs: vec!["validation:codec".to_owned()],
        },
        review: EnginePlanningReviewState::ReviewRequested,
        promotion: EngineTaskSeedPromotionState::ReadyForPromotion,
    }
}
