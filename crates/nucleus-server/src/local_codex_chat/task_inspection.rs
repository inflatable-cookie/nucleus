use nucleus_core::PersistenceRecordId;
use nucleus_local_store::LocalStoreBackend;
use serde::Deserialize;
use serde_json::Value;

use super::task_authoring::TaskToolOutcome;
use crate::{ControlTaskRecordDto, ServerStateService};

pub(super) fn active_task<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    task_id: &str,
) -> Result<ControlTaskRecordDto, String>
where
    B: LocalStoreBackend,
{
    let record = state
        .tasks()
        .get(&PersistenceRecordId(task_id.to_owned()))
        .map_err(|error| format!("active task lookup failed: {error:?}"))?
        .ok_or_else(|| format!("active task not found: {task_id}"))?;
    let task = ControlTaskRecordDto::try_from(&record).map_err(|error| error.reason)?;
    if task.project_id != project_id {
        return Err("active task belongs to another project".to_owned());
    }
    Ok(task)
}

#[derive(Debug, Default, Deserialize)]
struct TaskListInput {
    #[serde(default)]
    task_ids: Vec<String>,
    #[serde(default)]
    include_archived: bool,
}

pub(super) fn inspect_tasks<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    arguments: Value,
) -> Result<TaskToolOutcome, String>
where
    B: LocalStoreBackend,
{
    let input: TaskListInput = serde_json::from_value(arguments)
        .map_err(|error| format!("invalid task inspection arguments: {error}"))?;
    if input.task_ids.len() > 50 {
        return Err("task inspection accepts at most 50 task ids".to_owned());
    }

    let mut tasks = state
        .tasks()
        .list()
        .map_err(|error| format!("task inspection failed: {error:?}"))?
        .iter()
        .map(ControlTaskRecordDto::try_from)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.reason)?;
    tasks.retain(|task| {
        task.project_id == project_id
            && (input.include_archived || task.activity != "archived")
            && (input.task_ids.is_empty() || input.task_ids.contains(&task.task_id))
    });
    tasks.sort_by(|left, right| left.title.cmp(&right.title));
    let text = serde_json::to_string(&tasks)
        .map_err(|error| format!("failed to encode task inspection: {error}"))?;
    Ok(TaskToolOutcome::text(text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{seed_local_project, seed_local_task, LocalProjectSeed, LocalTaskSeed};
    use nucleus_local_store::SqliteBackend;
    use serde_json::json;

    #[test]
    fn inspection_returns_project_tasks_with_edit_revisions() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("state.sqlite")));
        seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("project");
        seed_local_task(&state, LocalTaskSeed::nucleus_local_bootstrap()).expect("task");

        let outcome = inspect_tasks(&state, "project:nucleus-local", json!({})).expect("inspect");
        let tasks: Vec<ControlTaskRecordDto> =
            serde_json::from_str(&outcome.text).expect("task output");

        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].task_id, "task:nucleus-local:bootstrap");
        assert!(!tasks[0].revision_id.is_empty());
        assert!(outcome.receipt.is_none());
    }

    #[test]
    fn active_task_is_resolved_from_current_project_state() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("state.sqlite")));
        seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("project");
        seed_local_task(&state, LocalTaskSeed::nucleus_local_bootstrap()).expect("task");

        let task = active_task(
            &state,
            "project:nucleus-local",
            "task:nucleus-local:bootstrap",
        )
        .expect("active task");

        assert_eq!(task.title, "Review Nucleus task workflow");
        assert!(active_task(&state, "project:other", "task:nucleus-local:bootstrap").is_err());
    }
}
