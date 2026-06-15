//! Agent session lifecycle types.

/// Stable nucleus agent session id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AgentSessionId(pub String);

/// Stable nucleus turn id within an agent session.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AgentTurnId(pub String);

/// Server-owned agent session record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentSessionRecord {
    pub id: AgentSessionId,
    pub adapter_id: String,
    pub provider_instance_id: String,
    pub provider_session_id: Option<String>,
    pub lifecycle_state: AgentSessionLifecycleState,
    pub recovery_state: AgentSessionRecoveryState,
    pub active_turn_id: Option<AgentTurnId>,
}

/// Agent session lifecycle state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentSessionLifecycleState {
    Created,
    Attached,
    Running,
    Paused,
    Cancelling,
    Closed,
    Failed(String),
}

/// Recovery state after restart or provider disconnect.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentSessionRecoveryState {
    NotNeeded,
    Recoverable,
    RecoveryRequired,
    RecoveryFailed(String),
    Unknown,
}

/// Session lifecycle action requested through an adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionLifecycleAction {
    Create,
    Attach,
    Resume,
    SendTurn,
    Steer,
    Pause,
    Cancel,
    Interrupt,
    Close,
    Rollback,
    RespondToApproval,
    RespondToUserInput,
    Recover,
}

/// Recorded lifecycle transition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentSessionStateChange {
    pub session_id: AgentSessionId,
    pub action: SessionLifecycleAction,
    pub from: Option<AgentSessionLifecycleState>,
    pub to: AgentSessionLifecycleState,
}

/// Turn record within an agent session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentTurnRecord {
    pub id: AgentTurnId,
    pub session_id: AgentSessionId,
    pub provider_turn_id: Option<String>,
    pub status: AgentTurnStatus,
}

/// Turn lifecycle status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentTurnStatus {
    Pending,
    Running,
    WaitingForApproval,
    WaitingForUserInput,
    Completed,
    Cancelled,
    Failed(String),
}
