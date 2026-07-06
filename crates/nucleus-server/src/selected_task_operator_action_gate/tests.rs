use nucleus_core::RevisionId;

use crate::{
    selected_task_action_readiness, selected_task_operator_action_gate, task_workflow_drilldown,
    SelectedTaskActionFamily, SelectedTaskOperatorActionDisposition,
    SelectedTaskOperatorActionGate, SelectedTaskOperatorActionGateInput,
    SelectedTaskOperatorTaskCommandAction, TaskWorkflowDrilldownInput, TaskWorkflowNextStepInput,
    TaskWorkflowNextStepSource, TaskWorkflowReadinessInput, TaskWorkflowTaskInput,
    TaskWorkflowWorkProgressInput,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

#[test]
fn gate_maps_allowed_task_actions_to_read_only_command_candidates() {
    let gate = gate_for("ready", Some("agent_delegation_ready"), Vec::new());

    let start = candidate(&gate, SelectedTaskActionFamily::StartSelectedTask);
    assert_eq!(
        start.disposition,
        SelectedTaskOperatorActionDisposition::TaskCommandCandidate
    );
    assert_eq!(
        start.task_command.as_ref().map(|command| command.action),
        Some(SelectedTaskOperatorTaskCommandAction::Start)
    );
    assert_eq!(
        start
            .task_command
            .as_ref()
            .and_then(|command| command.expected_revision.as_ref()),
        Some(&RevisionId("rev:task:1".to_owned()))
    );

    let block = candidate(&gate, SelectedTaskActionFamily::BlockSelectedTask);
    assert!(block.reason_required);
    assert_eq!(gate.source_counts.task_command_candidates, 2);
    assert!(!gate.no_effects.task_mutation_performed);
    assert!(!gate.no_effects.provider_execution_performed);
    assert!(!gate.no_effects.scm_or_forge_mutation_performed);
    assert!(!gate.no_effects.agent_scheduling_performed);
    assert!(!gate.no_effects.ui_effect_performed);
}

#[test]
fn gate_preserves_blocked_task_actions_without_command_candidates() {
    let gate = gate_for("todo", None, Vec::new());

    let start = candidate(&gate, SelectedTaskActionFamily::StartSelectedTask);
    assert_eq!(
        start.disposition,
        SelectedTaskOperatorActionDisposition::Blocked
    );
    assert!(start.task_command.is_none());
    assert!(gate
        .blockers
        .iter()
        .any(|blocker| blocker.family == SelectedTaskActionFamily::StartSelectedTask));
}

#[test]
fn gate_keeps_non_task_actions_read_only_or_deferred() {
    let gate = gate_for(
        "active",
        Some("agent_delegation_ready"),
        vec![TaskWorkflowWorkProgressInput {
            work_item_ref: "work:1".to_owned(),
            runtime_status: "running".to_owned(),
            review_status: "not_ready".to_owned(),
            source_ref: "source:1".to_owned(),
            source_count: 1,
            session_ref: Some("session:1".to_owned()),
            turn_refs: vec!["turn:1".to_owned()],
            receipt_refs: vec!["receipt:1".to_owned()],
            checkpoint_refs: Vec::new(),
            diff_summary_refs: Vec::new(),
            timeline_entry_refs: vec!["timeline:1".to_owned()],
            validation_refs: Vec::new(),
            artifact_refs: Vec::new(),
            issue_refs: Vec::new(),
        }],
    );

    assert_passive(
        &gate,
        SelectedTaskActionFamily::PlanSelectedTask,
        SelectedTaskOperatorActionDisposition::ReadOnly,
    );
    assert_passive(
        &gate,
        SelectedTaskActionFamily::InspectRuntimeEvidence,
        SelectedTaskOperatorActionDisposition::ReadOnly,
    );
    assert_passive(
        &gate,
        SelectedTaskActionFamily::PrepareDelegation,
        SelectedTaskOperatorActionDisposition::Deferred,
    );
    assert_passive(
        &gate,
        SelectedTaskActionFamily::ReviewWorkEvidence,
        SelectedTaskOperatorActionDisposition::Deferred,
    );
    assert_passive(
        &gate,
        SelectedTaskActionFamily::PrepareScmHandoff,
        SelectedTaskOperatorActionDisposition::Deferred,
    );
}

fn gate_for(
    activity: &str,
    readiness_lane: Option<&str>,
    work_progress: Vec<TaskWorkflowWorkProgressInput>,
) -> SelectedTaskOperatorActionGate {
    let drilldown = task_workflow_drilldown(TaskWorkflowDrilldownInput {
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        task: Some(TaskWorkflowTaskInput {
            title: "Selected task".to_owned(),
            activity: activity.to_owned(),
            assignment: "unassigned".to_owned(),
            action_type: "execute".to_owned(),
        }),
        readiness: readiness_lane.map(|lane| TaskWorkflowReadinessInput {
            lane: lane.to_owned(),
            rationale_refs: vec!["readiness:1".to_owned()],
        }),
        timeline_entry_refs: vec!["timeline:1".to_owned()],
        work_progress,
        runtime_receipt_refs: Vec::new(),
        command_evidence_refs: Vec::new(),
        task_completion_refs: Vec::new(),
        review_refs: Vec::new(),
        scm_handoff_refs: Vec::new(),
        next_step: Some(TaskWorkflowNextStepInput {
            source: TaskWorkflowNextStepSource::Task,
            next_ref: Some("task:1".to_owned()),
            summary: "Continue selected task".to_owned(),
            rationale_refs: vec!["readiness:1".to_owned()],
        }),
    });
    let readiness = selected_task_action_readiness(&drilldown);

    selected_task_operator_action_gate(SelectedTaskOperatorActionGateInput {
        readiness,
        expected_revision: Some(RevisionId("rev:task:1".to_owned())),
        actor_ref: Some("operator:local".to_owned()),
    })
}

fn candidate(
    gate: &SelectedTaskOperatorActionGate,
    family: SelectedTaskActionFamily,
) -> &crate::SelectedTaskOperatorActionCandidate {
    gate.candidates
        .iter()
        .find(|candidate| candidate.family == family)
        .expect("candidate")
}

fn assert_passive(
    gate: &SelectedTaskOperatorActionGate,
    family: SelectedTaskActionFamily,
    disposition: SelectedTaskOperatorActionDisposition,
) {
    let candidate = candidate(gate, family);
    assert_eq!(candidate.disposition, disposition);
    assert!(candidate.task_command.is_none());
    assert!(!candidate.expected_revision_required);
}
