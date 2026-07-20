//! Provider-neutral task-execution port owned by Nucleus.
//!
//! Product task, Goal, review, and receipt state stay outside this boundary.
//! Implementations own provider transport and return only bounded linkage and
//! terminal meaning.

use std::time::Duration;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskExecutionRequest {
    pub session_id: String,
    pub working_directory: String,
    pub provider_instance_id: String,
    pub model: String,
    pub reasoning_effort: String,
    pub developer_instructions: String,
    pub prompt: String,
    pub timeout: Duration,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskExecutionLinkage {
    pub session_id: String,
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskExecutionOutcome {
    Completed(TaskExecutionLinkage),
    WaitingForApproval(TaskExecutionLinkage),
    WaitingForUserInput(TaskExecutionLinkage),
    Cancelled {
        linkage: Option<TaskExecutionLinkage>,
        reason: String,
    },
    Failed {
        linkage: Option<TaskExecutionLinkage>,
        reason: String,
    },
    RecoveryRequired {
        linkage: Option<TaskExecutionLinkage>,
        reason: String,
    },
}

pub type TaskExecutionStartedHandler<'a> =
    dyn FnMut(&TaskExecutionLinkage) -> Result<(), String> + 'a;

pub trait TaskExecutionRuntime {
    fn adapter_id(&self) -> &str;

    fn execute(
        &self,
        request: TaskExecutionRequest,
        on_started: &mut TaskExecutionStartedHandler<'_>,
    ) -> Result<TaskExecutionOutcome, String>;
}
