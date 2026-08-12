//! Split from the local_codex_chat persistence god file; behavior unchanged.

#[allow(unused_imports)]
use super::*;

use nucleus_local_store::LocalStoreBackend;

use super::super::subagent_directory::read_subagent_directories;
use super::super::subagent_selection::read_chat_actor_selection;

pub fn read_session<B>(
    state: &ServerStateService<B>,
    conversation_id: &str,
) -> Result<Option<StoredChatSession>, String>
where
    B: LocalStoreBackend,
{
    state
        .agent_sessions()
        .get(&session_record_id(conversation_id))
        .map_err(storage_error)?
        .map(|record| decode(&record.payload.bytes))
        .transpose()
}

pub fn read_history<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    conversation_id: &str,
) -> Result<LocalCodexChatHistory, String>
where
    B: LocalStoreBackend,
{
    let session =
        read_session(state, conversation_id)?.filter(|session| session.project_id == project_id);
    let mut turns = state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(TURN_PREFIX))
        .map(|record| decode::<StoredChatTurn>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    turns.retain(|turn| turn.conversation_id == conversation_id);
    turns.sort_by_key(|turn| turn.ordinal);
    let mut messages = state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(MESSAGE_PREFIX))
        .map(|record| decode::<StoredChatMessage>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    messages.retain(|message| message.conversation_id == conversation_id);
    messages.sort_by_key(|message| message.sequence);
    let mut activities = state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(ACTIVITY_PREFIX))
        .map(|record| decode::<StoredChatActivity>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    activities.retain(|activity| activity.conversation_id == conversation_id);
    activities.sort_by_key(|activity| (activity.turn_ordinal, activity.sequence));
    let mut questions = state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(QUESTION_PREFIX))
        .map(|record| decode::<StoredChatQuestionExchange>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    questions.retain(|question| question.conversation_id == conversation_id);
    questions.sort_by_key(|question| question.event_sequence);
    let mut plan_decisions = state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(PLAN_PREFIX))
        .map(|record| decode::<StoredChatPlanDecision>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    plan_decisions.retain(|decision| decision.conversation_id == conversation_id);
    plan_decisions.sort_by_key(|decision| decision.turn_ordinal);
    let subagent_directories = read_subagent_directories(state, project_id, conversation_id)?;
    let actor_selection = read_chat_actor_selection(state, project_id, conversation_id)?;

    Ok(LocalCodexChatHistory {
        conversation_id: conversation_id.to_owned(),
        project_id: project_id.to_owned(),
        session_id: session.as_ref().map(|session| session.session_id.clone()),
        thread_id: session
            .as_ref()
            .map(|session| session.provider_thread_id.clone()),
        provider_instance_id: session
            .as_ref()
            .map(|session| session.provider_instance_id.clone()),
        provider_instance_revision: session
            .as_ref()
            .map(|session| session.provider_instance_revision.clone()),
        protocol_facade_id: session
            .as_ref()
            .map(|session| session.protocol_facade_id.clone()),
        provider_id: session
            .as_ref()
            .and_then(|session| session.provider_id.clone()),
        model: session.as_ref().map(|session| session.model.clone()),
        reasoning_effort: session
            .as_ref()
            .and_then(|session| session.reasoning_effort.clone()),
        harness_mode: session.as_ref().map(|session| session.harness_mode),
        turns: turns
            .into_iter()
            .map(|turn| LocalCodexChatHistoryTurn {
                turn_id: turn.turn_id,
                ordinal: turn.ordinal,
                status: turn.status,
                failure_reason: turn.failure_reason,
            })
            .collect(),
        messages,
        activities,
        questions,
        plan_decisions,
        subagent_directories,
        actor_selection,
    })
}

pub fn persist_session<B>(state: &ServerStateService<B>, session: &StoredChatSession) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    put_json(
        state,
        session_record_id(&session.conversation_id),
        session,
        RevisionId(format!(
            "rev:{}:{}",
            session_record_id(&session.conversation_id).0,
            session.turn_count
        )),
        RevisionExpectation::Any,
    )
}

pub fn recover_interrupted_chat_state<B>(state: &ServerStateService<B>) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let records = state.agent_sessions().list().map_err(storage_error)?;
    let interrupted_turns = records
        .iter()
        .filter(|record| record.id.0.starts_with(TURN_PREFIX))
        .map(|record| decode::<StoredChatTurn>(&record.payload.bytes).map(|turn| (record, turn)))
        .collect::<Result<Vec<_>, _>>()?;
    for (record, mut turn) in interrupted_turns {
        if turn.status != "started" {
            continue;
        }
        turn.status = "failed".to_owned();
        turn.failure_reason = Some("Agent Chat runtime restarted during the turn".to_owned());
        put_json(
            state,
            record.id.clone(),
            &turn,
            RevisionId(format!("rev:{}:restart", record.id.0)),
            RevisionExpectation::Exact(record.revision_id.clone()),
        )?;
        settle_pending_questions_for_turn(state, &turn.turn_id, "abandoned")?;
    }
    Ok(())
}

pub(super) fn session_record_id(conversation_id: &str) -> PersistenceRecordId {
    PersistenceRecordId(format!("{SESSION_PREFIX}{conversation_id}"))
}
