use super::persistence::{persist_turn_completion, persist_turn_start, StoredChatSession};
use super::task_authoring::TaskToolOutcome;
use super::*;
use crate::{
    seed_local_project, seed_local_task, LocalControlRequestHandler, LocalProjectSeed,
    LocalTaskSeed,
};
use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_engine::{EngineTaskAgentWorkUnitReviewStatus, EngineTaskAgentWorkUnitRuntimeStatus};
use nucleus_local_store::{LocalStoreRecordPayload, RevisionExpectation, SqliteBackend};
use nucleus_planning::{decode_goal_storage_record, goal_from_storage_record, GoalStatus};
use nucleus_projects::ProjectId;
use nucleus_tasks::decode_task_storage_record;

#[test]
fn chat_request_serializes_for_tauri_boundary() {
    let request = LocalCodexChatRequest {
        conversation_id: "panel:agent-chat".to_owned(),
        project_id: "project:nucleus".to_owned(),
        resource_id: None,
        message: "hello".to_owned(),
        active_task_id: Some("task:nucleus:one".to_owned()),
        active_goal_id: None,
        model: Some("gpt-5.4-mini".to_owned()),
        reasoning_effort: Some("low".to_owned()),
    };
    let value = serde_json::to_value(request).expect("serialize request");
    assert_eq!(value["conversation_id"], "panel:agent-chat");
    assert_eq!(value["message"], "hello");
    assert_eq!(value["active_task_id"], "task:nucleus:one");
    assert_eq!(value["active_goal_id"], serde_json::Value::Null);
    assert_eq!(value["model"], "gpt-5.4-mini");
    assert_eq!(value["reasoning_effort"], "low");
}

#[test]
fn chat_route_selection_uses_requested_values_and_rejects_invalid_slugs() {
    let mut request = request("route-selection", "hello");
    request.model = Some("  gpt-5.4-mini  ".to_owned());
    request.reasoning_effort = Some("medium".to_owned());

    assert_eq!(
        selected_route(&request, None).expect("route"),
        ("gpt-5.4-mini".to_owned(), "medium".to_owned())
    );

    request.model = Some("gpt 5.4".to_owned());
    assert_eq!(
        selected_route(&request, None).expect_err("invalid route"),
        "chat model contains unsupported characters"
    );
}

#[test]
fn resource_free_chat_uses_host_home_without_inventing_a_resource() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let mut handler = LocalControlRequestHandler::new(backend, None);
    accepted(
        &mut handler,
        crate::control_api::ServerControlRequest {
            id: crate::ServerControlRequestId("request:resource-free-chat".to_owned()),
            client_id: crate::ClientId("client:test".to_owned()),
            kind: crate::control_api::ServerControlRequestKind::Command(crate::ServerCommand {
                id: crate::ServerCommandId("command:resource-free-chat".to_owned()),
                client_id: crate::ClientId("client:test".to_owned()),
                kind: crate::ServerCommandKind::Project(crate::commands::ProjectCommand::Create(
                    crate::commands::ProjectCreateCommand {
                        display_name: String::new(),
                        transient: true,
                        actor_ref: "operator:test".to_owned(),
                        authority_host_ref: "host:embedded-desktop".to_owned(),
                        idempotency_key: "resource-free-chat".to_owned(),
                    },
                )),
            }),
        },
    )
    .expect("create transient project");
    let project_id = handler
        .state()
        .projects()
        .list()
        .expect("projects")
        .into_iter()
        .find(|record| record.kind == nucleus_core::PersistenceRecordKind::Project)
        .expect("transient project")
        .id
        .0;

    let (target, root, target_resource_id) =
        resolve_chat_working_context(handler.state(), &project_id, None).expect("chat context");

    assert!(target.is_none());
    assert_eq!(target_resource_id, "resource:none");
    assert_eq!(
        root,
        std::env::var_os("HOME")
            .expect("host home")
            .to_string_lossy()
    );
}

#[test]
#[ignore = "requires a locally authenticated Codex app-server"]
fn live_chat_model_catalog_exposes_reasoning_options() {
    let models = LocalCodexChatService::available_models().expect("model catalog");

    assert!(!models.is_empty());
    assert!(models
        .iter()
        .all(|model| !model.model.is_empty() && !model.supported_reasoning_efforts.is_empty()));
}

#[test]
fn active_task_enriches_provider_input_without_rewriting_operator_message() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
    seed_local_task(&state, LocalTaskSeed::nucleus_local_bootstrap()).expect("seed task");
    let operator_message = "What should we do next?";

    let provider_message = focused_context_message(
        &state,
        "project:nucleus-local",
        None,
        Some("task:nucleus-local:bootstrap"),
        operator_message,
    )
    .expect("active task context");

    assert!(provider_message.contains("Review Nucleus task workflow"));
    assert!(provider_message.ends_with(operator_message));
    assert_eq!(operator_message, "What should we do next?");
}

#[test]
fn selected_goal_resolves_current_context_without_granting_run_authority() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let state = ServerStateService::new(backend.clone());
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
    let mut handler = LocalControlRequestHandler::new(backend, None);
    let command_id = "command:goal-context";
    accepted(
        &mut handler,
        crate::control_api::ServerControlRequest {
            id: crate::ServerControlRequestId(format!("request:{command_id}")),
            client_id: crate::ClientId("client:test".to_owned()),
            kind: crate::control_api::ServerControlRequestKind::Command(crate::ServerCommand {
                id: crate::ServerCommandId(command_id.to_owned()),
                client_id: crate::ClientId("client:test".to_owned()),
                kind: crate::ServerCommandKind::Goal(crate::commands::GoalCommand::Create(
                    crate::commands::GoalCreateCommand {
                        project_id: ProjectId("project:nucleus-local".to_owned()),
                        title: "Selected goal".to_owned(),
                        desired_outcome: "Goal context reaches chat.".to_owned(),
                        scope: "Context only".to_owned(),
                        status: GoalStatus::Ready,
                        owner_refs: vec!["operator:test".to_owned()],
                        ordered_task_refs: Vec::new(),
                        planning_artifact_refs: Vec::new(),
                        provenance_refs: vec!["conversation:test".to_owned()],
                        stop_conditions: vec!["Stop before execution".to_owned()],
                        evidence_refs: Vec::new(),
                        current_next_task_ref: None,
                        next_action: Some("Shape tasks".to_owned()),
                    },
                )),
            }),
        },
    )
    .expect("create goal");

    let provider_message = focused_context_message(
        &state,
        "project:nucleus-local",
        Some("goal:command:goal-context"),
        None,
        "What next?",
    )
    .expect("goal context");

    assert!(provider_message.contains("Selected goal"));
    assert!(provider_message.contains("Goal context reaches chat."));
    assert!(provider_message.contains("not a mandate"));
    assert!(provider_message.ends_with("What next?"));
    assert!(state.runtime_effects().list().expect("effects").is_empty());
}

#[test]
#[ignore = "requires a locally authenticated Codex app-server"]
fn live_chat_keeps_follow_up_turns_on_one_thread() {
    let cwd = std::env::current_dir().expect("current dir");
    let mut session = LocalCodexChatSession::start(
        "live-smoke",
        cwd.to_str().expect("UTF-8 current dir"),
        "resource:live-smoke",
        None,
        None,
        CHAT_MODEL,
        CHAT_REASONING_EFFORT,
    )
    .expect("start chat session");
    let mut task_tool = |_: &str, _: &str, _: &str, _| {
        Err::<TaskToolOutcome, _>("task tool should not be called in this smoke".to_owned())
    };
    let first = session
        .send_turn(
            "Reply with exactly: first nucleus chat turn",
            CHAT_MODEL,
            CHAT_REASONING_EFFORT,
            &mut task_tool,
        )
        .expect("first turn");
    let second = session
        .send_turn(
            "Reply with exactly: second nucleus chat turn",
            CHAT_MODEL,
            CHAT_REASONING_EFFORT,
            &mut task_tool,
        )
        .expect("second turn");
    assert_eq!(first.thread_id, second.thread_id);
    assert_eq!(first.model, CHAT_MODEL);
    assert_eq!(
        first.reasoning_effort.as_deref(),
        Some(CHAT_REASONING_EFFORT)
    );
    assert!(first.assistant_message.contains("first nucleus chat turn"));
    assert!(second
        .assistant_message
        .contains("second nucleus chat turn"));
}

#[test]
#[ignore = "requires a locally authenticated Codex app-server"]
fn live_chat_route_change_opens_a_fresh_thread_with_transcript_context() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
    let mut service = LocalCodexChatService::default();
    let mut first_request = request(
        "route-change-smoke",
        "Reply with exactly: route change first",
    );
    first_request.reasoning_effort = Some("low".to_owned());
    let first = service
        .send_message(&state, first_request)
        .expect("first route turn");

    let mut second_request = request(
        "route-change-smoke",
        "Reply with exactly: route change second",
    );
    second_request.reasoning_effort = Some("medium".to_owned());
    let second = service
        .send_message(&state, second_request)
        .expect("changed route turn");
    let history = service
        .history(
            &state,
            "project:nucleus-local",
            "project:nucleus-local:panel:route-change-smoke",
        )
        .expect("history");

    assert_ne!(first.thread_id, second.thread_id);
    assert_eq!(second.reasoning_effort.as_deref(), Some("medium"));
    assert_eq!(history.messages.len(), 4);
}

#[test]
#[ignore = "requires a locally authenticated Codex app-server"]
fn live_chat_receives_active_task_context_without_polluting_history() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
    seed_local_task(&state, LocalTaskSeed::nucleus_local_bootstrap()).expect("seed task");
    let conversation_id = "project:nucleus-local:panel:active-task-smoke";
    let operator_message = "Reply with exactly the active task title. Do not call a tool.";
    let mut service = LocalCodexChatService::default();

    let reply = service
        .send_message(
            &state,
            LocalCodexChatRequest {
                conversation_id: conversation_id.to_owned(),
                project_id: "project:nucleus-local".to_owned(),
                resource_id: None,
                message: operator_message.to_owned(),
                active_task_id: Some("task:nucleus-local:bootstrap".to_owned()),
                active_goal_id: None,
                model: None,
                reasoning_effort: None,
            },
        )
        .expect("active task turn");
    let history = service
        .history(&state, "project:nucleus-local", conversation_id)
        .expect("history");

    assert_eq!(reply.assistant_message, "Review Nucleus task workflow");
    assert_eq!(history.messages[0].text, operator_message);
    assert!(!history.messages[0].text.contains("active task context"));
}

#[test]
#[ignore = "requires a locally authenticated Codex app-server"]
fn durable_chat_reopens_with_transcript_context_after_service_restart() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let path = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(path.clone()));
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
    let request = |message: &str| LocalCodexChatRequest {
        conversation_id: "project:nucleus-local:panel:durable-smoke".to_owned(),
        project_id: "project:nucleus-local".to_owned(),
        resource_id: None,
        message: message.to_owned(),
        active_task_id: None,
        active_goal_id: None,
        model: None,
        reasoning_effort: None,
    };
    let first = LocalCodexChatService::default()
        .send_message(&state, request("Reply with exactly: durable first"))
        .expect("first turn");
    let reopened = ServerStateService::new(SqliteBackend::new(path));
    let mut resumed_service = LocalCodexChatService::default();
    let second = resumed_service
        .send_message(&reopened, request("Reply with exactly: durable second"))
        .expect("resumed turn");
    let history = resumed_service
        .history(
            &reopened,
            "project:nucleus-local",
            "project:nucleus-local:panel:durable-smoke",
        )
        .expect("history");
    assert_ne!(first.thread_id, second.thread_id);
    assert_eq!(history.messages.len(), 4);
}

#[test]
#[ignore = "requires a locally authenticated Codex app-server"]
fn live_chat_authors_a_task_batch_without_dispatching_work() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let state = ServerStateService::new(backend.clone());
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
    let mut handler = LocalControlRequestHandler::new(backend, None);
    let mut service = LocalCodexChatService::default();
    let reply = service
        .send_message_with_task_authoring(
            &state,
            LocalCodexChatRequest {
                conversation_id: "project:nucleus-local:panel:task-tool-smoke".to_owned(),
                project_id: "project:nucleus-local".to_owned(),
                resource_id: None,
                message: "Use the task ledger now to create exactly two ready tasks. First: title 'Live tool task one', description 'First live task.', acceptance criterion 'First task exists', normal importance, execute action, validation command 'effigy desktop:check'. Second: title 'Live tool task two', description 'Second live task.', acceptance criterion 'Second task exists', normal importance, test action, validation command 'effigy qa'. Keep your reply brief.".to_owned(),
                active_task_id: None,
                active_goal_id: None,
                model: None,
                reasoning_effort: None,
            },
            &mut |request| accepted(&mut handler, request),
        )
        .expect("live task authoring turn");
    assert_eq!(reply.task_receipts[0].created.len(), 2);
    assert_eq!(state.tasks().list().expect("tasks").len(), 2);
    assert!(state.runtime_effects().list().expect("effects").is_empty());
}

#[test]
#[ignore = "requires a locally authenticated Codex app-server"]
fn legacy_chat_migrates_to_task_ledger_for_a_natural_create_request() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let state = ServerStateService::new(backend.clone());
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
    persist_legacy_session(&state, "legacy-create", 0);
    let mut handler = LocalControlRequestHandler::new(backend, None);
    let reply = LocalCodexChatService::default()
        .send_message_with_task_authoring(
            &state,
            request(
                "legacy-create",
                "Can you create a new task to demo the task features in this app",
            ),
            &mut |request| accepted(&mut handler, request),
        )
        .expect("migrated task authoring turn");
    assert_eq!(reply.task_receipts[0].created.len(), 1);
    assert_eq!(state.tasks().list().expect("tasks").len(), 1);
}

#[test]
#[ignore = "requires a locally authenticated Codex app-server"]
fn atomic_tool_chat_migrates_and_naturally_inspects_then_updates_a_task() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let state = ServerStateService::new(backend.clone());
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
    seed_local_task(&state, LocalTaskSeed::nucleus_local_bootstrap()).expect("seed task");
    persist_legacy_session(&state, "legacy-update", 1);
    let mut handler = LocalControlRequestHandler::new(backend, None);
    let reply = LocalCodexChatService::default()
        .send_message_with_task_authoring(
            &state,
            request("legacy-update", "Review the existing bootstrap task. Update its title to 'Refined bootstrap task' and add the acceptance criterion 'Updated through Agent Chat'. Do not change its lifecycle state."),
            &mut |request| accepted(&mut handler, request),
        )
        .expect("task inspection and update turn");
    assert_eq!(reply.task_receipts[0].updated.len(), 1);
    let record = state
        .tasks()
        .get(&PersistenceRecordId(
            "task:nucleus-local:bootstrap".to_owned(),
        ))
        .expect("lookup")
        .expect("task");
    let task = decode_task_storage_record(&record.payload.bytes).expect("decode");
    assert_eq!(task.title, "Refined bootstrap task");
    assert_eq!(
        task.activity,
        nucleus_tasks::TaskStorageActivityState::Ready
    );
}

#[test]
#[ignore = "requires a locally authenticated Codex app-server"]
fn live_chat_authors_and_refines_a_goal_backed_runway_without_dispatching_work() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let state = ServerStateService::new(backend.clone());
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
    let mut handler = LocalControlRequestHandler::new(backend, None);
    let mut service = LocalCodexChatService::default();
    let conversation = "goal-runway-smoke";
    let created = service
        .send_message_with_task_authoring(
            &state,
            request(
                conversation,
                "Use task_ledger to create one ready goal titled 'Live goal runway' for proving goal-backed task authoring, then create exactly two ready tasks under that goal in order. Fill their descriptions, acceptance criteria, stop conditions, and validation commands. Do not run or dispatch anything. Keep your reply brief.",
            ),
            &mut |request| accepted(&mut handler, request),
        )
        .expect("goal runway authoring turn");
    assert_eq!(created.task_receipts[0].goals_created.len(), 1);
    assert_eq!(created.task_receipts[0].created.len(), 2);
    let goal_id = created.task_receipts[0].goals_created[0].goal_id.clone();

    let refined = service
        .send_message_with_task_authoring(
            &state,
            request(
                conversation,
                "Inspect the goal you just created, then update its desired outcome to 'Goal-backed task authoring is proven and inspectable'. Do not change lifecycle state or execute it.",
            ),
            &mut |request| accepted(&mut handler, request),
        )
        .expect("goal refinement turn");
    assert_eq!(refined.task_receipts[0].goals_updated.len(), 1);

    let record = state
        .planning()
        .get(&PersistenceRecordId(goal_id))
        .expect("goal lookup")
        .expect("goal");
    let goal = goal_from_storage_record(
        decode_goal_storage_record(&record.payload.bytes).expect("goal storage"),
    )
    .expect("goal domain");
    assert_eq!(goal.ordered_task_refs.len(), 2);
    assert_eq!(
        goal.desired_outcome,
        "Goal-backed task authoring is proven and inspectable"
    );
    assert!(state.runtime_effects().list().expect("effects").is_empty());
}

#[test]
#[ignore = "requires a locally authenticated Codex app-server"]
fn live_chat_creates_and_runs_a_two_task_goal_through_two_portals() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let workspace = tempfile::tempdir().expect("workspace");
    let snapshot_backend = tempfile::tempdir().expect("snapshot backend");
    let path = temp_dir.path().join("nucleus.sqlite");
    let backend = SqliteBackend::new(path.clone());
    let state = ServerStateService::new(backend.clone());
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
    redirect_project_root(&state, workspace.path());
    let mut handler = LocalControlRequestHandler::new(backend, None);
    let snapshot_store =
        crate::TaskReviewSnapshotStore::new(snapshot_backend.path()).expect("snapshot store");
    let mut service = LocalCodexChatService::with_task_review_snapshot_store(snapshot_store);
    let conversation = "workflow-live-smoke";
    let created = service
        .send_message_with_task_authoring(
            &state,
            request(
                conversation,
                "You must call task_ledger now. Create one ready Goal titled 'Portal execution smoke' and exactly two ordered ready execute tasks under it. Task one must create first.txt containing first. Task two must create second.txt containing second. Give each clear acceptance criteria, stop conditions, and validation commands. Do not merely describe the records and do not run them yet.",
            ),
            &mut |request| accepted(&mut handler, request),
        )
        .expect("create Goal runway");
    let task_receipt = created.task_receipts.first().unwrap_or_else(|| {
        panic!(
            "provider did not call task_ledger; assistant response: {}",
            created.assistant_message
        )
    });
    let goal = task_receipt
        .goals_updated
        .last()
        .or_else(|| task_receipt.goals_created.last())
        .expect("Goal receipt")
        .clone();
    let task_ids: Vec<&str> = task_receipt
        .created
        .iter()
        .map(|task| task.task_id.as_str())
        .collect();
    assert_eq!(task_ids.len(), 2);

    let executed = service
        .send_message_with_task_authoring(
            &state,
            LocalCodexChatRequest {
                conversation_id: format!("project:nucleus-local:panel:{conversation}"),
                project_id: "project:nucleus-local".to_owned(),
                resource_id: None,
                message: "Inspect this Goal with task_workflow, then run this Goal now. Use the exact excerpt 'run this Goal now' as the mandate authority and a stable idempotency key. Do not accept review or complete the tasks.".to_owned(),
                active_task_id: None,
                active_goal_id: Some(goal.goal_id.clone()),
                model: None,
                reasoning_effort: None,
            },
            &mut |request| accepted(&mut handler, request),
        )
        .expect("execute Goal runway");

    assert_eq!(executed.workflow_receipts.len(), 1);
    assert_eq!(
        executed.workflow_receipts[0].status,
        TaskWorkflowReceiptStatus::ReviewReady,
        "unexpected workflow receipt: {:#?}",
        executed.workflow_receipts[0]
    );
    assert_eq!(executed.workflow_receipts[0].total_tasks, 2);
    assert_eq!(executed.workflow_receipts[0].work_item_refs.len(), 2);
    assert_eq!(executed.workflow_receipts[0].runtime_receipt_refs.len(), 2);
    let source_records =
        crate::read_task_agent_work_unit_source_records(&state).expect("durable task work records");
    for task_id in task_ids {
        let completed = source_records
            .iter()
            .filter(|record| record.task_id.0 == task_id)
            .max_by_key(|record| record.source_cursor.0.clone())
            .unwrap_or_else(|| panic!("missing work record for {task_id}"));
        assert_eq!(
            completed.runtime,
            EngineTaskAgentWorkUnitRuntimeStatus::Completed
        );
        assert_eq!(
            completed.review,
            EngineTaskAgentWorkUnitReviewStatus::AwaitingReview
        );
        assert!(!completed.refs.receipt_ids.is_empty());
        assert!(!completed.refs.checkpoint_ids.is_empty());
        assert!(!completed.refs.diff_summary_ids.is_empty());
    }
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("first.txt"))
            .expect("first file")
            .trim(),
        "first"
    );
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("second.txt"))
            .expect("second file")
            .trim(),
        "second"
    );
    drop(service);
    let reopened = ServerStateService::new(SqliteBackend::new(path));
    let history = read_history(
        &reopened,
        "project:nucleus-local",
        &format!("project:nucleus-local:panel:{conversation}"),
    )
    .expect("restart-safe history");
    assert_eq!(
        history
            .messages
            .iter()
            .flat_map(|message| &message.workflow_receipts)
            .count(),
        1
    );
}

fn request(conversation: &str, message: &str) -> LocalCodexChatRequest {
    LocalCodexChatRequest {
        conversation_id: format!("project:nucleus-local:panel:{conversation}"),
        project_id: "project:nucleus-local".to_owned(),
        resource_id: None,
        message: message.to_owned(),
        active_task_id: None,
        active_goal_id: None,
        model: None,
        reasoning_effort: None,
    }
}

fn persist_legacy_session(
    state: &ServerStateService<SqliteBackend>,
    conversation: &str,
    toolset_version: u32,
) {
    let conversation_id = format!("project:nucleus-local:panel:{conversation}");
    let turn_id = format!("turn:{conversation}");
    persist_turn_start(
        state,
        StoredChatSession {
            conversation_id,
            project_id: "project:nucleus-local".to_owned(),
            resource_id: None,
            session_id: format!("session:{conversation}"),
            provider_thread_id: format!("thread:{conversation}"),
            model: CHAT_MODEL.to_owned(),
            reasoning_effort: Some(CHAT_REASONING_EFFORT.to_owned()),
            adapter_id: CHAT_ADAPTER_ID.to_owned(),
            provider_instance_id: CHAT_PROVIDER_INSTANCE_ID.to_owned(),
            turn_count: 1,
            task_toolset_version: toolset_version,
        },
        &turn_id,
        "What can this app do?",
        None,
    )
    .expect("persist legacy chat start");
    persist_turn_completion(
        state,
        &turn_id,
        &format!("provider-turn:{conversation}"),
        "It can manage projects and conversations.",
        &[],
        &[],
    )
    .expect("persist legacy chat completion");
}

fn redirect_project_root(state: &ServerStateService<SqliteBackend>, root: &std::path::Path) {
    let id = PersistenceRecordId("project:nucleus-local".to_owned());
    let mut record = state
        .projects()
        .get(&id)
        .expect("project lookup")
        .expect("project");
    let previous = record.revision_id.clone();
    let mut project =
        nucleus_projects::decode_project_storage_record(&record.payload.bytes).expect("decode");
    let resource = project.resources.first_mut().expect("seed resource");
    resource.current_locator = Some(root.to_string_lossy().into_owned());
    resource.location_status = nucleus_projects::ProjectResourceStorageLocationStatus::Present;
    record.revision_id = RevisionId("rev:project:workflow-live-smoke".to_owned());
    record.payload = LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes: nucleus_projects::encode_project_storage_payload(&project).expect("encode"),
    };
    state
        .projects()
        .put(record, RevisionExpectation::Exact(previous))
        .expect("redirect project");
}

fn accepted(
    handler: &mut LocalControlRequestHandler<SqliteBackend>,
    request: crate::control_api::ServerControlRequest,
) -> Result<(), String> {
    let response = handler.handle(request);
    if response.status == crate::control_api::ServerControlResponseStatus::Accepted {
        Ok(())
    } else {
        Err(format!("task command rejected: {:?}", response.body))
    }
}
