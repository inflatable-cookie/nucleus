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
    Arc, Mutex,
};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

/// Request to start (or resume) a provider-backed agent session.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentSessionStartRequest {
    pub working_directory: String,
    pub model: String,
    pub reasoning_effort: String,
    pub developer_instructions: String,
    pub dynamic_tools: Vec<Value>,
    pub resume_provider_thread_id: Option<String>,
    pub turn_timeout: Duration,
}

/// Provider-assigned identity and effective settings of a started session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentStartedSessionInfo {
    pub provider_thread_id: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
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
    pub assistant_message: String,
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

/// One model option a provider offers.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentModelOption {
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<AgentReasoningOption>,
}

/// One reasoning-effort option for a model.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentReasoningOption {
    pub reasoning_effort: String,
    pub description: String,
}

/// A live provider-backed session.
pub trait AgentLiveSession {
    fn info(&self) -> &AgentStartedSessionInfo;

    fn send_turn(
        &mut self,
        request: AgentTurnRequest,
        on_tool_call: &mut AgentToolCallHandler<'_>,
    ) -> Result<AgentTurnReply, AgentTurnFailure>;
}

#[cfg(test)]
mod tests {
    use super::AgentTurnCancellation;
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
}

/// A provider runtime that can start sessions and list models.
pub trait AgentSessionRuntime {
    fn adapter_id(&self) -> &str;

    fn start_session(
        &self,
        request: AgentSessionStartRequest,
    ) -> Result<Box<dyn AgentLiveSession + Send>, String>;

    fn model_catalog(&self) -> Result<Vec<AgentModelOption>, String>;
}
