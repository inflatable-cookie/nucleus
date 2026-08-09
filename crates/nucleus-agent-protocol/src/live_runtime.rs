//! Live agent runtime boundary.
//!
//! The first executable adapter contract: hosts start sessions and send
//! turns through these traits without knowing which provider is behind
//! them. Tool-call semantics stay host-side via the callback; providers
//! own process, transport, and wire protocol.

use serde_json::Value;
use std::fmt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, Weak,
};
use std::task::{Context, Poll, Waker};
use std::time::Duration;
use swallowtail_runtime::{
    CallbackRequest, ConfiguredProviderInstanceRecord, HarnessUserInputRequest,
    HarnessUserInputResponse,
};

use crate::AgentActivityHandler;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum AgentHarnessMode {
    #[default]
    Normal,
    Plan,
}

/// Request to start (or resume) a provider-backed agent session.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentSessionStartRequest {
    pub working_directory: String,
    pub provider_instance_id: String,
    pub provider_instance_revision: String,
    pub protocol_facade_id: String,
    pub provider_id: Option<String>,
    pub model: String,
    pub reasoning_effort: String,
    pub harness_mode: AgentHarnessMode,
    pub developer_instructions: String,
    pub dynamic_tools: Vec<Value>,
    pub resume_provider_thread_id: Option<String>,
    pub turn_timeout: Duration,
    /// Whether the session may fold AGENTS.md idioms into its developer
    /// instructions (Contract 056 route opt-in).
    pub idioms_enabled: bool,
}

/// Provider-assigned identity and effective settings of a started session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentStartedSessionInfo {
    pub provider_thread_id: String,
    pub adapter_id: String,
    pub provider_instance_id: String,
    pub provider_instance_revision: String,
    pub protocol_facade_id: String,
    pub provider_id: Option<String>,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub harness_mode: AgentHarnessMode,
}

/// One turn sent into a live session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentTurnRequest {
    pub message: String,
    pub model: String,
    pub reasoning_effort: String,
    pub cancellation: AgentTurnCancellation,
}

/// Consumer-owned cancellation signal for one provider turn.
#[derive(Clone)]
pub struct AgentTurnCancellation {
    inner: Arc<AgentTurnCancellationState>,
}

struct AgentTurnCancellationState {
    requested: AtomicBool,
    waker: Mutex<Option<Waker>>,
}

impl AgentTurnCancellation {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(AgentTurnCancellationState {
                requested: AtomicBool::new(false),
                waker: Mutex::new(None),
            }),
        }
    }

    /// Returns true only for the first request.
    pub fn request(&self) -> bool {
        if self.inner.requested.swap(true, Ordering::AcqRel) {
            return false;
        }
        if let Ok(mut waker) = self.inner.waker.lock() {
            if let Some(waker) = waker.take() {
                waker.wake();
            }
        }
        true
    }

    pub fn is_requested(&self) -> bool {
        self.inner.requested.load(Ordering::Acquire)
    }

    pub fn poll_requested(&self, context: &mut Context<'_>) -> Poll<()> {
        if self.is_requested() {
            return Poll::Ready(());
        }
        if let Ok(mut waker) = self.inner.waker.lock() {
            *waker = Some(context.waker().clone());
        }
        if self.is_requested() {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    }

    pub fn same_request(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

impl Default for AgentTurnCancellation {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for AgentTurnCancellation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentTurnCancellation")
            .field("requested", &self.is_requested())
            .finish()
    }
}

impl PartialEq for AgentTurnCancellation {
    fn eq(&self, other: &Self) -> bool {
        self.same_request(other)
    }
}

impl Eq for AgentTurnCancellation {}

/// Exact terminal failure observed at the consumer adapter boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentTurnFailure {
    Cancelled,
    TimedOut,
    CleanupFailed(String),
    Failed(String),
}

impl fmt::Display for AgentTurnFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => formatter.write_str("agent turn was cancelled"),
            Self::TimedOut => formatter.write_str("agent turn timed out"),
            Self::CleanupFailed(reason) => formatter.write_str(reason),
            Self::Failed(reason) => formatter.write_str(reason),
        }
    }
}

impl std::error::Error for AgentTurnFailure {}

impl From<String> for AgentTurnFailure {
    fn from(reason: String) -> Self {
        Self::Failed(reason)
    }
}

/// Completed turn output.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentTurnReply {
    pub turn_id: String,
    /// The final assistant message when the turn produced one. A plan-mode
    /// turn whose outcome is a proposed plan completes without one.
    pub assistant_message: Option<String>,
}

/// A provider-surfaced dynamic tool call awaiting a host response.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentToolCall {
    pub tool: String,
    pub turn_id: String,
    pub call_id: String,
    pub arguments: Value,
}

/// Host handler for dynamic tool calls: returns the text result shown to
/// the provider, or an error text. Side effects and receipts are the
/// host's business.
pub type AgentToolCallHandler<'a> = dyn FnMut(AgentToolCall) -> Result<String, String> + 'a;

/// One portable provider question with its exact callback correlation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentUserInputRequest {
    pub callback: CallbackRequest,
}

impl AgentUserInputRequest {
    pub fn questions(&self) -> Option<&HarnessUserInputRequest> {
        match self.callback.kind() {
            swallowtail_runtime::CallbackRequestKind::HarnessUserInput(request) => Some(request),
            _ => None,
        }
    }
}

enum AgentUserInputWaitState {
    Pending,
    Answered(HarnessUserInputResponse),
    Abandoned(String),
}

struct AgentUserInputWaitInner {
    request: HarnessUserInputRequest,
    state: Mutex<AgentUserInputWaitState>,
    waker: Mutex<Option<Waker>>,
}

/// Turn-owned half of a typed question rendezvous.
pub struct AgentUserInputWait {
    inner: Arc<AgentUserInputWaitInner>,
}

/// Separately routable answer half of a typed question rendezvous.
#[derive(Clone)]
pub struct AgentUserInputAnswerer {
    inner: Weak<AgentUserInputWaitInner>,
}

impl AgentUserInputWait {
    pub fn pending(request: HarnessUserInputRequest) -> (Self, AgentUserInputAnswerer) {
        let inner = Arc::new(AgentUserInputWaitInner {
            request,
            state: Mutex::new(AgentUserInputWaitState::Pending),
            waker: Mutex::new(None),
        });
        (
            Self {
                inner: Arc::clone(&inner),
            },
            AgentUserInputAnswerer {
                inner: Arc::downgrade(&inner),
            },
        )
    }

    pub fn poll_response(
        &mut self,
        context: &mut Context<'_>,
    ) -> Poll<Result<HarnessUserInputResponse, String>> {
        if let Ok(mut state) = self.inner.state.lock() {
            match &*state {
                AgentUserInputWaitState::Answered(_) => {
                    let AgentUserInputWaitState::Answered(response) = std::mem::replace(
                        &mut *state,
                        AgentUserInputWaitState::Abandoned(
                            "typed user-input response was already consumed".to_owned(),
                        ),
                    ) else {
                        unreachable!()
                    };
                    return Poll::Ready(Ok(response));
                }
                AgentUserInputWaitState::Abandoned(reason) => {
                    return Poll::Ready(Err(reason.clone()));
                }
                AgentUserInputWaitState::Pending => {}
            }
        } else {
            return Poll::Ready(Err("typed user-input wait state is unavailable".to_owned()));
        }
        if let Ok(mut waker) = self.inner.waker.lock() {
            *waker = Some(context.waker().clone());
        }
        Poll::Pending
    }

    pub fn abandon(&self, reason: impl Into<String>) {
        if let Ok(mut state) = self.inner.state.lock() {
            if matches!(*state, AgentUserInputWaitState::Pending) {
                *state = AgentUserInputWaitState::Abandoned(reason.into());
            }
        }
        if let Ok(mut waker) = self.inner.waker.lock() {
            if let Some(waker) = waker.take() {
                waker.wake();
            }
        }
    }
}

impl Drop for AgentUserInputWait {
    fn drop(&mut self) {
        self.abandon("typed user-input request is no longer active");
    }
}

impl AgentUserInputAnswerer {
    pub fn respond(&self, response: HarnessUserInputResponse) -> Result<(), String> {
        let inner = self
            .inner
            .upgrade()
            .ok_or_else(|| "typed user-input request is stale".to_owned())?;
        if !inner.request.accepts(&response) {
            return Err("typed user-input response does not match the pending request".to_owned());
        }
        let mut state = inner
            .state
            .lock()
            .map_err(|_| "typed user-input wait state is unavailable".to_owned())?;
        if !matches!(*state, AgentUserInputWaitState::Pending) {
            return Err("typed user-input request is already resolved".to_owned());
        }
        *state = AgentUserInputWaitState::Answered(response);
        drop(state);
        if let Ok(mut waker) = inner.waker.lock() {
            if let Some(waker) = waker.take() {
                waker.wake();
            }
        }
        Ok(())
    }

    pub fn abandon(&self, reason: impl Into<String>) -> Result<(), String> {
        let inner = self
            .inner
            .upgrade()
            .ok_or_else(|| "typed user-input request is stale".to_owned())?;
        let mut state = inner
            .state
            .lock()
            .map_err(|_| "typed user-input wait state is unavailable".to_owned())?;
        if !matches!(*state, AgentUserInputWaitState::Pending) {
            return Err("typed user-input request is already resolved".to_owned());
        }
        *state = AgentUserInputWaitState::Abandoned(reason.into());
        drop(state);
        if let Ok(mut waker) = inner.waker.lock() {
            if let Some(waker) = waker.take() {
                waker.wake();
            }
        }
        Ok(())
    }
}

pub type AgentUserInputHandler<'a> =
    dyn FnMut(AgentUserInputRequest) -> Result<AgentUserInputWait, String> + 'a;

/// A live provider-backed session.
pub trait AgentLiveSession {
    fn info(&self) -> &AgentStartedSessionInfo;

    fn send_turn(
        &mut self,
        request: AgentTurnRequest,
        on_activity: &mut AgentActivityHandler<'_>,
        on_tool_call: &mut AgentToolCallHandler<'_>,
        on_user_input: &mut AgentUserInputHandler<'_>,
    ) -> Result<AgentTurnReply, AgentTurnFailure>;
}

#[cfg(test)]
mod tests {
    use super::{AgentTurnCancellation, AgentUserInputWait};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::task::{Context, Poll, Wake, Waker};

    #[test]
    fn cancellation_is_idempotent_and_request_scoped() {
        let cancellation = AgentTurnCancellation::new();
        let same = cancellation.clone();
        let other = AgentTurnCancellation::new();

        assert!(cancellation.same_request(&same));
        assert!(!cancellation.same_request(&other));
        assert!(cancellation.request());
        assert!(!same.request());
        assert!(same.is_requested());
        assert!(!other.is_requested());
    }

    #[test]
    fn cancellation_wakes_a_pending_turn_loop() {
        struct WakeFlag(AtomicBool);
        impl Wake for WakeFlag {
            fn wake(self: Arc<Self>) {
                self.0.store(true, Ordering::Release);
            }
        }

        let cancellation = AgentTurnCancellation::new();
        let wake_flag = Arc::new(WakeFlag(AtomicBool::new(false)));
        let waker = Waker::from(wake_flag.clone());
        let mut context = Context::from_waker(&waker);
        assert_eq!(cancellation.poll_requested(&mut context), Poll::Pending);

        assert!(cancellation.request());
        assert!(wake_flag.0.load(Ordering::Acquire));
        assert_eq!(cancellation.poll_requested(&mut context), Poll::Ready(()));
    }

    #[test]
    fn typed_user_input_rendezvous_accepts_one_matching_response() {
        use swallowtail_runtime::{
            HarnessQuestionId, HarnessUserInputAnswer, HarnessUserInputQuestion,
            HarnessUserInputQuestionKind, HarnessUserInputRequest, HarnessUserInputResponse,
            OperationContent,
        };

        let question_id = HarnessQuestionId::new("choice").expect("question id");
        let question = HarnessUserInputQuestion::new(
            question_id.clone(),
            OperationContent::new("Choice").expect("header"),
            OperationContent::new("Choose").expect("prompt"),
            HarnessUserInputQuestionKind::Text { secret: false },
            [],
        )
        .expect("question");
        let request = HarnessUserInputRequest::new([question], None, 1, 1, 1024).expect("request");
        let (mut waiting, answerer) = AgentUserInputWait::pending(request);
        let response = HarnessUserInputResponse::new(
            [HarnessUserInputAnswer::selected(
                question_id,
                [],
                Some(OperationContent::new("answer").expect("answer")),
            )],
            1,
            1024,
        )
        .expect("response");

        answerer.respond(response.clone()).expect("first answer");
        assert!(answerer.respond(response).is_err());

        struct Noop;
        impl std::task::Wake for Noop {
            fn wake(self: Arc<Self>) {}
        }
        let waker = Waker::from(Arc::new(Noop));
        let mut context = Context::from_waker(&waker);
        assert!(matches!(
            waiting.poll_response(&mut context),
            Poll::Ready(Ok(_))
        ));
    }
}

/// A provider runtime that can start sessions and admit its configured instance.
pub trait AgentSessionRuntime {
    fn adapter_id(&self) -> &str;

    fn start_session(
        &self,
        request: AgentSessionStartRequest,
    ) -> Result<Box<dyn AgentLiveSession + Send>, String>;

    fn configured_provider_instance(&self) -> Result<ConfiguredProviderInstanceRecord, String>;
}
