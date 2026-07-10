use std::time::{SystemTime, UNIX_EPOCH};

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use super::goal_inspection::goal_record;
use super::persistence::{current_turn, read_message, read_session, ChatMessageRole};
use super::task_inspection::active_task;
use crate::ServerStateService;

const MANDATE_PREFIX: &str = "conversation-goal-mandate:";
const MAX_GOAL_TASKS: usize = 50;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GoalMandateAdmission {
    pub mandate_id: String,
    pub conversation_id: String,
    pub operator_message_id: String,
    pub operator_message_excerpt: String,
    pub project_id: String,
    pub goal_id: String,
    pub goal_revision: String,
    pub idempotency_key: String,
    pub expires_at_epoch_seconds: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GoalMandateTaskSnapshot {
    pub task_id: String,
    pub revision_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalMandateStatus {
    Active,
    Cancelled,
    Revoked,
    Expired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GoalMandate {
    pub mandate_id: String,
    pub conversation_id: String,
    pub source_turn_id: String,
    pub operator_message_id: String,
    pub operator_message_excerpt: String,
    pub project_id: String,
    pub goal_id: String,
    pub goal_revision: String,
    pub ordered_task_snapshot: Vec<GoalMandateTaskSnapshot>,
    pub idempotency_key: String,
    pub status: GoalMandateStatus,
    pub created_at_epoch_seconds: u64,
    pub expires_at_epoch_seconds: u64,
    pub terminal_reason: Option<String>,
    pub outcome_refs: Vec<String>,
    pub revision_id: String,
}

pub fn create_goal_mandate<B>(
    state: &ServerStateService<B>,
    admission: GoalMandateAdmission,
) -> Result<GoalMandate, String>
where
    B: LocalStoreBackend,
{
    require_nonempty("mandate id", &admission.mandate_id)?;
    require_nonempty("idempotency key", &admission.idempotency_key)?;
    let excerpt = admission.operator_message_excerpt.trim();
    require_nonempty("operator message excerpt", excerpt)?;

    let now = now_epoch_seconds()?;
    if admission.expires_at_epoch_seconds <= now {
        return Err("goal mandate expiry must be in the future".to_owned());
    }
    let session = read_session(state, &admission.conversation_id)?
        .ok_or_else(|| "goal mandate conversation has no durable chat session".to_owned())?;
    if session.project_id != admission.project_id {
        return Err("goal mandate conversation belongs to another project".to_owned());
    }
    let turn = current_turn(state, &admission.conversation_id)?;
    if turn.status != "started" {
        return Err("goal mandate source must be the current in-progress operator turn".to_owned());
    }
    if turn.selected_goal_id.as_deref() != Some(admission.goal_id.as_str()) {
        return Err("goal mandate must cite the Goal selected for the current turn".to_owned());
    }
    let message = read_message(state, &admission.operator_message_id)?;
    if message.conversation_id != admission.conversation_id
        || message.turn_id != turn.turn_id
        || message.role != ChatMessageRole::User
    {
        return Err("goal mandate must cite the current canonical operator message".to_owned());
    }
    if !message.text.contains(excerpt) {
        return Err(
            "goal mandate excerpt does not occur exactly in the operator message".to_owned(),
        );
    }

    let goal = goal_record(state, &admission.project_id, &admission.goal_id)?;
    if goal.revision_id != admission.goal_revision {
        return Err("goal mandate cites a stale Goal revision".to_owned());
    }
    if goal.ordered_task_refs.len() > MAX_GOAL_TASKS {
        return Err(format!(
            "goal mandate accepts at most {MAX_GOAL_TASKS} ordered tasks"
        ));
    }
    let ordered_task_snapshot = goal
        .ordered_task_refs
        .iter()
        .map(|task_id| {
            active_task(state, &admission.project_id, task_id).map(|task| GoalMandateTaskSnapshot {
                task_id: task.task_id,
                revision_id: task.revision_id,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let revision_id = format!("rev:{}:active", admission.mandate_id);
    let mandate = GoalMandate {
        mandate_id: admission.mandate_id,
        conversation_id: admission.conversation_id,
        source_turn_id: turn.turn_id,
        operator_message_id: admission.operator_message_id,
        operator_message_excerpt: excerpt.to_owned(),
        project_id: admission.project_id,
        goal_id: admission.goal_id,
        goal_revision: admission.goal_revision,
        ordered_task_snapshot,
        idempotency_key: admission.idempotency_key,
        status: GoalMandateStatus::Active,
        created_at_epoch_seconds: now,
        expires_at_epoch_seconds: admission.expires_at_epoch_seconds,
        terminal_reason: None,
        outcome_refs: Vec::new(),
        revision_id,
    };
    put_mandate(state, &mandate, RevisionExpectation::MustNotExist)?;
    Ok(mandate)
}

pub fn read_goal_mandate<B>(
    state: &ServerStateService<B>,
    mandate_id: &str,
) -> Result<GoalMandate, String>
where
    B: LocalStoreBackend,
{
    let record = state
        .agent_sessions()
        .get(&record_id(mandate_id))
        .map_err(storage_error)?
        .ok_or_else(|| format!("goal mandate not found: {mandate_id}"))?;
    serde_json::from_slice(&record.payload.bytes).map_err(|error| error.to_string())
}

pub fn cancel_goal_mandate<B>(
    state: &ServerStateService<B>,
    mandate_id: &str,
    expected_revision: &str,
    reason: &str,
) -> Result<GoalMandate, String>
where
    B: LocalStoreBackend,
{
    close_mandate(
        state,
        mandate_id,
        expected_revision,
        reason,
        GoalMandateStatus::Cancelled,
        "cancelled",
    )
}

pub fn revoke_goal_mandate<B>(
    state: &ServerStateService<B>,
    mandate_id: &str,
    expected_revision: &str,
    reason: &str,
) -> Result<GoalMandate, String>
where
    B: LocalStoreBackend,
{
    close_mandate(
        state,
        mandate_id,
        expected_revision,
        reason,
        GoalMandateStatus::Revoked,
        "revoked",
    )
}

fn close_mandate<B>(
    state: &ServerStateService<B>,
    mandate_id: &str,
    expected_revision: &str,
    reason: &str,
    status: GoalMandateStatus,
    suffix: &str,
) -> Result<GoalMandate, String>
where
    B: LocalStoreBackend,
{
    require_nonempty("terminal reason", reason.trim())?;
    let mut mandate = read_goal_mandate(state, mandate_id)?;
    if mandate.revision_id != expected_revision {
        return Err("goal mandate revision conflict".to_owned());
    }
    if mandate.status != GoalMandateStatus::Active {
        return Err("only an active goal mandate can be closed".to_owned());
    }
    mandate.status = status;
    mandate.terminal_reason = Some(reason.trim().to_owned());
    let previous_revision = RevisionId(mandate.revision_id.clone());
    mandate.revision_id = format!("rev:{mandate_id}:{suffix}");
    put_mandate(
        state,
        &mandate,
        RevisionExpectation::Exact(previous_revision),
    )?;
    Ok(mandate)
}

fn put_mandate<B>(
    state: &ServerStateService<B>,
    mandate: &GoalMandate,
    expectation: RevisionExpectation,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let bytes = serde_json::to_vec(mandate).map_err(|error| error.to_string())?;
    state
        .agent_sessions()
        .put(
            LocalStoreRecord {
                revision_id: RevisionId(mandate.revision_id.clone()),
                id: record_id(&mandate.mandate_id),
                domain: PersistenceDomain::AgentSessions,
                kind: PersistenceRecordKind::AgentSession,
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes,
                },
            },
            expectation,
        )
        .map(|_| ())
        .map_err(storage_error)
}

fn record_id(mandate_id: &str) -> PersistenceRecordId {
    PersistenceRecordId(format!("{MANDATE_PREFIX}{mandate_id}"))
}

fn require_nonempty(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{label} must not be empty"))
    } else {
        Ok(())
    }
}

fn now_epoch_seconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "system clock is before the Unix epoch".to_owned())
}

fn storage_error(error: impl std::fmt::Debug) -> String {
    format!("goal mandate persistence failed: {error:?}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_codex_chat::persistence::{
        operator_message_id, persist_turn_start, StoredChatSession,
    };
    use crate::{
        seed_local_project, seed_local_task, ClientId, LocalControlRequestHandler,
        LocalProjectSeed, LocalTaskSeed, ServerCommand, ServerCommandId, ServerCommandKind,
        ServerControlRequestId,
    };
    use nucleus_core::RevisionId;
    use nucleus_local_store::SqliteBackend;
    use nucleus_planning::{GoalStatus, PlanningGoalId};
    use nucleus_projects::ProjectId;
    use nucleus_tasks::{TaskActionType, TaskId, TaskImportance};

    #[test]
    fn mandate_cites_current_operator_turn_and_freezes_goal_membership() {
        let (state, backend, goal_id, goal_revision) = setup_goal();
        let conversation = "conversation:mandate";
        let turn_id = "turn:mandate:1";
        persist_turn_start(
            &state,
            chat_session(conversation),
            turn_id,
            "Please execute this goal now.",
            Some(goal_id.clone()),
        )
        .expect("turn start");

        let mandate = create_goal_mandate(
            &state,
            GoalMandateAdmission {
                mandate_id: "mandate:1".to_owned(),
                conversation_id: conversation.to_owned(),
                operator_message_id: operator_message_id(turn_id),
                operator_message_excerpt: "execute this goal".to_owned(),
                project_id: "project:nucleus-local".to_owned(),
                goal_id,
                goal_revision,
                idempotency_key: "run:1".to_owned(),
                expires_at_epoch_seconds: now_epoch_seconds().expect("clock") + 300,
            },
        )
        .expect("mandate");

        assert_eq!(mandate.ordered_task_snapshot.len(), 1);
        assert_eq!(
            mandate.ordered_task_snapshot[0].task_id,
            "task:nucleus-local:bootstrap"
        );
        let mut handler = LocalControlRequestHandler::new(backend.clone(), None);
        let response = handler.handle(crate::control_api::ServerControlRequest {
            id: ServerControlRequestId("request:widen-goal".to_owned()),
            client_id: ClientId("client:test".to_owned()),
            kind: crate::control_api::ServerControlRequestKind::Command(ServerCommand {
                id: ServerCommandId("command:widen-goal".to_owned()),
                client_id: ClientId("client:test".to_owned()),
                kind: ServerCommandKind::Goal(crate::commands::GoalCommand::Update(
                    crate::commands::GoalUpdateCommand {
                        goal_id: PlanningGoalId(mandate.goal_id.clone()),
                        expected_revision: RevisionId(mandate.goal_revision.clone()),
                        changes: crate::commands::GoalUpdateChanges {
                            ordered_task_refs: Some(vec![
                                TaskId("task:nucleus-local:bootstrap".to_owned()),
                                TaskId("task:nucleus-local:later".to_owned()),
                            ]),
                            ..Default::default()
                        },
                    },
                )),
            }),
        });
        assert_eq!(
            response.status,
            crate::control_api::ServerControlResponseStatus::Accepted
        );
        assert_eq!(
            read_goal_mandate(&state, &mandate.mandate_id)
                .expect("frozen mandate")
                .ordered_task_snapshot,
            mandate.ordered_task_snapshot
        );
        assert!(state.runtime_effects().list().expect("effects").is_empty());
        let cancelled = cancel_goal_mandate(
            &state,
            &mandate.mandate_id,
            &mandate.revision_id,
            "operator stopped the run",
        )
        .expect("cancel");
        assert_eq!(cancelled.status, GoalMandateStatus::Cancelled);
        assert!(state.runtime_effects().list().expect("effects").is_empty());
    }

    #[test]
    fn mandate_rejects_noncurrent_message_excerpt_and_unselected_goal() {
        let (state, _backend, goal_id, goal_revision) = setup_goal();
        let conversation = "conversation:reject";
        persist_turn_start(
            &state,
            chat_session(conversation),
            "turn:reject:1",
            "Plan this goal.",
            None,
        )
        .expect("turn start");
        let error = create_goal_mandate(
            &state,
            GoalMandateAdmission {
                mandate_id: "mandate:reject".to_owned(),
                conversation_id: conversation.to_owned(),
                operator_message_id: operator_message_id("turn:reject:1"),
                operator_message_excerpt: "execute".to_owned(),
                project_id: "project:nucleus-local".to_owned(),
                goal_id,
                goal_revision,
                idempotency_key: "run:reject".to_owned(),
                expires_at_epoch_seconds: now_epoch_seconds().expect("clock") + 300,
            },
        )
        .expect_err("unselected goal must fail");
        assert!(error.contains("selected"));
    }

    fn setup_goal() -> (
        ServerStateService<SqliteBackend>,
        SqliteBackend,
        String,
        String,
    ) {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let path = temp_dir.keep().join("nucleus.sqlite");
        let backend = SqliteBackend::new(path);
        let state = ServerStateService::new(backend.clone());
        seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("project");
        seed_local_task(&state, LocalTaskSeed::nucleus_local_bootstrap()).expect("task");
        seed_local_task(
            &state,
            LocalTaskSeed {
                task_id: "task:nucleus-local:later".to_owned(),
                project_id: "project:nucleus-local".to_owned(),
                title: "Later task".to_owned(),
                action_type: TaskActionType::Plan,
                importance: TaskImportance::Normal,
            },
        )
        .expect("later task");
        let command_id = "command:mandate-goal";
        let mut handler = LocalControlRequestHandler::new(backend.clone(), None);
        let response = handler.handle(crate::control_api::ServerControlRequest {
            id: ServerControlRequestId(format!("request:{command_id}")),
            client_id: ClientId("client:test".to_owned()),
            kind: crate::control_api::ServerControlRequestKind::Command(ServerCommand {
                id: ServerCommandId(command_id.to_owned()),
                client_id: ClientId("client:test".to_owned()),
                kind: ServerCommandKind::Goal(crate::commands::GoalCommand::Create(
                    crate::commands::GoalCreateCommand {
                        project_id: ProjectId("project:nucleus-local".to_owned()),
                        title: "Mandated goal".to_owned(),
                        desired_outcome: "Prove bounded execution authority".to_owned(),
                        scope: "One seeded task".to_owned(),
                        status: GoalStatus::Ready,
                        owner_refs: vec!["operator:test".to_owned()],
                        ordered_task_refs: vec![TaskId("task:nucleus-local:bootstrap".to_owned())],
                        planning_artifact_refs: Vec::new(),
                        provenance_refs: vec!["conversation:mandate".to_owned()],
                        stop_conditions: vec!["Stop on failure".to_owned()],
                        evidence_refs: Vec::new(),
                        current_next_task_ref: Some(TaskId(
                            "task:nucleus-local:bootstrap".to_owned(),
                        )),
                        next_action: Some("Execute first task".to_owned()),
                    },
                )),
            }),
        });
        assert_eq!(
            response.status,
            crate::control_api::ServerControlResponseStatus::Accepted
        );
        let goal_id = format!("goal:{command_id}");
        let goal = goal_record(&state, "project:nucleus-local", &goal_id).expect("goal");
        (state, backend, goal_id, goal.revision_id)
    }

    fn chat_session(conversation_id: &str) -> StoredChatSession {
        StoredChatSession {
            conversation_id: conversation_id.to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            session_id: "session:test".to_owned(),
            provider_thread_id: "thread:test".to_owned(),
            model: "gpt-5.4-mini".to_owned(),
            reasoning_effort: Some("low".to_owned()),
            turn_count: 1,
            task_toolset_version: 4,
        }
    }
}
