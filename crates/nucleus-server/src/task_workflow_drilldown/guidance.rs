use super::types::{
    TaskWorkflowGap, TaskWorkflowGapArea, TaskWorkflowGuidance, TaskWorkflowGuidanceSource,
    TaskWorkflowReadinessSummary, TaskWorkflowSafeAction, TaskWorkflowTaskSummary,
    TaskWorkflowWorkProgressItem,
};

#[allow(clippy::too_many_arguments)]
pub(super) fn task_workflow_guidance(
    task: Option<&TaskWorkflowTaskSummary>,
    readiness: Option<&TaskWorkflowReadinessSummary>,
    work_items: &[TaskWorkflowWorkProgressItem],
    runtime_receipt_refs: &[String],
    command_evidence_refs: &[String],
    task_completion_refs: &[String],
    review_refs: &[String],
    scm_handoff_refs: &[String],
    gaps: &[TaskWorkflowGap],
) -> TaskWorkflowGuidance {
    let missing_evidence_areas = gaps.iter().map(|gap| gap.area).collect::<Vec<_>>();

    let Some(task) = task else {
        return guidance_record(
            TaskWorkflowGuidanceSource::Blocked,
            TaskWorkflowSafeAction::Blocked,
            "Selected task identity is missing or does not belong to the project.",
            Vec::new(),
            missing_evidence_areas,
            Some("task identity repair is required before guidance is available".to_owned()),
        );
    };

    if task.activity == "done" || task.activity == "archived" {
        return guidance_record(
            TaskWorkflowGuidanceSource::NoOp,
            TaskWorkflowSafeAction::Wait,
            "Selected task is already closed.",
            Vec::new(),
            missing_evidence_areas,
            None,
        );
    }

    if let Some(readiness) = readiness {
        match readiness.lane.as_str() {
            "human_planning_ready" => {
                return guidance_record(
                    TaskWorkflowGuidanceSource::Readiness,
                    TaskWorkflowSafeAction::Plan,
                    "Selected task is ready for human planning.",
                    readiness.rationale_refs.clone(),
                    missing_evidence_areas,
                    None,
                );
            }
            "agent_delegation_ready" if work_items.is_empty() => {
                return guidance_record(
                    TaskWorkflowGuidanceSource::Readiness,
                    TaskWorkflowSafeAction::Plan,
                    "Selected task appears ready for delegation planning; no agent work is scheduled.",
                    readiness.rationale_refs.clone(),
                    missing_evidence_areas,
                    None,
                );
            }
            "blocked" | "repair_required" => {
                return guidance_record(
                    TaskWorkflowGuidanceSource::Blocked,
                    TaskWorkflowSafeAction::Blocked,
                    "Selected task readiness is blocked or requires repair.",
                    readiness.rationale_refs.clone(),
                    missing_evidence_areas,
                    Some(
                        "readiness repair is required before work-loop guidance can continue"
                            .to_owned(),
                    ),
                );
            }
            _ => {}
        }
    }

    if let Some(item) = work_items.iter().find(|item| {
        !matches!(
            item.runtime_status.as_str(),
            "completed" | "failed" | "cancelled"
        )
    }) {
        return guidance_record(
            TaskWorkflowGuidanceSource::Runtime,
            TaskWorkflowSafeAction::Inspect,
            "Selected task has active or waiting work evidence to inspect.",
            vec![item.work_item_ref.clone()],
            missing_evidence_areas,
            None,
        );
    }

    if !task_completion_refs.is_empty() && review_refs.is_empty() {
        return guidance_record(
            TaskWorkflowGuidanceSource::Review,
            TaskWorkflowSafeAction::Review,
            "Selected task has completion evidence but no review evidence.",
            clean_refs(task_completion_refs.to_vec()),
            missing_evidence_areas,
            None,
        );
    }

    if !runtime_receipt_refs.is_empty() || !command_evidence_refs.is_empty() {
        return guidance_record(
            TaskWorkflowGuidanceSource::Runtime,
            TaskWorkflowSafeAction::Inspect,
            "Selected task has runtime evidence to inspect.",
            clean_refs(
                runtime_receipt_refs
                    .iter()
                    .cloned()
                    .chain(command_evidence_refs.iter().cloned())
                    .collect(),
            ),
            missing_evidence_areas,
            None,
        );
    }

    if !review_refs.is_empty() && scm_handoff_refs.is_empty() {
        return guidance_record(
            TaskWorkflowGuidanceSource::ScmHandoff,
            TaskWorkflowSafeAction::PrepareHandoff,
            "Selected task has review evidence but no SCM handoff evidence.",
            clean_refs(review_refs.to_vec()),
            missing_evidence_areas,
            None,
        );
    }

    if !scm_handoff_refs.is_empty() {
        return guidance_record(
            TaskWorkflowGuidanceSource::ScmHandoff,
            TaskWorkflowSafeAction::Inspect,
            "Selected task has SCM handoff evidence to inspect.",
            clean_refs(scm_handoff_refs.to_vec()),
            missing_evidence_areas,
            None,
        );
    }

    guidance_record(
        TaskWorkflowGuidanceSource::Blocked,
        TaskWorkflowSafeAction::Blocked,
        "Selected task has no safe next action from available evidence.",
        Vec::new(),
        missing_evidence_areas,
        Some("no selected-task pathway source is available".to_owned()),
    )
}

fn guidance_record(
    source: TaskWorkflowGuidanceSource,
    safe_action: TaskWorkflowSafeAction,
    reason: &str,
    evidence_refs: Vec<String>,
    missing_evidence_areas: Vec<TaskWorkflowGapArea>,
    blocked_reason: Option<String>,
) -> TaskWorkflowGuidance {
    TaskWorkflowGuidance {
        source,
        safe_action,
        reason: reason.to_owned(),
        evidence_refs: clean_refs(evidence_refs),
        missing_evidence_areas,
        blocked_reason,
    }
}

fn clean_refs(refs: Vec<String>) -> Vec<String> {
    let mut refs = refs
        .into_iter()
        .map(|reference| reference.trim().to_owned())
        .filter(|reference| !reference.is_empty())
        .collect::<Vec<_>>();
    refs.sort();
    refs.dedup();
    refs
}
