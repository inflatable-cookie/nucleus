use nucleus_engine::EngineTaskReadinessClass;
use nucleus_tasks::{AssignmentState, Task, TaskActionType, TaskActivityState};

use crate::control_api::TaskWorkflowDrilldownQuery;
use crate::{
    TaskWorkflowNextStepInput, TaskWorkflowNextStepSource, TaskWorkflowReadinessInput,
    TaskWorkflowTaskInput,
};

pub(super) fn next_step(
    query: &TaskWorkflowDrilldownQuery,
    readiness: Option<&TaskWorkflowReadinessInput>,
    runtime_receipt_refs: &[String],
    task_completion_refs: &[String],
    review_refs: &[String],
    scm_handoff_refs: &[String],
) -> Option<TaskWorkflowNextStepInput> {
    if matches!(
        readiness.map(|readiness| readiness.lane.as_str()),
        Some("agent_delegation_ready" | "human_planning_ready")
    ) {
        return Some(TaskWorkflowNextStepInput {
            source: TaskWorkflowNextStepSource::Task,
            next_ref: Some(query.task_id.0.clone()),
            summary: "Continue the selected ready task".to_owned(),
            rationale_refs: readiness
                .map(|readiness| readiness.rationale_refs.clone())
                .unwrap_or_default(),
        });
    }
    if let Some(review_ref) = review_refs.first() {
        return Some(TaskWorkflowNextStepInput {
            source: TaskWorkflowNextStepSource::Review,
            next_ref: Some(review_ref.clone()),
            summary: "Review selected task evidence".to_owned(),
            rationale_refs: review_refs.to_vec(),
        });
    }
    if let Some(scm_ref) = scm_handoff_refs.first() {
        return Some(TaskWorkflowNextStepInput {
            source: TaskWorkflowNextStepSource::ScmHandoff,
            next_ref: Some(scm_ref.clone()),
            summary: "Review selected task SCM handoff state".to_owned(),
            rationale_refs: scm_handoff_refs.to_vec(),
        });
    }
    runtime_receipt_refs
        .first()
        .or_else(|| task_completion_refs.first())
        .map(|runtime_ref| TaskWorkflowNextStepInput {
            source: TaskWorkflowNextStepSource::Runtime,
            next_ref: Some(runtime_ref.clone()),
            summary: "Inspect selected task runtime evidence".to_owned(),
            rationale_refs: runtime_receipt_refs
                .iter()
                .cloned()
                .chain(task_completion_refs.iter().cloned())
                .collect(),
        })
}

pub(super) fn task_input(task: &Task) -> TaskWorkflowTaskInput {
    TaskWorkflowTaskInput {
        title: task.title.clone(),
        activity: activity_label(&task.activity).to_owned(),
        assignment: assignment_label(&task.assignment),
        action_type: action_label(&task.action_type).to_owned(),
    }
}

pub(super) fn readiness_label(readiness: &EngineTaskReadinessClass) -> &'static str {
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
}

fn action_label(action: &TaskActionType) -> &'static str {
    match action {
        TaskActionType::Research => "research",
        TaskActionType::Plan => "plan",
        TaskActionType::Execute => "execute",
        TaskActionType::Test => "test",
        TaskActionType::Check => "check",
        TaskActionType::Review => "review",
    }
}

fn activity_label(activity: &TaskActivityState) -> &'static str {
    match activity {
        TaskActivityState::Proposed => "proposed",
        TaskActivityState::Ready => "ready",
        TaskActivityState::Active => "active",
        TaskActivityState::Blocked(_) => "blocked",
        TaskActivityState::Done => "done",
        TaskActivityState::Archived => "archived",
    }
}

fn assignment_label(assignment: &AssignmentState) -> String {
    match assignment {
        AssignmentState::Unassigned => "unassigned".to_owned(),
        AssignmentState::Human(_) => "human".to_owned(),
        AssignmentState::Agent(_) => "agent".to_owned(),
        AssignmentState::Mixed(_) => "mixed".to_owned(),
    }
}
