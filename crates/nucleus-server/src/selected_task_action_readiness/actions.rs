use super::support::{clean_refs, Facts};
use crate::{
    SelectedTaskAction, SelectedTaskActionFamily, SelectedTaskActionStatus, TaskWorkflowDrilldown,
};

pub(super) fn action(
    family: SelectedTaskActionFamily,
    drilldown: &TaskWorkflowDrilldown,
    facts: &Facts,
) -> SelectedTaskAction {
    match family {
        SelectedTaskActionFamily::PlanSelectedTask => plan_action(drilldown, facts),
        SelectedTaskActionFamily::StartSelectedTask => start_action(drilldown, facts),
        SelectedTaskActionFamily::BlockSelectedTask => block_action(drilldown, facts),
        SelectedTaskActionFamily::CompleteSelectedTask => complete_action(drilldown, facts),
        SelectedTaskActionFamily::ArchiveSelectedTask => archive_action(drilldown, facts),
        SelectedTaskActionFamily::PrepareDelegation => delegation_action(drilldown, facts),
        SelectedTaskActionFamily::InspectRuntimeEvidence => {
            inspect_runtime_action(drilldown, facts)
        }
        SelectedTaskActionFamily::ReviewWorkEvidence => review_action(drilldown, facts),
        SelectedTaskActionFamily::PrepareScmHandoff => scm_handoff_action(drilldown, facts),
    }
}

fn plan_action(drilldown: &TaskWorkflowDrilldown, facts: &Facts) -> SelectedTaskAction {
    let family = SelectedTaskActionFamily::PlanSelectedTask;
    if let Some(action) = missing_or_closed_action(family, drilldown, facts) {
        return action;
    }
    if facts.has_active_work {
        return lane_action(
            family,
            "Plan selected task",
            "active task work exists; inspect runtime evidence before replanning",
            facts.active_work_refs(),
        );
    }

    allowed_action(
        family,
        "Plan selected task",
        "selected task can be planned from the current read-only evidence",
        facts.readiness_refs(drilldown),
    )
}

fn start_action(drilldown: &TaskWorkflowDrilldown, facts: &Facts) -> SelectedTaskAction {
    let family = SelectedTaskActionFamily::StartSelectedTask;
    if let Some(action) = missing_or_closed_action(family, drilldown, facts) {
        return action;
    }
    if facts.has_active_work {
        return lane_action(
            family,
            "Start selected task",
            "active task work already exists; inspect runtime evidence instead",
            facts.active_work_refs(),
        );
    }
    if facts.readiness_lane.as_deref() == Some("agent_delegation_ready")
        || facts.activity.as_deref() == Some("ready")
    {
        return allowed_action(
            family,
            "Start selected task",
            "selected task has enough readiness to show a start affordance",
            facts.readiness_refs(drilldown),
        );
    }

    blocked_action(
        family,
        "Start selected task",
        "selected task is not ready to start from available evidence",
        facts.gap_refs(drilldown),
    )
}

fn block_action(drilldown: &TaskWorkflowDrilldown, facts: &Facts) -> SelectedTaskAction {
    let family = SelectedTaskActionFamily::BlockSelectedTask;
    if drilldown.task.is_none() {
        return missing_task_action(family);
    }
    if facts.activity.as_deref() == Some("blocked") {
        return not_applicable_action(
            family,
            "Block selected task",
            "selected task is already blocked",
            Vec::new(),
        );
    }
    if facts.is_closed {
        return not_applicable_action(
            family,
            "Block selected task",
            "closed tasks cannot be blocked",
            Vec::new(),
        );
    }

    allowed_action(
        family,
        "Block selected task",
        "selected task can expose a block affordance",
        facts.gap_refs(drilldown),
    )
}

fn complete_action(drilldown: &TaskWorkflowDrilldown, facts: &Facts) -> SelectedTaskAction {
    let family = SelectedTaskActionFamily::CompleteSelectedTask;
    if let Some(action) = missing_or_closed_action(family, drilldown, facts) {
        return action;
    }
    if facts.has_active_work {
        return lane_action(
            family,
            "Complete selected task",
            "active task work exists; inspect runtime evidence before completion",
            facts.active_work_refs(),
        );
    }
    if facts.has_review_evidence || facts.has_completion_evidence {
        return allowed_action(
            family,
            "Complete selected task",
            "completion or review evidence exists for the selected task",
            facts.completion_and_review_refs(drilldown),
        );
    }

    blocked_action(
        family,
        "Complete selected task",
        "no completion or review evidence exists for the selected task",
        facts.gap_refs(drilldown),
    )
}

fn archive_action(drilldown: &TaskWorkflowDrilldown, facts: &Facts) -> SelectedTaskAction {
    let family = SelectedTaskActionFamily::ArchiveSelectedTask;
    if drilldown.task.is_none() {
        return missing_task_action(family);
    }
    if facts.activity.as_deref() == Some("archived") {
        return not_applicable_action(
            family,
            "Archive selected task",
            "selected task is already archived",
            Vec::new(),
        );
    }
    if facts.has_active_work {
        return lane_action(
            family,
            "Archive selected task",
            "active task work exists; inspect runtime evidence before archiving",
            facts.active_work_refs(),
        );
    }
    if facts.activity.as_deref() == Some("done") {
        return allowed_action(
            family,
            "Archive selected task",
            "selected task is done and can expose an archive affordance",
            facts.completion_and_review_refs(drilldown),
        );
    }

    blocked_action(
        family,
        "Archive selected task",
        "selected task is not done",
        facts.gap_refs(drilldown),
    )
}

fn delegation_action(drilldown: &TaskWorkflowDrilldown, facts: &Facts) -> SelectedTaskAction {
    let family = SelectedTaskActionFamily::PrepareDelegation;
    if let Some(action) = missing_or_closed_action(family, drilldown, facts) {
        return action;
    }
    if facts.has_active_work {
        return lane_action(
            family,
            "Prepare delegation",
            "active task work already exists; delegation preparation belongs to runtime inspection",
            facts.active_work_refs(),
        );
    }
    if facts.readiness_lane.as_deref() == Some("agent_delegation_ready") {
        return allowed_action(
            family,
            "Prepare delegation",
            "selected task has agent delegation readiness evidence",
            facts.readiness_refs(drilldown),
        );
    }

    blocked_action(
        family,
        "Prepare delegation",
        "selected task is not agent-delegation ready",
        facts.readiness_refs(drilldown),
    )
}

fn inspect_runtime_action(drilldown: &TaskWorkflowDrilldown, facts: &Facts) -> SelectedTaskAction {
    let family = SelectedTaskActionFamily::InspectRuntimeEvidence;
    if drilldown.task.is_none() {
        return missing_task_action(family);
    }
    if facts.has_runtime_evidence || facts.has_active_work {
        return allowed_action(
            family,
            "Inspect runtime evidence",
            "selected task has task-scoped runtime or work evidence",
            facts.runtime_evidence_refs.clone(),
        );
    }

    not_applicable_action(
        family,
        "Inspect runtime evidence",
        "selected task has no runtime evidence to inspect",
        Vec::new(),
    )
}

fn review_action(drilldown: &TaskWorkflowDrilldown, facts: &Facts) -> SelectedTaskAction {
    let family = SelectedTaskActionFamily::ReviewWorkEvidence;
    if let Some(action) = missing_or_closed_action(family, drilldown, facts) {
        return action;
    }
    if facts.has_active_work {
        return lane_action(
            family,
            "Review work evidence",
            "active task work exists; inspect runtime evidence before review",
            facts.active_work_refs(),
        );
    }
    if facts.has_completion_evidence || facts.completed_work_items > 0 {
        return allowed_action(
            family,
            "Review work evidence",
            "completion evidence exists for the selected task",
            facts.completion_and_review_refs(drilldown),
        );
    }
    if facts.has_review_evidence {
        return allowed_action(
            family,
            "Review work evidence",
            "review evidence already exists for the selected task",
            drilldown.review.review_refs.clone(),
        );
    }

    blocked_action(
        family,
        "Review work evidence",
        "no completed work or review evidence exists for the selected task",
        facts.gap_refs(drilldown),
    )
}

fn scm_handoff_action(drilldown: &TaskWorkflowDrilldown, facts: &Facts) -> SelectedTaskAction {
    let family = SelectedTaskActionFamily::PrepareScmHandoff;
    if let Some(action) = missing_or_closed_action(family, drilldown, facts) {
        return action;
    }
    if facts.has_active_work {
        return lane_action(
            family,
            "Prepare SCM handoff",
            "active task work exists; inspect runtime evidence before SCM handoff",
            facts.active_work_refs(),
        );
    }
    if facts.has_review_evidence {
        return allowed_action(
            family,
            "Prepare SCM handoff",
            "review evidence exists for the selected task",
            drilldown.review.review_refs.clone(),
        );
    }
    if facts.has_completion_evidence {
        return lane_action(
            family,
            "Prepare SCM handoff",
            "completion evidence exists but review evidence is still missing",
            drilldown.runtime.task_completion_refs.clone(),
        );
    }

    blocked_action(
        family,
        "Prepare SCM handoff",
        "review evidence is required before SCM handoff",
        facts.gap_refs(drilldown),
    )
}

fn missing_or_closed_action(
    family: SelectedTaskActionFamily,
    drilldown: &TaskWorkflowDrilldown,
    facts: &Facts,
) -> Option<SelectedTaskAction> {
    if drilldown.task.is_none() {
        return Some(missing_task_action(family));
    }
    facts.is_closed.then(|| {
        not_applicable_action(
            family,
            label(family),
            "selected task is already closed",
            facts.completion_and_review_refs(drilldown),
        )
    })
}

fn missing_task_action(family: SelectedTaskActionFamily) -> SelectedTaskAction {
    blocked_action(
        family,
        label(family),
        "selected task identity is missing or not scoped to the project",
        Vec::new(),
    )
}

fn allowed_action(
    family: SelectedTaskActionFamily,
    label: &str,
    reason: &str,
    evidence_refs: Vec<String>,
) -> SelectedTaskAction {
    action_record(
        family,
        SelectedTaskActionStatus::Allowed,
        label,
        reason,
        evidence_refs,
    )
}

fn blocked_action(
    family: SelectedTaskActionFamily,
    label: &str,
    reason: &str,
    evidence_refs: Vec<String>,
) -> SelectedTaskAction {
    action_record(
        family,
        SelectedTaskActionStatus::Blocked,
        label,
        reason,
        evidence_refs,
    )
}

fn not_applicable_action(
    family: SelectedTaskActionFamily,
    label: &str,
    reason: &str,
    evidence_refs: Vec<String>,
) -> SelectedTaskAction {
    action_record(
        family,
        SelectedTaskActionStatus::NotApplicable,
        label,
        reason,
        evidence_refs,
    )
}

fn lane_action(
    family: SelectedTaskActionFamily,
    label: &str,
    reason: &str,
    evidence_refs: Vec<String>,
) -> SelectedTaskAction {
    action_record(
        family,
        SelectedTaskActionStatus::DifferentLane,
        label,
        reason,
        evidence_refs,
    )
}

fn action_record(
    family: SelectedTaskActionFamily,
    status: SelectedTaskActionStatus,
    label: &str,
    reason: &str,
    evidence_refs: Vec<String>,
) -> SelectedTaskAction {
    SelectedTaskAction {
        family,
        status,
        label: label.to_owned(),
        reason: reason.to_owned(),
        blocker_refs: if status == SelectedTaskActionStatus::Blocked {
            clean_refs(evidence_refs.clone())
        } else {
            Vec::new()
        },
        evidence_refs: clean_refs(evidence_refs),
    }
}

fn label(family: SelectedTaskActionFamily) -> &'static str {
    match family {
        SelectedTaskActionFamily::PlanSelectedTask => "Plan selected task",
        SelectedTaskActionFamily::StartSelectedTask => "Start selected task",
        SelectedTaskActionFamily::BlockSelectedTask => "Block selected task",
        SelectedTaskActionFamily::CompleteSelectedTask => "Complete selected task",
        SelectedTaskActionFamily::ArchiveSelectedTask => "Archive selected task",
        SelectedTaskActionFamily::PrepareDelegation => "Prepare delegation",
        SelectedTaskActionFamily::InspectRuntimeEvidence => "Inspect runtime evidence",
        SelectedTaskActionFamily::ReviewWorkEvidence => "Review work evidence",
        SelectedTaskActionFamily::PrepareScmHandoff => "Prepare SCM handoff",
    }
}
