//! Serializable durable Goal records.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;
use serde::{Deserialize, Serialize};

use crate::{Goal, GoalStatus, GoalTimestamps, PlanningGoalId};

use super::{codec_error, PlanningRecordCodecError, PLANNING_STORAGE_SCHEMA_VERSION};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GoalStorageRecord {
    pub schema_version: u16,
    pub goal_id: String,
    pub project_id: String,
    pub title: String,
    pub desired_outcome: String,
    pub scope: String,
    pub status: GoalStorageStatus,
    #[serde(default)]
    pub owner_refs: Vec<String>,
    #[serde(default)]
    pub ordered_task_refs: Vec<String>,
    #[serde(default)]
    pub planning_artifact_refs: Vec<String>,
    #[serde(default)]
    pub provenance_refs: Vec<String>,
    #[serde(default)]
    pub stop_conditions: Vec<String>,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    pub current_next_task_ref: Option<String>,
    pub next_action: Option<String>,
    pub created_at_epoch_seconds: Option<u64>,
    pub updated_at_epoch_seconds: Option<u64>,
    pub achieved_at_epoch_seconds: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", content = "reason", rename_all = "snake_case")]
pub enum GoalStorageStatus {
    Proposed,
    Ready,
    Active,
    Blocked(String),
    Achieved,
    Abandoned,
}

impl TryFrom<&Goal> for GoalStorageRecord {
    type Error = PlanningRecordCodecError;

    fn try_from(goal: &Goal) -> Result<Self, Self::Error> {
        Ok(Self {
            schema_version: PLANNING_STORAGE_SCHEMA_VERSION,
            goal_id: goal.id.0.clone(),
            project_id: goal.project_id.0.clone(),
            title: goal.title.clone(),
            desired_outcome: goal.desired_outcome.clone(),
            scope: goal.scope.clone(),
            status: GoalStorageStatus::from(&goal.status),
            owner_refs: goal.owner_refs.clone(),
            ordered_task_refs: goal
                .ordered_task_refs
                .iter()
                .map(|task| task.0.clone())
                .collect(),
            planning_artifact_refs: goal.planning_artifact_refs.clone(),
            provenance_refs: goal.provenance_refs.clone(),
            stop_conditions: goal.stop_conditions.clone(),
            evidence_refs: goal.evidence_refs.clone(),
            current_next_task_ref: goal
                .current_next_task_ref
                .as_ref()
                .map(|task| task.0.clone()),
            next_action: goal.next_action.clone(),
            created_at_epoch_seconds: encode_time(goal.timestamps.created_at)?,
            updated_at_epoch_seconds: encode_time(goal.timestamps.updated_at)?,
            achieved_at_epoch_seconds: encode_time(goal.timestamps.achieved_at)?,
        })
    }
}

impl From<&GoalStatus> for GoalStorageStatus {
    fn from(status: &GoalStatus) -> Self {
        match status {
            GoalStatus::Proposed => Self::Proposed,
            GoalStatus::Ready => Self::Ready,
            GoalStatus::Active => Self::Active,
            GoalStatus::Blocked { reason } => Self::Blocked(reason.clone()),
            GoalStatus::Achieved => Self::Achieved,
            GoalStatus::Abandoned => Self::Abandoned,
        }
    }
}

impl From<GoalStorageStatus> for GoalStatus {
    fn from(status: GoalStorageStatus) -> Self {
        match status {
            GoalStorageStatus::Proposed => Self::Proposed,
            GoalStorageStatus::Ready => Self::Ready,
            GoalStorageStatus::Active => Self::Active,
            GoalStorageStatus::Blocked(reason) => Self::Blocked { reason },
            GoalStorageStatus::Achieved => Self::Achieved,
            GoalStorageStatus::Abandoned => Self::Abandoned,
        }
    }
}

pub fn encode_goal_storage_record(goal: &Goal) -> Result<Vec<u8>, PlanningRecordCodecError> {
    encode_goal_storage_payload(&GoalStorageRecord::try_from(goal)?)
}

pub fn encode_goal_storage_payload(
    record: &GoalStorageRecord,
) -> Result<Vec<u8>, PlanningRecordCodecError> {
    serde_json::to_vec(record).map_err(codec_error)
}

pub fn decode_goal_storage_record(
    bytes: &[u8],
) -> Result<GoalStorageRecord, PlanningRecordCodecError> {
    serde_json::from_slice(bytes).map_err(codec_error)
}

pub fn goal_from_storage_record(
    record: GoalStorageRecord,
) -> Result<Goal, PlanningRecordCodecError> {
    if record.schema_version != PLANNING_STORAGE_SCHEMA_VERSION {
        return Err(PlanningRecordCodecError {
            reason: format!(
                "unsupported goal storage schema version: {}",
                record.schema_version
            ),
        });
    }
    Ok(Goal {
        id: PlanningGoalId(record.goal_id),
        project_id: ProjectId(record.project_id),
        title: record.title,
        desired_outcome: record.desired_outcome,
        scope: record.scope,
        status: GoalStatus::from(record.status),
        owner_refs: record.owner_refs,
        ordered_task_refs: record.ordered_task_refs.into_iter().map(TaskId).collect(),
        planning_artifact_refs: record.planning_artifact_refs,
        provenance_refs: record.provenance_refs,
        stop_conditions: record.stop_conditions,
        evidence_refs: record.evidence_refs,
        current_next_task_ref: record.current_next_task_ref.map(TaskId),
        next_action: record.next_action,
        timestamps: GoalTimestamps {
            created_at: decode_time(record.created_at_epoch_seconds)?,
            updated_at: decode_time(record.updated_at_epoch_seconds)?,
            achieved_at: decode_time(record.achieved_at_epoch_seconds)?,
        },
    })
}

fn encode_time(value: Option<SystemTime>) -> Result<Option<u64>, PlanningRecordCodecError> {
    value
        .map(|value| {
            value
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .map_err(|_| PlanningRecordCodecError {
                    reason: "goal timestamp predates the Unix epoch".to_owned(),
                })
        })
        .transpose()
}

fn decode_time(value: Option<u64>) -> Result<Option<SystemTime>, PlanningRecordCodecError> {
    value
        .map(|seconds| {
            UNIX_EPOCH
                .checked_add(Duration::from_secs(seconds))
                .ok_or_else(|| PlanningRecordCodecError {
                    reason: "goal timestamp is outside the supported range".to_owned(),
                })
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn goal_storage_round_trip_preserves_order_status_and_timestamps() {
        let timestamp = UNIX_EPOCH + Duration::from_secs(1_725_000_000);
        let goal = Goal {
            id: PlanningGoalId("goal:nucleus:ship".to_owned()),
            project_id: ProjectId("project:nucleus".to_owned()),
            title: "Ship Nucleus".to_owned(),
            desired_outcome: "A usable goal-backed agent workflow.".to_owned(),
            scope: "Goals, tasks, and serial execution.".to_owned(),
            status: GoalStatus::Blocked {
                reason: "Waiting for operator input".to_owned(),
            },
            owner_refs: vec!["operator:tom".to_owned()],
            ordered_task_refs: vec![TaskId("task:one".to_owned()), TaskId("task:two".to_owned())],
            planning_artifact_refs: vec!["artifact:workflow".to_owned()],
            provenance_refs: vec!["conversation:one".to_owned()],
            stop_conditions: vec!["Stop on failed validation".to_owned()],
            evidence_refs: vec!["evidence:design".to_owned()],
            current_next_task_ref: Some(TaskId("task:one".to_owned())),
            next_action: Some("Run task one".to_owned()),
            timestamps: GoalTimestamps {
                created_at: Some(timestamp),
                updated_at: Some(timestamp),
                achieved_at: None,
            },
        };

        let bytes = encode_goal_storage_record(&goal).expect("encode goal");
        let storage = decode_goal_storage_record(&bytes).expect("decode storage");
        let decoded = goal_from_storage_record(storage).expect("decode goal");

        assert_eq!(decoded, goal);
        assert_eq!(decoded.ordered_task_refs[0].0, "task:one");
    }

    #[test]
    fn goal_storage_rejects_unknown_schema_versions() {
        let record = GoalStorageRecord {
            schema_version: PLANNING_STORAGE_SCHEMA_VERSION + 1,
            goal_id: "goal:nucleus:future".to_owned(),
            project_id: "project:nucleus".to_owned(),
            title: "Future goal".to_owned(),
            desired_outcome: "Unsupported format is rejected.".to_owned(),
            scope: "Codec validation".to_owned(),
            status: GoalStorageStatus::Proposed,
            owner_refs: vec![],
            ordered_task_refs: vec![],
            planning_artifact_refs: vec![],
            provenance_refs: vec![],
            stop_conditions: vec![],
            evidence_refs: vec![],
            current_next_task_ref: None,
            next_action: None,
            created_at_epoch_seconds: None,
            updated_at_epoch_seconds: None,
            achieved_at_epoch_seconds: None,
        };

        assert!(goal_from_storage_record(record)
            .expect_err("future schema")
            .reason
            .contains("unsupported"));
    }
}
