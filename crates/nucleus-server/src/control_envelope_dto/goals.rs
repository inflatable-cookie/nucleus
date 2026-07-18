use serde::{Deserialize, Serialize};

use nucleus_core::{PersistenceDomain, PersistenceRecordKind};
use nucleus_local_store::LocalStoreRecord;
use nucleus_planning::{decode_goal_storage_record, GoalStorageStatus};

use super::ControlApiCodecError;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlGoalRecordDto {
    pub goal_id: String,
    pub project_id: String,
    pub title: String,
    pub desired_outcome: String,
    pub scope: String,
    pub status: String,
    pub blocked_reason: Option<String>,
    pub owner_refs: Vec<String>,
    pub ordered_task_refs: Vec<String>,
    pub planning_artifact_refs: Vec<String>,
    pub provenance_refs: Vec<String>,
    pub stop_conditions: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub current_next_task_ref: Option<String>,
    pub next_action: Option<String>,
    pub revision_id: String,
    #[ts(as = "Option<u32>")]
    pub created_at_epoch_seconds: Option<u64>,
    #[ts(as = "Option<u32>")]
    pub updated_at_epoch_seconds: Option<u64>,
    #[ts(as = "Option<u32>")]
    pub achieved_at_epoch_seconds: Option<u64>,
}

impl TryFrom<&LocalStoreRecord> for ControlGoalRecordDto {
    type Error = ControlApiCodecError;

    fn try_from(record: &LocalStoreRecord) -> Result<Self, Self::Error> {
        if record.domain != PersistenceDomain::Planning
            || record.kind != PersistenceRecordKind::Goal
        {
            return Err(ControlApiCodecError::unsupported(
                "goal display DTO requires planning goal records",
            ));
        }
        let decoded = decode_goal_storage_record(&record.payload.bytes).map_err(|error| {
            ControlApiCodecError::malformed(format!(
                "goal storage payload could not be decoded: {}",
                error.reason
            ))
        })?;
        let (status, blocked_reason) = goal_status(&decoded.status);
        Ok(Self {
            goal_id: decoded.goal_id,
            project_id: decoded.project_id,
            title: decoded.title,
            desired_outcome: decoded.desired_outcome,
            scope: decoded.scope,
            status: status.to_owned(),
            blocked_reason,
            owner_refs: decoded.owner_refs,
            ordered_task_refs: decoded.ordered_task_refs,
            planning_artifact_refs: decoded.planning_artifact_refs,
            provenance_refs: decoded.provenance_refs,
            stop_conditions: decoded.stop_conditions,
            evidence_refs: decoded.evidence_refs,
            current_next_task_ref: decoded.current_next_task_ref,
            next_action: decoded.next_action,
            revision_id: record.revision_id.0.clone(),
            created_at_epoch_seconds: decoded.created_at_epoch_seconds,
            updated_at_epoch_seconds: decoded.updated_at_epoch_seconds,
            achieved_at_epoch_seconds: decoded.achieved_at_epoch_seconds,
        })
    }
}

fn goal_status(status: &GoalStorageStatus) -> (&'static str, Option<String>) {
    match status {
        GoalStorageStatus::Proposed => ("proposed", None),
        GoalStorageStatus::Ready => ("ready", None),
        GoalStorageStatus::Active => ("active", None),
        GoalStorageStatus::Blocked(reason) => ("blocked", Some(reason.clone())),
        GoalStorageStatus::Achieved => ("achieved", None),
        GoalStorageStatus::Abandoned => ("abandoned", None),
    }
}
