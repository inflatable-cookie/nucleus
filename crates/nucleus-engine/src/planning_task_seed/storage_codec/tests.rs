use nucleus_projects::ProjectId;
use nucleus_tasks::{AcceptanceCriterion, AgentReadiness, TaskActionType, TaskImportance};

use super::*;

fn candidate_record() -> EngineTaskSeedCandidateRecord {
    EngineTaskSeedCandidateRecord {
        seed_id: EngineTaskSeedId("seed:planning:1".to_owned()),
        project_id: ProjectId("project:nucleus".to_owned()),
        source_artifact_id: Some(EnginePlanningArtifactId("artifact:planning:1".to_owned())),
        title: "Add planning seed persistence".to_owned(),
        problem_statement: "Read-only inspection needs persisted seed records.".to_owned(),
        suggested_action_type: TaskActionType::Plan,
        suggested_importance: TaskImportance::High,
        acceptance_criteria_draft: vec![AcceptanceCriterion {
            text: "Task seed storage round-trips without creating a task.".to_owned(),
            required: true,
        }],
        context_refs: vec!["context:planning:1".to_owned()],
        blocking_questions: vec!["Which projection file owns this seed?".to_owned()],
        agent_readiness_hints: EngineTaskSeedAgentReadinessHints {
            suggested_readiness: AgentReadiness {
                ready_for_agent: false,
                required_context_refs: vec!["context:planning:1".to_owned()],
                allowed_actions: vec![TaskActionType::Plan, TaskActionType::Review],
                stop_conditions: vec!["stop before promotion".to_owned()],
                validation_commands: vec![
                    "cargo test -p nucleus-engine planning_task_seed".to_owned()
                ],
            },
            capability_hints: vec!["storage-codec".to_owned()],
            validation_hint_refs: vec!["validation:planning:1".to_owned()],
        },
        review: EnginePlanningReviewState::ChangesRequested {
            reason: "projection policy pending".to_owned(),
        },
        promotion: EngineTaskSeedPromotionState::Blocked {
            reason: "storage selection pending".to_owned(),
        },
    }
}

#[test]
fn task_seed_storage_codec_preserves_review_and_promotion_state() {
    let record = candidate_record();

    let bytes = encode_task_seed_storage_record(&record).expect("encode task seed");
    let decoded = decode_task_seed_storage_record(&bytes).expect("decode task seed");
    let restored = task_seed_from_storage_record(&decoded);

    assert_eq!(restored, record);
    assert_eq!(decoded.seed_id, "seed:planning:1");
    assert_eq!(decoded.project_id, "project:nucleus");
    assert_eq!(
        decoded.source_artifact_id,
        Some("artifact:planning:1".to_owned())
    );
    assert_eq!(
        decoded.promotion,
        PlanningTaskSeedStoragePromotionState::Blocked {
            reason: "storage selection pending".to_owned()
        }
    );
}

#[test]
fn task_seed_storage_payload_uses_sanitized_planning_refs_not_active_task_records() {
    let record = PlanningTaskSeedStorageRecord::from(&candidate_record());

    let bytes = encode_task_seed_storage_payload(&record).expect("encode payload");
    let json = String::from_utf8(bytes).expect("json string");

    assert!(json.contains("\"seed_id\":\"seed:planning:1\""));
    assert!(json.contains("\"source_artifact_id\":\"artifact:planning:1\""));
    assert!(!json.contains("\"task_id\""));
    assert!(!json.contains("raw_transcript"));
    assert!(!json.contains("provider_payload"));
}
