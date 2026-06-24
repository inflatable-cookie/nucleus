use nucleus_engine::{
    EnginePlanningReviewState, EngineTaskSeedAgentReadinessHints, EngineTaskSeedCandidateRecord,
    EngineTaskSeedId, EngineTaskSeedPromotionState,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::{AcceptanceCriterion, AgentReadiness, TaskActionType, TaskImportance};

use super::*;

fn seed(id: &str, promotion: EngineTaskSeedPromotionState) -> EngineTaskSeedCandidateRecord {
    EngineTaskSeedCandidateRecord {
        seed_id: EngineTaskSeedId(id.to_owned()),
        project_id: ProjectId("project:1".to_owned()),
        source_artifact_id: None,
        title: format!("Seed {id}"),
        problem_statement: "Private planning body is not exposed by diagnostics.".to_owned(),
        suggested_action_type: TaskActionType::Plan,
        suggested_importance: TaskImportance::Normal,
        acceptance_criteria_draft: vec![AcceptanceCriterion {
            text: "Diagnostics count seed state.".to_owned(),
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

#[test]
fn promotion_diagnostics_counts_sanitized_seed_states() {
    let mut rejected = seed(
        "seed:rejected",
        EngineTaskSeedPromotionState::NotReady {
            reason: "rejected".to_owned(),
        },
    );
    rejected.review = EnginePlanningReviewState::Rejected {
        reason: "wrong scope".to_owned(),
    };
    let mut blocked = seed("seed:blocked", EngineTaskSeedPromotionState::Reviewable);
    blocked.blocking_questions.push("Which repo?".to_owned());

    let diagnostics = planning_task_seed_promotion_diagnostics(
        ProjectId("project:1".to_owned()),
        vec![
            seed(
                "seed:ready",
                EngineTaskSeedPromotionState::ReadyForPromotion,
            ),
            seed(
                "seed:promoted:a",
                EngineTaskSeedPromotionState::Promoted {
                    task_ref: "task:promoted".to_owned(),
                },
            ),
            seed(
                "seed:promoted:b",
                EngineTaskSeedPromotionState::Promoted {
                    task_ref: "task:promoted".to_owned(),
                },
            ),
            rejected,
            blocked,
        ],
        |task_ref| task_ref == "task:promoted",
    );

    assert_eq!(diagnostics.task_seed_records, 5);
    assert_eq!(diagnostics.ready_count, 1);
    assert_eq!(diagnostics.promoted_count, 2);
    assert_eq!(diagnostics.rejected_count, 1);
    assert_eq!(diagnostics.blocked_count, 1);
    assert_eq!(diagnostics.duplicate_promoted_task_ref_count, 2);
    assert_eq!(diagnostics.missing_promoted_task_ref_count, 0);
    assert!(!diagnostics.client_can_mutate);
    assert!(!diagnostics.task_creation_performed);
    assert!(!diagnostics.provider_execution_performed);
    assert!(!diagnostics.raw_planning_body_exposed);
    assert!(diagnostics
        .entries
        .iter()
        .all(|entry| entry.seed_id.starts_with("seed:")));
}
