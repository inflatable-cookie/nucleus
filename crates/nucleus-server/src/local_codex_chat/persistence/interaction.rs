//! Split from the local_codex_chat persistence god file; behavior unchanged.
//!
//! User-input question exchanges and plan decisions: the durable records
//! that carry pending interaction state across turn boundaries.

#[allow(unused_imports)]
use super::*;

use nucleus_agent_protocol::AgentUserInputRequest;
use nucleus_local_store::LocalStoreBackend;
use swallowtail_runtime::{
    CallbackOperationId, HarnessUserInputChoiceMode, HarnessUserInputQuestionKind,
    HarnessUserInputRequest, HarnessUserInputResponse,
};

use super::super::LocalCodexChatPlanDecisionRequest;

pub fn project_question(
    conversation_id: &str,
    turn_id: &str,
    request: &AgentUserInputRequest,
) -> Result<StoredChatQuestionExchange, String> {
    let questions = request
        .questions()
        .ok_or_else(|| "Agent Chat callback is not typed user input".to_owned())?;
    let runtime_operation_id = match request.callback.operation_id() {
        CallbackOperationId::Turn(id) => format!("turn:{}", id.as_str()),
        CallbackOperationId::Run(id) => format!("run:{}", id.as_str()),
    };
    Ok(StoredChatQuestionExchange {
        conversation_id: conversation_id.to_owned(),
        turn_id: turn_id.to_owned(),
        callback_id: request.callback.callback_id().as_str().to_owned(),
        runtime_operation_id,
        event_sequence: request.callback.event_sequence(),
        provider_request_ref: request
            .callback
            .provider_request_ref()
            .map(|reference| reference.as_provider_value().to_owned()),
        deadline_ticks: request
            .callback
            .deadline()
            .map(|deadline| deadline.instant().ticks()),
        auto_resolution_ms: questions.auto_resolution_ms(),
        status: "pending".to_owned(),
        questions: project_questions(questions),
        answers: Vec::new(),
    })
}

pub fn persist_question_pending<B>(
    state: &ServerStateService<B>,
    exchange: &StoredChatQuestionExchange,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let record_id = question_record_id(&exchange.turn_id, &exchange.callback_id);
    put_json(
        state,
        record_id.clone(),
        exchange,
        RevisionId(format!("rev:{}:pending", record_id.0)),
        RevisionExpectation::MustNotExist,
    )
}

pub fn persist_question_answer<B>(
    state: &ServerStateService<B>,
    turn_id: &str,
    callback_id: &str,
    request: &HarnessUserInputRequest,
    response: &HarnessUserInputResponse,
) -> Result<StoredChatQuestionExchange, String>
where
    B: LocalStoreBackend,
{
    let record_id = question_record_id(turn_id, callback_id);
    let record = state
        .agent_sessions()
        .get(&record_id)
        .map_err(storage_error)?
        .ok_or_else(|| "Agent Chat question record is missing".to_owned())?;
    let mut exchange = decode::<StoredChatQuestionExchange>(&record.payload.bytes)?;
    if exchange.status != "pending" {
        return Err("Agent Chat question is already resolved".to_owned());
    }
    exchange.status = "answered".to_owned();
    exchange.answers = project_answers(request, response);
    put_json(
        state,
        record_id.clone(),
        &exchange,
        RevisionId(format!("rev:{}:answered", record_id.0)),
        RevisionExpectation::Exact(record.revision_id),
    )?;
    Ok(exchange)
}

pub fn settle_pending_questions_for_turn<B>(
    state: &ServerStateService<B>,
    turn_id: &str,
    status: &str,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let records = state.agent_sessions().list().map_err(storage_error)?;
    for record in records
        .into_iter()
        .filter(|record| record.id.0.starts_with(QUESTION_PREFIX))
    {
        let mut exchange = decode::<StoredChatQuestionExchange>(&record.payload.bytes)?;
        if exchange.turn_id != turn_id || exchange.status != "pending" {
            continue;
        }
        exchange.status = status.to_owned();
        put_json(
            state,
            record.id.clone(),
            &exchange,
            RevisionId(format!("rev:{}:{status}", record.id.0)),
            RevisionExpectation::Exact(record.revision_id),
        )?;
    }
    Ok(())
}

fn project_questions(request: &HarnessUserInputRequest) -> Vec<StoredChatQuestion> {
    request
        .questions()
        .map(|question| {
            let (kind, allow_other) = match question.kind() {
                HarnessUserInputQuestionKind::Choice {
                    mode: HarnessUserInputChoiceMode::Single,
                    allow_other,
                } => ("single_choice", allow_other),
                HarnessUserInputQuestionKind::Choice {
                    mode: HarnessUserInputChoiceMode::Multiple,
                    allow_other,
                } => ("multiple_choice", allow_other),
                HarnessUserInputQuestionKind::Text { secret: false } => ("text", false),
                HarnessUserInputQuestionKind::Text { secret: true } => ("secret_text", false),
            };
            StoredChatQuestion {
                question_id: question.id().as_str().to_owned(),
                header: question.header().as_str().to_owned(),
                prompt: question.prompt().as_str().to_owned(),
                kind: kind.to_owned(),
                allow_other,
                options: question
                    .options()
                    .map(|option| StoredChatQuestionOption {
                        value: option.id().as_str().to_owned(),
                        label: option.label().as_str().to_owned(),
                        description: option
                            .description()
                            .map(|description| description.as_str().to_owned()),
                    })
                    .collect(),
            }
        })
        .collect()
}

fn project_answers(
    request: &HarnessUserInputRequest,
    response: &HarnessUserInputResponse,
) -> Vec<StoredChatQuestionAnswer> {
    response
        .answers()
        .map(|answer| {
            let secret = request
                .questions()
                .find(|question| question.id() == answer.question_id())
                .is_some_and(|question| {
                    matches!(
                        question.kind(),
                        HarnessUserInputQuestionKind::Text { secret: true }
                    )
                });
            StoredChatQuestionAnswer {
                question_id: answer.question_id().as_str().to_owned(),
                selected_option_ids: answer
                    .selected_options()
                    .map(|id| id.as_str().to_owned())
                    .collect(),
                text: if secret {
                    None
                } else {
                    answer.text().map(|text| text.as_str().to_owned())
                },
                skipped: answer.is_skipped(),
                redacted: secret && answer.text().is_some(),
            }
        })
        .collect()
}

fn question_record_id(turn_id: &str, callback_id: &str) -> PersistenceRecordId {
    let identity = blake3::hash(callback_id.as_bytes()).to_hex();
    PersistenceRecordId(format!("{QUESTION_PREFIX}{turn_id}:{identity}"))
}

pub fn now_unix_ms() -> Option<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn plan_record_id(turn_id: &str) -> PersistenceRecordId {
    PersistenceRecordId(format!("{PLAN_PREFIX}{turn_id}"))
}

pub fn persist_plan_pending<B>(
    state: &ServerStateService<B>,
    decision: &StoredChatPlanDecision,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    if decision.status != "pending" {
        return Err("Agent Chat plan must enter as pending".to_owned());
    }
    let record_id = plan_record_id(&decision.turn_id);
    put_json(
        state,
        record_id.clone(),
        decision,
        RevisionId(format!("rev:{}:pending", record_id.0)),
        RevisionExpectation::MustNotExist,
    )
}

pub fn settle_plan_decision<B>(
    state: &ServerStateService<B>,
    request: &LocalCodexChatPlanDecisionRequest,
    decided_at_unix_ms: Option<u64>,
    accept_turn_id: Option<String>,
) -> Result<StoredChatPlanDecision, String>
where
    B: LocalStoreBackend,
{
    let record_id = plan_record_id(&request.turn_id);
    let record = state
        .agent_sessions()
        .get(&record_id)
        .map_err(storage_error)?
        .ok_or_else(|| "Agent Chat plan decision record is missing".to_owned())?;
    let mut decision = decode::<StoredChatPlanDecision>(&record.payload.bytes)?;
    if decision.status != "pending" {
        return Err("Agent Chat plan is stale or already decided".to_owned());
    }
    if decision.conversation_id != request.conversation_id
        || decision.project_id != request.project_id
        || decision.runtime_operation_id != request.runtime_operation_id
        || decision.activity_id != request.activity_id
    {
        return Err("Agent Chat plan correlation does not match".to_owned());
    }
    decision.status = request.decision.as_str().to_owned();
    decision.decided_at_unix_ms = decided_at_unix_ms;
    decision.accept_turn_id = accept_turn_id;
    put_json(
        state,
        record_id.clone(),
        &decision,
        RevisionId(format!("rev:{}:{}", record_id.0, decision.status)),
        RevisionExpectation::Exact(record.revision_id),
    )?;
    Ok(decision)
}

pub fn settle_pending_plan_for_conversation<B>(
    state: &ServerStateService<B>,
    conversation_id: &str,
    status: &str,
    decided_at_unix_ms: Option<u64>,
) -> Result<Option<StoredChatPlanDecision>, String>
where
    B: LocalStoreBackend,
{
    let records = state.agent_sessions().list().map_err(storage_error)?;
    let pending = records
        .into_iter()
        .filter(|record| record.id.0.starts_with(PLAN_PREFIX))
        .map(|record| {
            decode::<StoredChatPlanDecision>(&record.payload.bytes)
                .map(|decision| (record, decision))
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .find(|(_, decision)| {
            decision.conversation_id == conversation_id && decision.status == "pending"
        });
    let Some((record, mut decision)) = pending else {
        return Ok(None);
    };
    decision.status = status.to_owned();
    decision.decided_at_unix_ms = decided_at_unix_ms;
    put_json(
        state,
        record.id.clone(),
        &decision,
        RevisionId(format!("rev:{}:{status}", record.id.0)),
        RevisionExpectation::Exact(record.revision_id),
    )?;
    Ok(Some(decision))
}
