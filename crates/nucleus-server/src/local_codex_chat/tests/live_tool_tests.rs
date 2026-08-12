//! Live tool-authoring tests against a locally authenticated Codex
//! app-server: task ledger batches, goal-backed runways, and the two-portal
//! workflow run. Split from the tests god file; behavior unchanged.

use super::*;

use super::super::persistence::read_history;
use crate::{
    seed_local_project, seed_local_task, LocalControlRequestHandler, LocalProjectSeed,
    LocalTaskSeed,
};
use nucleus_engine::{EngineTaskAgentWorkUnitReviewStatus, EngineTaskAgentWorkUnitRuntimeStatus};
use nucleus_planning::{decode_goal_storage_record, goal_from_storage_record};
use nucleus_tasks::decode_task_storage_record;

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
                provider_instance_id: Some(CHAT_PROVIDER_INSTANCE_ID.to_owned()),
                provider_instance_revision: Some("1".to_owned()),
                protocol_facade_id: Some("codex-app-server-v2".to_owned()),
                provider_id: None,
                model: None,
                reasoning_effort: None,
                harness_mode: LocalCodexChatHarnessMode::Normal,
            idioms_enabled: true,
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
            "provider did not call task_ledger; assistant response: {:?}",
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
                provider_instance_id: Some(CHAT_PROVIDER_INSTANCE_ID.to_owned()),
                provider_instance_revision: Some("1".to_owned()),
                protocol_facade_id: Some("codex-app-server-v2".to_owned()),
                provider_id: None,
                model: None,
                reasoning_effort: None,
                harness_mode: LocalCodexChatHarnessMode::Normal,
            idioms_enabled: true,
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
