use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_engine::{
    encode_task_seed_storage_record, EnginePlanningReviewState, EngineTaskSeedAgentReadinessHints,
    EngineTaskSeedCandidateRecord, EngineTaskSeedId, EngineTaskSeedPromotionState,
};
use nucleus_local_store::{
    LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation, SqliteBackend,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::{AcceptanceCriterion, AgentReadiness, TaskActionType, TaskImportance};

use super::*;
use crate::task_seed::{seed_local_task, LocalTaskSeed};

fn task_seed(
    seed_id: &str,
    promotion: EngineTaskSeedPromotionState,
) -> EngineTaskSeedCandidateRecord {
    EngineTaskSeedCandidateRecord {
        seed_id: EngineTaskSeedId(seed_id.to_owned()),
        project_id: ProjectId("project:nucleus".to_owned()),
        source_artifact_id: None,
        title: "Task seed diagnostics".to_owned(),
        problem_statement: "Diagnostics should not expose this body.".to_owned(),
        suggested_action_type: TaskActionType::Plan,
        suggested_importance: TaskImportance::Normal,
        acceptance_criteria_draft: vec![AcceptanceCriterion {
            text: "Diagnostics count persisted records.".to_owned(),
            required: true,
        }],
        context_refs: vec!["private:context".to_owned()],
        blocking_questions: Vec::new(),
        agent_readiness_hints: EngineTaskSeedAgentReadinessHints {
            suggested_readiness: AgentReadiness {
                ready_for_agent: false,
                required_context_refs: Vec::new(),
                allowed_actions: vec![TaskActionType::Plan],
                stop_conditions: Vec::new(),
                validation_commands: Vec::new(),
            },
            capability_hints: Vec::new(),
            validation_hint_refs: Vec::new(),
        },
        review: EnginePlanningReviewState::Accepted {
            reviewer_ref: "user:tom".to_owned(),
        },
        promotion,
    }
}

fn persist_task_seed(
    handler: &LocalControlRequestHandler<SqliteBackend>,
    record: &EngineTaskSeedCandidateRecord,
) {
    handler
        .state()
        .planning()
        .put(
            LocalStoreRecord {
                id: PersistenceRecordId(record.seed_id.0.clone()),
                domain: PersistenceDomain::Planning,
                kind: PersistenceRecordKind::TaskSeed,
                revision_id: RevisionId(format!("rev:{}", record.seed_id.0)),
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes: encode_task_seed_storage_record(record).expect("encode seed"),
                },
            },
            RevisionExpectation::MustNotExist,
        )
        .expect("persist seed");
}

#[test]
fn promotion_diagnostics_query_counts_persisted_seed_states() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let handler = LocalControlRequestHandler::new(backend, None);

    seed_local_task(
        handler.state(),
        LocalTaskSeed {
            task_id: "task:promoted".to_owned(),
            project_id: "project:nucleus".to_owned(),
            title: "Promoted task".to_owned(),
            action_type: TaskActionType::Plan,
            importance: TaskImportance::Normal,
        },
    )
    .expect("seed promoted task");
    persist_task_seed(
        &handler,
        &task_seed(
            "seed:ready",
            EngineTaskSeedPromotionState::ReadyForPromotion,
        ),
    );
    persist_task_seed(
        &handler,
        &task_seed(
            "seed:promoted",
            EngineTaskSeedPromotionState::Promoted {
                task_ref: "task:promoted".to_owned(),
            },
        ),
    );
    persist_task_seed(
        &handler,
        &task_seed(
            "seed:missing",
            EngineTaskSeedPromotionState::Promoted {
                task_ref: "task:missing".to_owned(),
            },
        ),
    );

    let result = task_seed_promotion_diagnostics_query(
        &handler,
        TaskSeedPromotionDiagnosticsQuery {
            project_id: ProjectId("project:nucleus".to_owned()),
        },
    )
    .expect("diagnostics query");

    assert!(matches!(
        result,
        ServerQueryResult::TaskSeedPromotionDiagnostics(diagnostics)
            if diagnostics.task_seed_records == 3
                && diagnostics.ready_count == 1
                && diagnostics.promoted_count == 2
                && diagnostics.missing_promoted_task_ref_count == 1
                && !diagnostics.client_can_mutate
                && !diagnostics.task_creation_performed
                && !diagnostics.raw_planning_body_exposed
    ));
}
