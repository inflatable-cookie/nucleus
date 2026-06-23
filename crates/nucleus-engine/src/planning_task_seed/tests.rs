use super::*;

fn seed(id: &str, promotion: EngineTaskSeedPromotionState) -> EngineTaskSeedCandidateRecord {
    EngineTaskSeedCandidateRecord {
        seed_id: EngineTaskSeedId(id.to_owned()),
        project_id: ProjectId("project:1".to_owned()),
        source_artifact_id: Some(EnginePlanningArtifactId("artifact:planning:1".to_owned())),
        title: format!("Seed {id}"),
        problem_statement: "Turn planning output into an actionable task.".to_owned(),
        suggested_action_type: TaskActionType::Plan,
        suggested_importance: TaskImportance::Normal,
        acceptance_criteria_draft: vec![AcceptanceCriterion {
            text: "Candidate can be reviewed without creating a task.".to_owned(),
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
            validation_hint_refs: vec!["validation:hint:1".to_owned()],
        },
        review: EnginePlanningReviewState::ReviewRequested,
        promotion,
    }
}

#[test]
fn task_seed_projection_is_read_only_and_does_not_create_tasks() {
    let mut blocked = seed(
        "seed:blocked",
        EngineTaskSeedPromotionState::NotReady {
            reason: "needs scope".to_owned(),
        },
    );
    blocked
        .blocking_questions
        .push("Which repo owns this work?".to_owned());

    let projection = EngineTaskSeedCandidateProjection::from_records(
        ProjectId("project:1".to_owned()),
        vec![
            seed(
                "seed:ready",
                EngineTaskSeedPromotionState::ReadyForPromotion,
            ),
            blocked,
            seed(
                "seed:promoted",
                EngineTaskSeedPromotionState::Promoted {
                    task_ref: "task:1".to_owned(),
                },
            ),
        ],
    );

    assert!(!projection.client_can_promote);
    assert!(!projection.task_creation_performed);
    assert_eq!(projection.candidates.len(), 3);
    assert_eq!(projection.source_counts.task_seed_records, 3);
    assert_eq!(projection.source_counts.source_artifact_refs, 3);
    assert_eq!(projection.source_counts.context_refs, 3);
    assert_eq!(projection.source_counts.validation_hint_refs, 3);
    assert!(projection
        .candidates
        .iter()
        .any(|candidate| candidate.readiness == EngineTaskSeedReadinessClass::ReadyForPromotion));
    assert!(projection
        .candidates
        .iter()
        .any(|candidate| candidate.readiness == EngineTaskSeedReadinessClass::Promoted));
    assert!(projection
        .candidates
        .iter()
        .any(|candidate| candidate.readiness == EngineTaskSeedReadinessClass::Blocked));
}

#[test]
fn task_seed_projection_filters_by_project_and_sorts_by_seed_id() {
    let mut other = seed("seed:other", EngineTaskSeedPromotionState::Reviewable);
    other.project_id = ProjectId("project:other".to_owned());

    let projection = EngineTaskSeedCandidateProjection::from_records(
        ProjectId("project:1".to_owned()),
        vec![
            seed("seed:b", EngineTaskSeedPromotionState::Reviewable),
            other,
            seed("seed:a", EngineTaskSeedPromotionState::Reviewable),
        ],
    );

    assert_eq!(
        projection
            .candidates
            .iter()
            .map(|candidate| candidate.seed_id.0.as_str())
            .collect::<Vec<_>>(),
        vec!["seed:a", "seed:b"]
    );
}
