use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_engine::{
    encode_task_seed_storage_record, EnginePlanningArtifactId, EnginePlanningReviewState,
    EngineTaskSeedAgentReadinessHints, EngineTaskSeedCandidateRecord, EngineTaskSeedId,
    EngineTaskSeedPromotionState,
};
use nucleus_local_store::{
    LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation, SqliteBackend,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::{AcceptanceCriterion, AgentReadiness, TaskActionType, TaskImportance};

use super::*;

fn task_seed(seed_id: &str, project_id: &str) -> EngineTaskSeedCandidateRecord {
    EngineTaskSeedCandidateRecord {
        seed_id: EngineTaskSeedId(seed_id.to_owned()),
        project_id: ProjectId(project_id.to_owned()),
        source_artifact_id: Some(EnginePlanningArtifactId("artifact:planning:1".to_owned())),
        title: "Persist planning task seeds".to_owned(),
        problem_statement: "Read-only query should inspect persisted task seeds.".to_owned(),
        suggested_action_type: TaskActionType::Plan,
        suggested_importance: TaskImportance::High,
        acceptance_criteria_draft: vec![AcceptanceCriterion {
            text: "Projection includes persisted task seed.".to_owned(),
            required: true,
        }],
        context_refs: vec!["context:planning:1".to_owned()],
        blocking_questions: Vec::new(),
        agent_readiness_hints: EngineTaskSeedAgentReadinessHints {
            suggested_readiness: AgentReadiness {
                ready_for_agent: false,
                required_context_refs: vec!["context:planning:1".to_owned()],
                allowed_actions: vec![TaskActionType::Plan],
                stop_conditions: Vec::new(),
                validation_commands: Vec::new(),
            },
            capability_hints: Vec::new(),
            validation_hint_refs: vec!["validation:planning:1".to_owned()],
        },
        review: EnginePlanningReviewState::ReviewRequested,
        promotion: EngineTaskSeedPromotionState::Reviewable,
    }
}

fn persist_task_seed(
    handler: &LocalControlRequestHandler<SqliteBackend>,
    record: &EngineTaskSeedCandidateRecord,
) {
    let payload = encode_task_seed_storage_record(record).expect("encode task seed");
    handler
        .state()
        .planning()
        .put(
            LocalStoreRecord {
                id: PersistenceRecordId(record.seed_id.0.clone()),
                domain: PersistenceDomain::Planning,
                kind: PersistenceRecordKind::TaskSeed,
                revision_id: RevisionId("rev:planning-task-seed:1".to_owned()),
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes: payload,
                },
            },
            RevisionExpectation::MustNotExist,
        )
        .expect("persist task seed");
}

#[test]
fn planning_task_seed_query_composes_project_scoped_persisted_candidates() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let handler = LocalControlRequestHandler::new(backend, None);

    persist_task_seed(&handler, &task_seed("seed:planning:1", "project:nucleus"));
    persist_task_seed(&handler, &task_seed("seed:planning:other", "project:other"));

    let result = planning_task_seeds_query(
        &handler,
        PlanningTaskSeedsQuery {
            project_id: ProjectId("project:nucleus".to_owned()),
        },
    )
    .expect("planning task seed query");

    assert!(matches!(
        result,
        ServerQueryResult::PlanningTaskSeeds(projection)
            if projection.project_id.0 == "project:nucleus"
                && projection.candidates.len() == 1
                && projection.candidates[0].seed_id.0 == "seed:planning:1"
                && projection.candidates[0].source_artifact_id.as_ref().map(|id| id.0.as_str())
                    == Some("artifact:planning:1")
                && !projection.client_can_promote
                && !projection.task_creation_performed
    ));
}

#[test]
fn planning_task_seed_query_reports_decode_failures_without_creating_tasks() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let handler = LocalControlRequestHandler::new(backend, None);

    handler
        .state()
        .planning()
        .put(
            LocalStoreRecord {
                id: PersistenceRecordId("seed:bad".to_owned()),
                domain: PersistenceDomain::Planning,
                kind: PersistenceRecordKind::TaskSeed,
                revision_id: RevisionId("rev:bad".to_owned()),
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes: b"{not-json".to_vec(),
                },
            },
            RevisionExpectation::MustNotExist,
        )
        .expect("persist bad seed");

    let error = planning_task_seeds_query(
        &handler,
        PlanningTaskSeedsQuery {
            project_id: ProjectId("project:nucleus".to_owned()),
        },
    )
    .expect_err("decode error");

    assert!(matches!(
        error,
        ServerControlError::StorageUnavailable { reason }
            if reason.contains("planning task seed decode failed")
    ));
    assert_eq!(handler.state().tasks().list().expect("tasks").len(), 0);
}
