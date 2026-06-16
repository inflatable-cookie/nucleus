//! Native harness session records.

use crate::backends::NativeModelBackendId;
use crate::personas::NativePersonaId;

/// Stable native harness session id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativeSessionId(pub String);

/// Nucleus-owned native harness session record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeHarnessSession {
    pub id: NativeSessionId,
    pub persona_id: NativePersonaId,
    pub model_backend_id: Option<NativeModelBackendId>,
    pub project_ref: Option<String>,
    pub task_ref: Option<String>,
    pub state: NativeSessionState,
}

/// Native session state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeSessionState {
    Created,
    Planning,
    WaitingForApproval,
    RunningTool,
    RunningModel,
    Paused,
    Completed,
    Failed(String),
}
