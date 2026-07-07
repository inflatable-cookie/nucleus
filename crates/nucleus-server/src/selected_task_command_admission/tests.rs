use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::{
    selected_task_action_readiness, selected_task_command_admission,
    selected_task_operator_action_gate, task_workflow_drilldown, SelectedTaskActionFamily,
    SelectedTaskCommandAdmissionInput, SelectedTaskCommandAdmissionRefusalKind,
    SelectedTaskCommandAdmissionStatus, SelectedTaskCommandOperatorIntent,
    SelectedTaskOperatorActionGate, SelectedTaskOperatorActionGateInput, TaskCommand,
    TaskWorkflowDrilldownInput, TaskWorkflowNextStepInput, TaskWorkflowNextStepSource,
    TaskWorkflowReadinessInput, TaskWorkflowTaskInput,
};

#[test]
fn admission_converts_allowed_start_candidate_to_existing_task_command() {
    let gate = ready_gate();
    let admission = selected_task_command_admission(SelectedTaskCommandAdmissionInput {
        gate,
        intent: intent(
            SelectedTaskActionFamily::StartSelectedTask,
            Some("rev:task:1"),
            None,
        ),
    });

    assert_eq!(
        admission.status,
        SelectedTaskCommandAdmissionStatus::Admitted
    );
    assert!(matches!(
        admission.command,
        Some(TaskCommand::Start(command))
            if command.task_id == TaskId("task:1".to_owned())
                && command.expected_revision == Some(RevisionId("rev:task:1".to_owned()))
    ));
    assert!(!admission.no_effects.task_mutation_performed);
    assert!(!admission.no_effects.provider_execution_performed);
    assert!(!admission.no_effects.scm_or_forge_mutation_performed);
}

#[test]
fn admission_requires_reason_for_block_candidate() {
    let gate = ready_gate();
    let admission = selected_task_command_admission(SelectedTaskCommandAdmissionInput {
        gate,
        intent: intent(
            SelectedTaskActionFamily::BlockSelectedTask,
            Some("rev:task:1"),
            None,
        ),
    });

    assert_eq!(
        admission.status,
        SelectedTaskCommandAdmissionStatus::Refused
    );
    assert_eq!(
        admission.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskCommandAdmissionRefusalKind::ReasonRequired)
    );
    assert!(admission.command.is_none());
}

#[test]
fn admission_refuses_deferred_or_read_only_candidate() {
    let gate = ready_gate();
    let admission = selected_task_command_admission(SelectedTaskCommandAdmissionInput {
        gate,
        intent: intent(
            SelectedTaskActionFamily::PrepareDelegation,
            Some("rev:task:1"),
            None,
        ),
    });

    assert_eq!(
        admission.status,
        SelectedTaskCommandAdmissionStatus::Refused
    );
    assert_eq!(
        admission.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskCommandAdmissionRefusalKind::CandidateNotAdmitted)
    );
    assert!(admission.command.is_none());
}

#[test]
fn admission_requires_expected_revision_for_mutating_candidate() {
    let gate = ready_gate();
    let admission = selected_task_command_admission(SelectedTaskCommandAdmissionInput {
        gate,
        intent: intent(SelectedTaskActionFamily::StartSelectedTask, None, None),
    });

    assert_eq!(
        admission.status,
        SelectedTaskCommandAdmissionStatus::Refused
    );
    assert_eq!(
        admission.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskCommandAdmissionRefusalKind::ExpectedRevisionRequired)
    );
}

fn ready_gate() -> SelectedTaskOperatorActionGate {
    let drilldown = task_workflow_drilldown(TaskWorkflowDrilldownInput {
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        task: Some(TaskWorkflowTaskInput {
            title: "Selected task".to_owned(),
            activity: "ready".to_owned(),
            assignment: "unassigned".to_owned(),
            action_type: "execute".to_owned(),
        }),
        readiness: Some(TaskWorkflowReadinessInput {
            lane: "agent_delegation_ready".to_owned(),
            rationale_refs: vec!["readiness:1".to_owned()],
        }),
        timeline_entry_refs: vec!["timeline:1".to_owned()],
        work_progress: Vec::new(),
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
        expected_revision: None,
        actor_ref: Some("operator:test".to_owned()),
    })
}

fn intent(
    family: SelectedTaskActionFamily,
    expected_revision: Option<&str>,
    reason: Option<&str>,
) -> SelectedTaskCommandOperatorIntent {
    SelectedTaskCommandOperatorIntent {
        family,
        expected_revision: expected_revision.map(|revision| RevisionId(revision.to_owned())),
        reason: reason.map(str::to_owned),
        operator_ref: "operator:test".to_owned(),
    }
}
