use nucleus_core::{PersistenceRecordId, PersistenceRecordKind};
use nucleus_local_store::LocalStoreBackend;
use serde::Deserialize;
use serde_json::Value;

use super::task_authoring::TaskToolOutcome;
use crate::{ControlGoalRecordDto, ServerStateService};

#[derive(Debug, Default, Deserialize)]
struct GoalListInput {
    #[serde(default)]
    goal_ids: Vec<String>,
    #[serde(default)]
    include_closed: bool,
}

pub(super) fn goal_record<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    goal_id: &str,
) -> Result<ControlGoalRecordDto, String>
where
    B: LocalStoreBackend,
{
    let record = state
        .planning()
        .get(&PersistenceRecordId(goal_id.to_owned()))
        .map_err(|error| format!("goal lookup failed: {error:?}"))?
        .ok_or_else(|| format!("goal not found: {goal_id}"))?;
    let goal = ControlGoalRecordDto::try_from(&record).map_err(|error| error.reason)?;
    if goal.project_id != project_id {
        return Err(format!("goal belongs to another project: {goal_id}"));
    }
    Ok(goal)
}

pub(super) fn inspect_goals<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    arguments: Value,
) -> Result<TaskToolOutcome, String>
where
    B: LocalStoreBackend,
{
    let input: GoalListInput = serde_json::from_value(arguments)
        .map_err(|error| format!("invalid goal inspection arguments: {error}"))?;
    if input.goal_ids.len() > 50 {
        return Err("goal inspection accepts at most 50 goal ids".to_owned());
    }
    let mut goals = state
        .planning()
        .list()
        .map_err(|error| format!("goal inspection failed: {error:?}"))?
        .iter()
        .filter(|record| record.kind == PersistenceRecordKind::Goal)
        .map(ControlGoalRecordDto::try_from)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.reason)?;
    goals.retain(|goal| {
        goal.project_id == project_id
            && (input.include_closed || !matches!(goal.status.as_str(), "achieved" | "abandoned"))
            && (input.goal_ids.is_empty() || input.goal_ids.contains(&goal.goal_id))
    });
    goals.sort_by(|left, right| left.title.cmp(&right.title));
    Ok(TaskToolOutcome::text(
        serde_json::to_string(&goals)
            .map_err(|error| format!("failed to encode goal inspection: {error}"))?,
    ))
}
