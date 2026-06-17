//! Server-owned local task seed path.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::{
    encode_task_storage_record, AcceptanceCriterion, AgentReadiness, AssignmentState, NeglectLevel,
    NeglectSignal, Task, TaskActionType, TaskActivityState, TaskId, TaskImportance, TaskTimestamps,
};

use crate::state::ServerStateService;

/// Local task seed input.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalTaskSeed {
    pub task_id: String,
    pub project_id: String,
    pub title: String,
    pub action_type: TaskActionType,
    pub importance: TaskImportance,
}

impl LocalTaskSeed {
    /// Default bootstrap task for local desktop readiness.
    pub fn nucleus_local_bootstrap() -> Self {
        Self {
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            title: "Review Nucleus task workflow".to_owned(),
            action_type: TaskActionType::Plan,
            importance: TaskImportance::Normal,
        }
    }
}

/// Seed one local task record through server-owned state access.
pub fn seed_local_task<B>(
    state: &ServerStateService<B>,
    seed: LocalTaskSeed,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let record_id = PersistenceRecordId(seed.task_id.clone());
    if let Some(existing) = state.tasks().get(&record_id)? {
        return Ok(existing);
    }

    let task = Task {
        id: TaskId(seed.task_id.clone()),
        project_id: ProjectId(seed.project_id),
        title: seed.title,
        description: Some("Bootstrap task seeded by the local server.".to_owned()),
        acceptance_criteria: vec![AcceptanceCriterion {
            text: "Task records can be queried through the server boundary.".to_owned(),
            required: true,
        }],
        importance: seed.importance,
        neglect: NeglectSignal {
            level: NeglectLevel::Fresh,
            last_addressed_at: None,
            note: Some("local seed".to_owned()),
        },
        action_type: seed.action_type,
        assignment: AssignmentState::Unassigned,
        activity: TaskActivityState::Ready,
        agent_readiness: AgentReadiness {
            ready_for_agent: false,
            required_context_refs: Vec::new(),
            allowed_actions: vec![TaskActionType::Plan, TaskActionType::Review],
            stop_conditions: Vec::new(),
            validation_commands: Vec::new(),
        },
        assignment_plan: None,
        assignment_snapshot: None,
        history: Vec::new(),
        model_preferences: None,
        timestamps: TaskTimestamps {
            created_at: None,
            updated_at: None,
            started_at: None,
            completed_at: None,
        },
    };
    let payload =
        encode_task_storage_record(&task).map_err(|error| LocalStoreError::InvalidRecord {
            reason: error.reason,
        })?;
    let record = LocalStoreRecord {
        id: record_id,
        domain: PersistenceDomain::Tasks,
        kind: PersistenceRecordKind::Task,
        revision_id: RevisionId("rev:task-seed:1".to_owned()),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: payload,
        },
    };

    state.tasks().put(record, RevisionExpectation::MustNotExist)
}

#[cfg(test)]
mod tests {
    use nucleus_local_store::SqliteBackend;

    use super::*;
    use crate::control_api::{
        ServerControlRequest, ServerControlRequestKind, ServerControlResponseBody, ServerQuery,
        ServerQueryKind, ServerQueryResult, StateRecordQuery, StateRecordQueryScope,
    };
    use crate::control_envelope_dto::{ControlResponseBodyDto, ControlResponseEnvelopeDto};
    use crate::ids::{ClientId, ServerControlRequestId, ServerQueryId};
    use crate::project_seed::{seed_local_project, LocalProjectSeed};
    use crate::request_handler::LocalControlRequestHandler;
    use crate::state::ServerStateDomain;

    #[test]
    fn local_task_seed_is_idempotent_and_queryable() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let mut handler = LocalControlRequestHandler::new(backend, None);
        seed_local_project(handler.state(), LocalProjectSeed::nucleus_local())
            .expect("project seed");

        let first = seed_local_task(
            handler.state(),
            LocalTaskSeed {
                task_id: "task:seed".to_owned(),
                project_id: "project:nucleus-local".to_owned(),
                title: "Seed Task".to_owned(),
                action_type: TaskActionType::Plan,
                importance: TaskImportance::High,
            },
        )
        .expect("first seed");
        let second = seed_local_task(
            handler.state(),
            LocalTaskSeed {
                task_id: "task:seed".to_owned(),
                project_id: "project:nucleus-local".to_owned(),
                title: "Changed Task".to_owned(),
                action_type: TaskActionType::Review,
                importance: TaskImportance::Low,
            },
        )
        .expect("second seed");

        assert_eq!(first, second);

        let response = handler.handle(ServerControlRequest {
            id: ServerControlRequestId("request:seed:tasks".to_owned()),
            client_id: ClientId("client:test".to_owned()),
            kind: ServerControlRequestKind::Query(ServerQuery {
                id: ServerQueryId("query:seed:tasks".to_owned()),
                client_id: ClientId("client:test".to_owned()),
                kind: ServerQueryKind::Task(StateRecordQuery {
                    domain: ServerStateDomain::Tasks,
                    scope: StateRecordQueryScope::List,
                }),
            }),
        });

        assert!(matches!(
            response.body,
            ServerControlResponseBody::Query(ServerQueryResult::StateRecords(ref records))
                if records.records.len() == 1
        ));

        let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
        assert!(matches!(
            dto.body,
            ControlResponseBodyDto::TaskRecords { records }
                if records.len() == 1
                    && records[0].task_id == "task:seed"
                    && records[0].project_id == "project:nucleus-local"
                    && records[0].title == "Seed Task"
        ));
    }
}
