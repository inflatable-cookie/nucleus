//! Server-owned local planning seed path.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_engine::{
    encode_task_seed_storage_record, EnginePlanningArtifactId, EnginePlanningReviewState,
    EngineTaskSeedAgentReadinessHints, EngineTaskSeedCandidateRecord, EngineTaskSeedId,
    EngineTaskSeedPromotionState,
};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::{AcceptanceCriterion, AgentReadiness, TaskActionType, TaskImportance};

use crate::state::ServerStateService;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalPlanningTaskSeed {
    pub seed_id: String,
    pub project_id: String,
    pub source_artifact_id: Option<String>,
    pub title: String,
    pub action_type: TaskActionType,
    pub importance: TaskImportance,
}

impl LocalPlanningTaskSeed {
    pub fn nucleus_local_bootstrap() -> Self {
        Self {
            seed_id: "seed:nucleus-local:planning-bootstrap".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            source_artifact_id: Some("artifact:nucleus-local:planning-bootstrap".to_owned()),
            title: "Promote planning output into reviewed task seeds".to_owned(),
            action_type: TaskActionType::Plan,
            importance: TaskImportance::Normal,
        }
    }
}

pub fn seed_local_planning_task_seed<B>(
    state: &ServerStateService<B>,
    seed: LocalPlanningTaskSeed,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let record_id = PersistenceRecordId(seed.seed_id.clone());
    if let Some(existing) = state.planning().get(&record_id)? {
        return Ok(existing);
    }

    let task_seed = EngineTaskSeedCandidateRecord {
        seed_id: EngineTaskSeedId(seed.seed_id.clone()),
        project_id: ProjectId(seed.project_id),
        source_artifact_id: seed.source_artifact_id.map(EnginePlanningArtifactId),
        title: seed.title,
        problem_statement:
            "Planning output should become reviewable task seeds before active tasks.".to_owned(),
        suggested_action_type: seed.action_type,
        suggested_importance: seed.importance,
        acceptance_criteria_draft: vec![AcceptanceCriterion {
            text: "Planning task seed records can be queried without creating tasks.".to_owned(),
            required: true,
        }],
        context_refs: vec!["planning:bootstrap".to_owned()],
        blocking_questions: Vec::new(),
        agent_readiness_hints: EngineTaskSeedAgentReadinessHints {
            suggested_readiness: AgentReadiness {
                ready_for_agent: false,
                required_context_refs: vec!["planning:bootstrap".to_owned()],
                allowed_actions: vec![TaskActionType::Plan, TaskActionType::Review],
                stop_conditions: vec!["stop before task promotion".to_owned()],
                validation_commands: Vec::new(),
            },
            capability_hints: vec!["planning-review".to_owned()],
            validation_hint_refs: vec!["validation:planning:bootstrap".to_owned()],
        },
        review: EnginePlanningReviewState::ReviewRequested,
        promotion: EngineTaskSeedPromotionState::Reviewable,
    };
    let payload = encode_task_seed_storage_record(&task_seed).map_err(|error| {
        LocalStoreError::InvalidRecord {
            reason: error.reason,
        }
    })?;
    let record = LocalStoreRecord {
        id: record_id,
        domain: PersistenceDomain::Planning,
        kind: PersistenceRecordKind::TaskSeed,
        revision_id: RevisionId("rev:planning-task-seed:1".to_owned()),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: payload,
        },
    };

    state
        .planning()
        .put(record, RevisionExpectation::MustNotExist)
}

#[cfg(test)]
mod tests;
