use super::*;
use nucleus_engine::{
    ManagementProjectionEnvelope, ManagementProjectionFileDocument, ManagementProjectionPayload,
    ManagementProjectionPlanningArtifactBody, ManagementProjectionPlanningArtifactKind,
    ManagementProjectionPlanningArtifactRecord, ManagementProjectionPlanningArtifactStatus,
    ManagementProjectionPlanningReviewState, ManagementProjectionPlanningTaskSeedRecord,
    ManagementProjectionRecordKind, ManagementProjectionSchemaVersion,
    PlanningStorageAgentReadiness, PlanningStorageAgentReadinessHints,
    PlanningStorageTaskActionType, PlanningStorageTaskImportance,
    PlanningTaskSeedStoragePromotionState,
};

#[test]
fn planning_projection_import_scan_classifies_ready_artifact_and_task_seed_candidates() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let repo_root = temp_dir.path().join("repo");
    let artifact = planning_artifact_document("artifact:roadmap");
    let task_seed = planning_task_seed_document("seed:projection");
    write_projection_test_document(&repo_root, &artifact);
    write_projection_test_document(&repo_root, &task_seed);

    let report = scan_planning_projection_import_candidates(PlanningProjectionImportScanRequest {
        repo_root,
        file_refs: vec![
            artifact.envelope.file_ref.clone(),
            task_seed.envelope.file_ref.clone(),
        ],
    });

    assert_eq!(report.candidates.len(), 2);
    assert!(report.candidates.iter().all(|candidate| {
        candidate.status == PlanningProjectionImportScanCandidateStatus::Ready
            && candidate.blockers.is_empty()
            && candidate
                .evidence_refs
                .iter()
                .all(|evidence| evidence.starts_with("management-file-ref:nucleus/planning/"))
    }));
    assert!(report.candidates.iter().any(|candidate| {
        candidate.record_kind == Some(ManagementProjectionRecordKind::PlanningArtifact)
    }));
    assert!(report.candidates.iter().any(|candidate| {
        candidate.record_kind == Some(ManagementProjectionRecordKind::PlanningTaskSeed)
    }));
    assert_no_effects(&report);
}

#[test]
fn planning_projection_import_scan_blocks_unsupported_schema_and_record_kind() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let repo_root = temp_dir.path().join("repo");
    let mut future_schema = planning_artifact_document("artifact:future");
    future_schema.envelope.schema_version =
        ManagementProjectionSchemaVersion("future.schema".to_owned());
    let mut unsupported_kind = planning_artifact_document("artifact:project");
    unsupported_kind.envelope.record_kind = ManagementProjectionRecordKind::Project;
    unsupported_kind.payload = ManagementProjectionPayload::Index {
        title: "Not a planning payload".to_owned(),
    };
    write_projection_test_document(&repo_root, &future_schema);
    write_projection_test_document(&repo_root, &unsupported_kind);

    let report = scan_planning_projection_import_candidates(PlanningProjectionImportScanRequest {
        repo_root,
        file_refs: vec![
            future_schema.envelope.file_ref.clone(),
            unsupported_kind.envelope.file_ref.clone(),
        ],
    });

    assert_eq!(report.candidates.len(), 2);
    assert!(report.candidates.iter().any(|candidate| {
        matches!(
            candidate.blockers.as_slice(),
            [PlanningProjectionImportScanBlocker::UnsupportedSchema { .. }]
        )
    }));
    assert!(report.candidates.iter().any(|candidate| {
        matches!(
            candidate.blockers.as_slice(),
            [PlanningProjectionImportScanBlocker::UnsupportedRecordKind { .. }]
        )
    }));
    assert!(report
        .candidates
        .iter()
        .all(|candidate| candidate.status == PlanningProjectionImportScanCandidateStatus::Blocked));
    assert_no_effects(&report);
}

#[test]
fn planning_projection_import_scan_blocks_unsafe_paths_and_parse_failures() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let repo_root = temp_dir.path().join("repo");
    let parse_ref =
        ManagementProjectionFileRef::try_planning_artifact("artifact:broken").expect("file ref");
    let parse_path = scoped_projection_path(&repo_root, &parse_ref).expect("path");
    std::fs::create_dir_all(parse_path.parent().expect("parent")).expect("mkdir");
    std::fs::write(&parse_path, b"not = [valid").expect("write broken toml");
    let unsafe_ref = ManagementProjectionFileRef("nucleus/planning/../bad.toml".to_owned());

    let report = scan_planning_projection_import_candidates(PlanningProjectionImportScanRequest {
        repo_root,
        file_refs: vec![unsafe_ref, parse_ref],
    });

    assert_eq!(report.candidates.len(), 2);
    assert!(report.candidates.iter().any(|candidate| {
        matches!(
            candidate.blockers.as_slice(),
            [PlanningProjectionImportScanBlocker::UnsafePath { .. }]
        )
    }));
    assert!(report.candidates.iter().any(|candidate| {
        matches!(
            candidate.blockers.as_slice(),
            [PlanningProjectionImportScanBlocker::ParseFailed { .. }]
        )
    }));
    assert!(report
        .candidates
        .iter()
        .all(|candidate| candidate.status == PlanningProjectionImportScanCandidateStatus::Blocked));
    assert_no_effects(&report);
}

fn write_projection_test_document(
    repo_root: &std::path::Path,
    document: &ManagementProjectionFileDocument,
) {
    let path = scoped_projection_path(repo_root, &document.envelope.file_ref).expect("path");
    write_projection_document(document, &path).expect("write");
}

fn planning_artifact_document(artifact_id: &str) -> ManagementProjectionFileDocument {
    ManagementProjectionFileDocument {
        envelope: ManagementProjectionEnvelope {
            schema_version: ManagementProjectionSchemaVersion::current(),
            record_id: ManagementProjectionRecordId(artifact_id.to_owned()),
            record_kind: ManagementProjectionRecordKind::PlanningArtifact,
            file_ref: ManagementProjectionFileRef::try_planning_artifact(artifact_id)
                .expect("artifact file ref"),
        },
        payload: ManagementProjectionPayload::PlanningArtifact(
            ManagementProjectionPlanningArtifactRecord {
                artifact_id: artifact_id.to_owned(),
                project_id: "project:nucleus".to_owned(),
                artifact_kind: ManagementProjectionPlanningArtifactKind::RoadmapOutline,
                title: "Roadmap".to_owned(),
                body: ManagementProjectionPlanningArtifactBody::Text(
                    "Reviewed planning text.".to_owned(),
                ),
                status: ManagementProjectionPlanningArtifactStatus::Accepted,
                source_planning_session_ref: Some("planning-session:one".to_owned()),
                source_research_run_refs: Vec::new(),
                source_memory_refs: Vec::new(),
                supersedes: Vec::new(),
                superseded_by: Vec::new(),
                projection_ref: Some(format!("nucleus/planning/{artifact_id}.toml")),
                review: ManagementProjectionPlanningReviewState::Accepted {
                    reviewer_ref: "user:tom".to_owned(),
                },
            },
        ),
    }
}

fn planning_task_seed_document(seed_id: &str) -> ManagementProjectionFileDocument {
    ManagementProjectionFileDocument {
        envelope: ManagementProjectionEnvelope {
            schema_version: ManagementProjectionSchemaVersion::current(),
            record_id: ManagementProjectionRecordId(seed_id.to_owned()),
            record_kind: ManagementProjectionRecordKind::PlanningTaskSeed,
            file_ref: ManagementProjectionFileRef::try_planning_task_seed(seed_id)
                .expect("seed file ref"),
        },
        payload: ManagementProjectionPayload::PlanningTaskSeed(
            ManagementProjectionPlanningTaskSeedRecord {
                seed_id: seed_id.to_owned(),
                project_id: "project:nucleus".to_owned(),
                source_artifact_id: Some("artifact:roadmap".to_owned()),
                title: "Projection import".to_owned(),
                problem_statement: "Planning projection import needs scan candidates.".to_owned(),
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
                review: ManagementProjectionPlanningReviewState::ReviewRequested,
                promotion: PlanningTaskSeedStoragePromotionState::NotReady {
                    reason: "import review first".to_owned(),
                },
            },
        ),
    }
}

fn assert_no_effects(report: &PlanningProjectionImportScanReport) {
    assert!(!report.active_planning_mutation_performed);
    assert!(!report.task_creation_performed);
    assert!(!report.task_promotion_performed);
    assert!(!report.agent_scheduling_performed);
    assert!(!report.provider_execution_performed);
    assert!(!report.scm_mutation_performed);
    assert!(!report.forge_mutation_performed);
    assert!(!report.raw_payload_retained);
    assert!(!report.ui_apply_triggered);
}
