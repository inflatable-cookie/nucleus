use serde::{Deserialize, Serialize};

use nucleus_engine::{
    EngineTaskReadinessCandidate, EngineTaskReadinessClass, EngineTaskReadinessSourceCounts,
    EngineTaskReadinessStatusCount,
};
use nucleus_tasks::{TaskActionType, TaskActivityState};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskReadinessCandidateDto {
    pub task_id: String,
    pub project_id: String,
    pub title: String,
    pub action_type: String,
    pub activity: String,
    pub readiness: String,
    pub reasons: Vec<String>,
    pub blocker_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub agent_ready: bool,
    pub validation_commands: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskReadinessStatusCountDto {
    pub readiness: String,
    #[ts(as = "u32")]
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskReadinessSourceCountsDto {
    #[ts(as = "u32")]
    pub task_records: usize,
    #[ts(as = "u32")]
    pub work_item_evidence_refs: usize,
    #[ts(as = "u32")]
    pub timeline_evidence_refs: usize,
    #[ts(as = "u32")]
    pub validation_command_refs: usize,
}

impl From<&EngineTaskReadinessCandidate> for ControlTaskReadinessCandidateDto {
    fn from(candidate: &EngineTaskReadinessCandidate) -> Self {
        Self {
            task_id: candidate.task_id.0.clone(),
            project_id: candidate.project_id.0.clone(),
            title: candidate.title.clone(),
            action_type: action_type_dto(&candidate.action_type),
            activity: activity_dto(&candidate.activity),
            readiness: readiness_dto(&candidate.readiness),
            reasons: candidate.reasons.clone(),
            blocker_refs: candidate.blocker_refs.clone(),
            evidence_refs: candidate.evidence_refs.clone(),
            agent_ready: candidate.agent_ready,
            validation_commands: candidate.validation_commands.clone(),
        }
    }
}

impl From<&EngineTaskReadinessStatusCount> for ControlTaskReadinessStatusCountDto {
    fn from(count: &EngineTaskReadinessStatusCount) -> Self {
        Self {
            readiness: readiness_dto(&count.readiness),
            count: count.count,
        }
    }
}

impl From<&EngineTaskReadinessSourceCounts> for ControlTaskReadinessSourceCountsDto {
    fn from(counts: &EngineTaskReadinessSourceCounts) -> Self {
        Self {
            task_records: counts.task_records,
            work_item_evidence_refs: counts.work_item_evidence_refs,
            timeline_evidence_refs: counts.timeline_evidence_refs,
            validation_command_refs: counts.validation_command_refs,
        }
    }
}

fn readiness_dto(readiness: &EngineTaskReadinessClass) -> String {
    match readiness {
        EngineTaskReadinessClass::AgentDelegationReady => "agent_delegation_ready",
        EngineTaskReadinessClass::HumanPlanningReady => "human_planning_ready",
        EngineTaskReadinessClass::ActiveWorkPresent => "active_work_present",
        EngineTaskReadinessClass::AwaitingReview => "awaiting_review",
        EngineTaskReadinessClass::Blocked => "blocked",
        EngineTaskReadinessClass::RepairRequired => "repair_required",
        EngineTaskReadinessClass::Completed => "completed",
        EngineTaskReadinessClass::Archived => "archived",
    }
    .to_owned()
}

fn action_type_dto(action_type: &TaskActionType) -> String {
    match action_type {
        TaskActionType::Research => "research",
        TaskActionType::Plan => "plan",
        TaskActionType::Execute => "execute",
        TaskActionType::Test => "test",
        TaskActionType::Check => "check",
        TaskActionType::Review => "review",
    }
    .to_owned()
}

fn activity_dto(activity: &TaskActivityState) -> String {
    match activity {
        TaskActivityState::Proposed => "proposed",
        TaskActivityState::Ready => "ready",
        TaskActivityState::Active => "active",
        TaskActivityState::Blocked(_) => "blocked",
        TaskActivityState::Done => "done",
        TaskActivityState::Archived => "archived",
    }
    .to_owned()
}
