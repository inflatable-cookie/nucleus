use std::time::Duration;

use nucleus_agent_adapters::AgentAdapterRegistry;
pub(super) use nucleus_agent_protocol::{TaskExecutionLinkage, TaskExecutionOutcome};
use nucleus_agent_protocol::{TaskExecutionRequest as RuntimeRequest, TaskExecutionRuntime};

use super::GoalRunRoute;

const TASK_TURN_TIMEOUT: Duration = Duration::from_secs(900);
const TASK_DEVELOPER_INSTRUCTIONS: &str = "Execute only the supplied Nucleus task. Work inside the project workspace. Do not mutate Nucleus task, Goal, review, mandate, or SCM publication state. Stop when a stated stop condition applies. Do not request broader scope.";

pub(super) struct TaskExecutionRequest<'a> {
    pub session_id: &'a str,
    pub project_root: &'a str,
    pub route: &'a GoalRunRoute,
    pub prompt: &'a str,
}

pub(super) fn run_task<F>(
    request: TaskExecutionRequest<'_>,
    mut on_started: F,
) -> Result<TaskExecutionOutcome, String>
where
    F: FnMut(&TaskExecutionLinkage) -> Result<(), String>,
{
    let reasoning_effort = request
        .route
        .reasoning_effort
        .clone()
        .ok_or_else(|| "task execution route has no reasoning effort".to_owned())?;
    task_runtime(request.route.adapter_id.as_str())?.execute(
        RuntimeRequest {
            session_id: request.session_id.to_owned(),
            working_directory: request.project_root.to_owned(),
            provider_instance_id: request.route.provider_instance_id.clone(),
            model: request.route.model.clone(),
            reasoning_effort,
            developer_instructions: TASK_DEVELOPER_INSTRUCTIONS.to_owned(),
            prompt: request.prompt.to_owned(),
            timeout: TASK_TURN_TIMEOUT,
        },
        &mut on_started,
    )
}

fn task_runtime(
    adapter_id: &str,
) -> Result<std::sync::Arc<dyn TaskExecutionRuntime + Send + Sync>, String> {
    AgentAdapterRegistry::with_builtin_adapters().task_runtime(adapter_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_runtime_resolves_through_the_live_registry() {
        assert!(task_runtime("codex-app-server").is_ok());
        assert!(task_runtime("unknown").is_err());
    }
}
