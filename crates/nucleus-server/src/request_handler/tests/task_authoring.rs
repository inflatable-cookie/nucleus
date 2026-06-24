use super::*;
use nucleus_core::{PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_engine::{
    decode_task_seed_storage_record, encode_task_seed_storage_record,
    task_seed_from_storage_record, EnginePlanningArtifactId, EnginePlanningReviewState,
    EngineTaskSeedAgentReadinessHints, EngineTaskSeedCandidateRecord, EngineTaskSeedId,
    EngineTaskSeedPromotionState,
};
use nucleus_local_store::{LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation};

#[test]
fn handler_executes_task_create_command_and_reads_back_task_dto() {
    let (_temp_dir, mut handler) = handler(None);
    seed_local_project(handler.state(), LocalProjectSeed::nucleus_local()).expect("seed project");

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:create-task".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:create-task".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Task(TaskCommand::Create(
                crate::commands::TaskCreateCommand {
                    project_id: nucleus_projects::ProjectId("project:nucleus-local".to_owned()),
                    title: "Create task through handler".to_owned(),
                    description: Some("Write a task record through server authority.".to_owned()),
                    acceptance_criteria: vec![nucleus_tasks::AcceptanceCriterion {
                        text: "Task appears in read-after-write DTO".to_owned(),
                        required: true,
                    }],
                    importance: nucleus_tasks::TaskImportance::High,
                    action_type: nucleus_tasks::TaskActionType::Plan,
                    activity: nucleus_tasks::TaskActivityState::Proposed,
                    agent_readiness: nucleus_tasks::AgentReadiness {
                        ready_for_agent: true,
                        required_context_refs: vec![
                            "docs/contracts/005-task-contract.md".to_owned()
                        ],
                        allowed_actions: vec![nucleus_tasks::TaskActionType::Plan],
                        stop_conditions: Vec::new(),
                        validation_commands: vec!["effigy test --plan".to_owned()],
                    },
                },
            )),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Accepted);

    let query_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:created-task-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:created-tasks".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Task(StateRecordQuery {
                domain: ServerStateDomain::Tasks,
                scope: StateRecordQueryScope::List,
            }),
        }),
    });
    let dto = crate::control_envelope_dto::ControlResponseEnvelopeDto::try_from(&query_response)
        .expect("task dto response");

    assert!(matches!(
        dto.body,
        crate::control_envelope_dto::ControlResponseBodyDto::TaskRecords { records }
            if records.len() == 1
                && records[0].task_id == "task:command:create-task"
                && records[0].title == "Create task through handler"
                && records[0].importance == "high"
                && records[0].agent_ready
    ));
}

#[test]
fn handler_promotes_accepted_task_seed_and_persists_promoted_state() {
    let (_temp_dir, mut handler) = handler(None);
    seed_local_project(handler.state(), LocalProjectSeed::nucleus_local()).expect("seed project");
    persist_planning_task_seed(&handler, accepted_task_seed(), "rev:seed:ready");

    let response = handler.handle(promote_seed_request(
        "request:promote-seed",
        "command:promote-seed",
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Accepted);
    assert_eq!(handler.state().tasks().list().expect("tasks").len(), 1);

    let task = handler
        .state()
        .tasks()
        .get(&PersistenceRecordId("task:command:promote-seed".to_owned()))
        .expect("task get")
        .expect("task exists");
    assert_eq!(task.kind, PersistenceRecordKind::Task);

    let promoted = read_planning_task_seed(&handler, "seed:planning:ready");
    assert_eq!(
        promoted.promotion,
        EngineTaskSeedPromotionState::Promoted {
            task_ref: "task:command:promote-seed".to_owned()
        }
    );
}

#[test]
fn handler_repeated_task_seed_promotion_is_idempotent() {
    let (_temp_dir, mut handler) = handler(None);
    seed_local_project(handler.state(), LocalProjectSeed::nucleus_local()).expect("seed project");
    persist_planning_task_seed(&handler, accepted_task_seed(), "rev:seed:ready");

    assert_eq!(
        handler
            .handle(promote_seed_request(
                "request:promote-seed",
                "command:promote-seed"
            ))
            .status,
        ServerControlResponseStatus::Accepted
    );
    assert_eq!(
        handler
            .handle(promote_seed_request(
                "request:promote-seed-repeat",
                "command:promote-seed-repeat"
            ))
            .status,
        ServerControlResponseStatus::Accepted
    );

    assert_eq!(handler.state().tasks().list().expect("tasks").len(), 1);
    let promoted = read_planning_task_seed(&handler, "seed:planning:ready");
    assert_eq!(
        promoted.promotion,
        EngineTaskSeedPromotionState::Promoted {
            task_ref: "task:command:promote-seed".to_owned()
        }
    );
}

#[test]
fn handler_rejects_blocked_task_seed_promotion_without_creating_task() {
    let (_temp_dir, mut handler) = handler(None);
    seed_local_project(handler.state(), LocalProjectSeed::nucleus_local()).expect("seed project");
    let mut seed = accepted_task_seed();
    seed.review = EnginePlanningReviewState::Rejected {
        reason: "wrong scope".to_owned(),
    };
    persist_planning_task_seed(&handler, seed, "rev:seed:ready");

    let response = handler.handle(promote_seed_request(
        "request:promote-seed",
        "command:promote-seed",
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Rejected);
    assert_eq!(handler.state().tasks().list().expect("tasks").len(), 0);
}

#[test]
fn handler_reports_task_seed_decode_failure_without_creating_task() {
    let (_temp_dir, mut handler) = handler(None);
    handler
        .state()
        .planning()
        .put(
            LocalStoreRecord {
                id: PersistenceRecordId("seed:planning:ready".to_owned()),
                domain: nucleus_core::PersistenceDomain::Planning,
                kind: PersistenceRecordKind::TaskSeed,
                revision_id: RevisionId("rev:seed:bad".to_owned()),
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes: b"{not-json".to_vec(),
                },
            },
            RevisionExpectation::MustNotExist,
        )
        .expect("persist bad planning seed");

    let response = handler.handle(promote_seed_request(
        "request:promote-seed",
        "command:promote-seed",
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Rejected);
    assert_eq!(handler.state().tasks().list().expect("tasks").len(), 0);
}

#[test]
fn handler_executes_task_update_command_with_revision_check() {
    let (_temp_dir, mut handler) = handler(None);
    let seeded = seed_local_task(
        handler.state(),
        LocalTaskSeed {
            task_id: "task:update".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            title: "Seed Task".to_owned(),
            action_type: nucleus_tasks::TaskActionType::Plan,
            importance: nucleus_tasks::TaskImportance::Normal,
        },
    )
    .expect("seed task");

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:update-task".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:update-task".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Task(TaskCommand::Update(
                crate::commands::TaskUpdateCommand {
                    task_id: TaskId("task:update".to_owned()),
                    expected_revision: Some(seeded.revision_id.clone()),
                    changes: crate::commands::TaskUpdateChanges {
                        title: Some("Updated Task".to_owned()),
                        importance: Some(nucleus_tasks::TaskImportance::Critical),
                        activity: Some(nucleus_tasks::TaskActivityState::Ready),
                        ..Default::default()
                    },
                },
            )),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Accepted);

    let query_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:updated-task-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:updated-tasks".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Task(StateRecordQuery {
                domain: ServerStateDomain::Tasks,
                scope: StateRecordQueryScope::List,
            }),
        }),
    });
    let dto = crate::control_envelope_dto::ControlResponseEnvelopeDto::try_from(&query_response)
        .expect("task dto response");

    assert!(matches!(
        dto.body,
        crate::control_envelope_dto::ControlResponseBodyDto::TaskRecords { records }
            if records.len() == 1
                && records[0].title == "Updated Task"
                && records[0].importance == "critical"
                && records[0].activity == "ready"
    ));
}

fn promote_seed_request(request_id: &str, command_id: &str) -> ServerControlRequest {
    ServerControlRequest {
        id: ServerControlRequestId(request_id.to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId(command_id.to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Task(TaskCommand::PromoteSeed(
                crate::commands::TaskSeedPromotionCommand {
                    project_id: nucleus_projects::ProjectId("project:nucleus-local".to_owned()),
                    seed_id: EngineTaskSeedId("seed:planning:ready".to_owned()),
                    expected_seed_revision: Some(RevisionId("rev:seed:ready".to_owned())),
                    destination_task_id: Some(TaskId("task:command:promote-seed".to_owned())),
                },
            )),
        }),
    }
}

fn accepted_task_seed() -> EngineTaskSeedCandidateRecord {
    EngineTaskSeedCandidateRecord {
        seed_id: EngineTaskSeedId("seed:planning:ready".to_owned()),
        project_id: nucleus_projects::ProjectId("project:nucleus-local".to_owned()),
        source_artifact_id: Some(EnginePlanningArtifactId(
            "artifact:planning:ready".to_owned(),
        )),
        title: "Promote accepted planning seed".to_owned(),
        problem_statement: "Accepted planning output should become a proposed task.".to_owned(),
        suggested_action_type: nucleus_tasks::TaskActionType::Plan,
        suggested_importance: nucleus_tasks::TaskImportance::High,
        acceptance_criteria_draft: vec![nucleus_tasks::AcceptanceCriterion {
            text: "Task seed promotion creates one proposed task.".to_owned(),
            required: true,
        }],
        context_refs: vec!["planning:context:ready".to_owned()],
        blocking_questions: Vec::new(),
        agent_readiness_hints: EngineTaskSeedAgentReadinessHints {
            suggested_readiness: nucleus_tasks::AgentReadiness {
                ready_for_agent: false,
                required_context_refs: vec!["planning:context:ready".to_owned()],
                allowed_actions: vec![nucleus_tasks::TaskActionType::Plan],
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

fn persist_planning_task_seed(
    handler: &LocalControlRequestHandler<nucleus_local_store::SqliteBackend>,
    seed: EngineTaskSeedCandidateRecord,
    revision_id: &str,
) {
    handler
        .state()
        .planning()
        .put(
            LocalStoreRecord {
                id: PersistenceRecordId(seed.seed_id.0.clone()),
                domain: nucleus_core::PersistenceDomain::Planning,
                kind: PersistenceRecordKind::TaskSeed,
                revision_id: RevisionId(revision_id.to_owned()),
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes: encode_task_seed_storage_record(&seed).expect("encode task seed"),
                },
            },
            RevisionExpectation::MustNotExist,
        )
        .expect("persist planning task seed");
}

fn read_planning_task_seed(
    handler: &LocalControlRequestHandler<nucleus_local_store::SqliteBackend>,
    seed_id: &str,
) -> EngineTaskSeedCandidateRecord {
    let record = handler
        .state()
        .planning()
        .get(&PersistenceRecordId(seed_id.to_owned()))
        .expect("planning get")
        .expect("planning seed exists");
    let storage = decode_task_seed_storage_record(&record.payload.bytes).expect("decode seed");
    task_seed_from_storage_record(&storage)
}
