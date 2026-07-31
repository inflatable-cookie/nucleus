use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use nucleus_agent_protocol::{AgentUserInputAnswerer, AgentUserInputRequest, AgentUserInputWait};
use serde::{Deserialize, Serialize};
use swallowtail_runtime::{
    CallbackOperationId, HarnessQuestionId, HarnessQuestionOptionId, HarnessUserInputAnswer,
    HarnessUserInputRequest, HarnessUserInputResponse, OperationContent,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatQuestionAnswerRequest {
    pub project_id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub callback_id: String,
    pub runtime_operation_id: String,
    pub event_sequence: u64,
    pub provider_request_ref: Option<String>,
    pub answers: Vec<LocalCodexChatQuestionAnswer>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatQuestionAnswer {
    pub question_id: String,
    #[serde(default)]
    pub selected_option_ids: Vec<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub skipped: bool,
}

#[derive(Clone)]
struct PendingQuestion {
    project_id: String,
    turn_id: String,
    runtime_operation_id: String,
    event_sequence: u64,
    provider_request_ref: Option<String>,
    request: HarnessUserInputRequest,
    answerer: AgentUserInputAnswerer,
}

#[derive(Clone, Default)]
pub struct LocalCodexChatQuestionRegistry {
    pending: Arc<Mutex<HashMap<(String, String), PendingQuestion>>>,
}

pub struct AcceptedLocalCodexChatQuestionAnswer {
    pub request: HarnessUserInputRequest,
    pub response: HarnessUserInputResponse,
}

impl LocalCodexChatQuestionRegistry {
    pub fn register(
        &self,
        project_id: &str,
        conversation_id: &str,
        turn_id: &str,
        request: AgentUserInputRequest,
    ) -> Result<AgentUserInputWait, String> {
        let callback_id = request.callback.callback_id().as_str().to_owned();
        let runtime_operation_id = operation_id(&request.callback);
        let event_sequence = request.callback.event_sequence();
        let provider_request_ref = request
            .callback
            .provider_request_ref()
            .map(|reference| reference.as_provider_value().to_owned());
        let questions = request
            .questions()
            .cloned()
            .ok_or_else(|| "Agent Chat received a non-question callback".to_owned())?;
        let key = (conversation_id.to_owned(), callback_id);
        let (wait, answerer) = AgentUserInputWait::pending(questions.clone());
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Agent Chat question registry is unavailable".to_owned())?;
        if pending.contains_key(&key) {
            return Err("Agent Chat question callback is already pending".to_owned());
        }
        pending.insert(
            key,
            PendingQuestion {
                project_id: project_id.to_owned(),
                turn_id: turn_id.to_owned(),
                runtime_operation_id,
                event_sequence,
                provider_request_ref,
                request: questions,
                answerer,
            },
        );
        Ok(wait)
    }

    pub fn answer_with<F>(
        &self,
        request: LocalCodexChatQuestionAnswerRequest,
        before_resolve: F,
    ) -> Result<AcceptedLocalCodexChatQuestionAnswer, String>
    where
        F: FnOnce(&HarnessUserInputRequest, &HarnessUserInputResponse) -> Result<(), String>,
    {
        let key = (request.conversation_id.clone(), request.callback_id.clone());
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Agent Chat question registry is unavailable".to_owned())?;
        let held = pending
            .get(&key)
            .ok_or_else(|| "Agent Chat question is stale or already resolved".to_owned())?
            .clone();
        if held.project_id != request.project_id
            || held.turn_id != request.turn_id
            || held.runtime_operation_id != request.runtime_operation_id
            || held.event_sequence != request.event_sequence
            || held.provider_request_ref != request.provider_request_ref
        {
            return Err("Agent Chat question correlation does not match".to_owned());
        }
        let response = build_response(request.answers)?;
        if !held.request.accepts(&response) {
            return Err("typed user-input response does not match the pending request".to_owned());
        }
        before_resolve(&held.request, &response)?;
        held.answerer.respond(response.clone())?;
        pending.remove(&key);
        Ok(AcceptedLocalCodexChatQuestionAnswer {
            request: held.request,
            response,
        })
    }

    pub fn abandon_turn(
        &self,
        project_id: &str,
        conversation_id: &str,
        turn_id: &str,
        reason: &str,
    ) {
        let Ok(mut pending) = self.pending.lock() else {
            return;
        };
        let keys: Vec<_> = pending
            .iter()
            .filter(|((conversation, _), held)| {
                conversation == conversation_id
                    && held.project_id == project_id
                    && held.turn_id == turn_id
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in keys {
            if let Some(held) = pending.remove(&key) {
                let _ = held.answerer.abandon(reason.to_owned());
            }
        }
    }

    pub fn abandon_conversation(&self, project_id: &str, conversation_id: &str, reason: &str) {
        let Ok(mut pending) = self.pending.lock() else {
            return;
        };
        let keys: Vec<_> = pending
            .iter()
            .filter(|((conversation, _), held)| {
                conversation == conversation_id && held.project_id == project_id
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in keys {
            if let Some(held) = pending.remove(&key) {
                let _ = held.answerer.abandon(reason.to_owned());
            }
        }
    }
}

fn operation_id(request: &swallowtail_runtime::CallbackRequest) -> String {
    match request.operation_id() {
        CallbackOperationId::Turn(id) => format!("turn:{}", id.as_str()),
        CallbackOperationId::Run(id) => format!("run:{}", id.as_str()),
    }
}

fn build_response(
    answers: Vec<LocalCodexChatQuestionAnswer>,
) -> Result<HarnessUserInputResponse, String> {
    let answers = answers
        .into_iter()
        .map(|answer| {
            let question_id =
                HarnessQuestionId::new(answer.question_id).map_err(|error| error.to_string())?;
            if answer.skipped {
                return Ok(HarnessUserInputAnswer::skipped(question_id));
            }
            let selected = answer
                .selected_option_ids
                .into_iter()
                .map(|id| HarnessQuestionOptionId::new(id).map_err(|error| error.to_string()))
                .collect::<Result<Vec<_>, _>>()?;
            let text = answer
                .text
                .map(OperationContent::new)
                .transpose()
                .map_err(|error| error.to_string())?;
            Ok(HarnessUserInputAnswer::selected(
                question_id,
                selected,
                text,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    HarnessUserInputResponse::new(answers, 32, 256 * 1024).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_agent_protocol::AgentUserInputRequest;
    use swallowtail_runtime::{
        CallbackId, CallbackRequest, HarnessUserInputQuestion, HarnessUserInputQuestionKind,
        RuntimeTurnId,
    };

    fn request() -> AgentUserInputRequest {
        let question = HarnessUserInputQuestion::new(
            HarnessQuestionId::new("name").expect("question id"),
            OperationContent::new("Name").expect("header"),
            OperationContent::new("What name?").expect("prompt"),
            HarnessUserInputQuestionKind::Text { secret: false },
            [],
        )
        .expect("question");
        AgentUserInputRequest {
            callback: CallbackRequest::harness_user_input(
                CallbackId::new("callback-1").expect("callback id"),
                RuntimeTurnId::new("runtime-turn-1").expect("turn id"),
                7,
                None,
                HarnessUserInputRequest::new([question], None, 1, 1, 1024)
                    .expect("question request"),
            ),
        }
    }

    fn answer() -> LocalCodexChatQuestionAnswerRequest {
        LocalCodexChatQuestionAnswerRequest {
            project_id: "project-1".to_owned(),
            conversation_id: "conversation-1".to_owned(),
            turn_id: "turn-1".to_owned(),
            callback_id: "callback-1".to_owned(),
            runtime_operation_id: "turn:runtime-turn-1".to_owned(),
            event_sequence: 7,
            provider_request_ref: None,
            answers: vec![LocalCodexChatQuestionAnswer {
                question_id: "name".to_owned(),
                selected_option_ids: Vec::new(),
                text: Some("Nucleus".to_owned()),
                skipped: false,
            }],
        }
    }

    #[test]
    fn registry_routes_one_exact_answer_without_a_service_lock() {
        let registry = LocalCodexChatQuestionRegistry::default();
        let mut wait = registry
            .register("project-1", "conversation-1", "turn-1", request())
            .expect("register");
        let accepted = registry
            .answer_with(answer(), |_, _| Ok(()))
            .expect("answer");
        assert_eq!(accepted.response.answers().len(), 1);
        assert!(registry.answer_with(answer(), |_, _| Ok(())).is_err());

        use std::task::{Context, Poll, Wake, Waker};
        struct Noop;
        impl Wake for Noop {
            fn wake(self: Arc<Self>) {}
        }
        let waker = Waker::from(Arc::new(Noop));
        let mut context = Context::from_waker(&waker);
        assert!(matches!(
            wait.poll_response(&mut context),
            Poll::Ready(Ok(_))
        ));
    }

    #[test]
    fn correlation_mismatch_does_not_consume_the_pending_question() {
        let registry = LocalCodexChatQuestionRegistry::default();
        let _wait = registry
            .register("project-1", "conversation-1", "turn-1", request())
            .expect("register");
        let mut mismatched = answer();
        mismatched.turn_id = "other-turn".to_owned();
        assert!(registry.answer_with(mismatched, |_, _| Ok(())).is_err());
        let mut mismatched = answer();
        mismatched.runtime_operation_id = "turn:other-runtime-turn".to_owned();
        assert!(registry.answer_with(mismatched, |_, _| Ok(())).is_err());
        let mut mismatched = answer();
        mismatched.event_sequence = 8;
        assert!(registry.answer_with(mismatched, |_, _| Ok(())).is_err());
        let mut mismatched = answer();
        mismatched.provider_request_ref = Some("provider-request:other".to_owned());
        assert!(registry.answer_with(mismatched, |_, _| Ok(())).is_err());
        assert!(registry.answer_with(answer(), |_, _| Ok(())).is_ok());
    }

    #[test]
    fn cancellation_abandons_the_wait_and_rejects_a_stale_answer() {
        let registry = LocalCodexChatQuestionRegistry::default();
        let mut wait = registry
            .register("project-1", "conversation-1", "turn-1", request())
            .expect("register");
        registry.abandon_conversation("project-1", "conversation-1", "cancelled");
        assert!(registry.answer_with(answer(), |_, _| Ok(())).is_err());

        use std::task::{Context, Poll, Wake, Waker};
        struct Noop;
        impl Wake for Noop {
            fn wake(self: Arc<Self>) {}
        }
        let waker = Waker::from(Arc::new(Noop));
        let mut context = Context::from_waker(&waker);
        assert!(matches!(
            wait.poll_response(&mut context),
            Poll::Ready(Err(_))
        ));
    }
}
