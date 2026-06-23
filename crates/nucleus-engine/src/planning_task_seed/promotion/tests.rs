use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::{AcceptanceCriterion, AgentReadiness, TaskActionType, TaskImportance};

use super::*;
use crate::EngineTaskSeedAgentReadinessHints;

fn command() -> EngineTaskSeedPromotionCommand {
    EngineTaskSeedPromotionCommand {
        command_id: "promotion:seed:1".to_owned(),
        project_id: ProjectId("project:1".to_owned()),
        seed_id: EngineTaskSeedId("seed:1".to_owned()),
        expected_seed_revision: Some(RevisionId("rev:seed:1".to_owned())),
        destination_task_id: Some(TaskId("task:promotion:seed:1".to_owned())),
    }
}

fn accepted_seed() -> EngineTaskSeedCandidateRecord {
    EngineTaskSeedCandidateRecord {
        seed_id: EngineTaskSeedId("seed:1".to_owned()),
        project_id: ProjectId("project:1".to_owned()),
        source_artifact_id: Some(EnginePlanningArtifactId("artifact:planning:1".to_owned())),
        title: "Promote planning task seed".to_owned(),
        problem_statement: "Turn accepted planning output into a proposed task.".to_owned(),
        suggested_action_type: TaskActionType::Plan,
        suggested_importance: TaskImportance::Normal,
        acceptance_criteria_draft: vec![AcceptanceCriterion {
            text: "Task is created through task-domain storage.".to_owned(),
            required: true,
        }],
        context_refs: vec!["planning:context:1".to_owned()],
        blocking_questions: Vec::new(),
        agent_readiness_hints: EngineTaskSeedAgentReadinessHints {
            suggested_readiness: AgentReadiness {
                ready_for_agent: false,
                required_context_refs: vec!["planning:context:1".to_owned()],
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
        promotion: EngineTaskSeedPromotionState::ReadyForPromotion,
    }
}

#[test]
fn task_seed_promotion_admits_accepted_ready_seed() {
    let outcome = admit_task_seed_promotion(command(), &accepted_seed());

    let admission = match outcome {
        EngineTaskSeedPromotionOutcome::Admitted(admission) => admission,
        other => panic!("expected admitted outcome, got {other:?}"),
    };

    assert_eq!(
        admission.task_id,
        TaskId("task:promotion:seed:1".to_owned())
    );
    assert_eq!(admission.create_command.title, "Promote planning task seed");
    assert_eq!(
        admission.create_command.description.as_deref(),
        Some("Turn accepted planning output into a proposed task.")
    );
    assert_eq!(
        admission.create_command.activity,
        TaskActivityState::Proposed
    );
    assert_eq!(admission.create_command.acceptance_criteria.len(), 1);
    assert!(admission.provider_execution_deferred);
    assert!(!admission.task_creation_performed);
}

#[test]
fn task_seed_promotion_blocks_review_requested_seed() {
    let mut seed = accepted_seed();
    seed.review = EnginePlanningReviewState::ReviewRequested;
    seed.promotion = EngineTaskSeedPromotionState::Reviewable;

    let outcome = admit_task_seed_promotion(command(), &seed);

    assert!(matches!(
        outcome,
        EngineTaskSeedPromotionOutcome::Blocked { reasons, .. }
            if reasons.iter().any(|reason| reason == "task seed is awaiting review")
                && reasons.iter().any(|reason| reason == "task seed must be explicitly marked ready for promotion")
    ));
}

#[test]
fn task_seed_promotion_blocks_rejected_seed() {
    let mut seed = accepted_seed();
    seed.review = EnginePlanningReviewState::Rejected {
        reason: "wrong scope".to_owned(),
    };

    let outcome = admit_task_seed_promotion(command(), &seed);

    assert!(matches!(
        outcome,
        EngineTaskSeedPromotionOutcome::Blocked { reasons, .. }
            if reasons.iter().any(|reason| reason == "task seed was rejected: wrong scope")
    ));
}

#[test]
fn task_seed_promotion_blocks_seed_with_questions() {
    let mut seed = accepted_seed();
    seed.blocking_questions
        .push("Which repository owns the change?".to_owned());

    let outcome = admit_task_seed_promotion(command(), &seed);

    assert!(matches!(
        outcome,
        EngineTaskSeedPromotionOutcome::Blocked { reasons, .. }
            if reasons.iter().any(|reason| reason == "blocking question: Which repository owns the change?")
    ));
}

#[test]
fn task_seed_promotion_reports_already_promoted_seed_without_creation() {
    let mut seed = accepted_seed();
    seed.promotion = EngineTaskSeedPromotionState::Promoted {
        task_ref: "task:promotion:seed:1".to_owned(),
    };

    let outcome = admit_task_seed_promotion(command(), &seed);

    assert!(matches!(
        outcome,
        EngineTaskSeedPromotionOutcome::AlreadyPromoted { task_ref, .. }
            if task_ref == "task:promotion:seed:1"
    ));
}

#[test]
fn task_seed_promotion_rejects_destination_task_id_mismatch() {
    let mut command = command();
    command.destination_task_id = Some(TaskId("task:other".to_owned()));

    let outcome = admit_task_seed_promotion(command, &accepted_seed());

    assert!(matches!(
        outcome,
        EngineTaskSeedPromotionOutcome::Conflict { reason }
            if reason.contains("destination task id does not match promotion command id")
    ));
}
