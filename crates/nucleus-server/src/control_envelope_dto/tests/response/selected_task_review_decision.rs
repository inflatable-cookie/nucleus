use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::{
    selected_task_review_decision_admission, selected_task_review_next, task_workflow_drilldown,
    ControlResponseBodyDto, ControlResponseEnvelopeDto, SelectedTaskReviewDecisionAdmissionInput,
    SelectedTaskReviewDecisionIntent, ServerControlResponse, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQueryResult, TaskWorkflowDrilldownInput,
    TaskWorkflowNextStepInput, TaskWorkflowNextStepSource, TaskWorkflowReadinessInput,
    TaskWorkflowTaskInput, TaskWorkflowWorkProgressInput,
};

#[test]
fn response_envelope_dto_serializes_selected_task_review_decision_admission_as_dry_run() {
    let review_next = review_next_fixture();
    let admission =
        selected_task_review_decision_admission(SelectedTaskReviewDecisionAdmissionInput {
            review_next,
            intent: SelectedTaskReviewDecisionIntent {
                action: crate::SelectedTaskReviewDecisionAction::AcceptEvidence,
                expected_revision: Some(RevisionId("rev:task:1".to_owned())),
                operator_ref: "operator:test".to_owned(),
                reviewed_evidence_refs: vec!["receipt:1".to_owned()],
                idempotency_key: "idempotency:review:1".to_owned(),
                reason: None,
            },
            current_revision: Some(RevisionId("rev:task:1".to_owned())),
            existing_decision_ids: Vec::new(),
        });
    let response = ServerControlResponse {
        request_id: crate::ids::ServerControlRequestId("request:review-decision".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(
            ServerQueryResult::SelectedTaskReviewDecisionAdmission(admission),
        ),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let ControlResponseBodyDto::SelectedTaskReviewDecisionAdmission { admission } = &dto.body
    else {
        panic!("expected selected task review-decision admission body");
    };
    let json = serde_json::to_string(&dto).expect("serialize dto");

    assert_eq!(admission.status, "admitted");
    assert_eq!(admission.action, "accept_evidence");
    assert_eq!(
        admission
            .command
            .as_ref()
            .map(|command| command.outcome.as_str()),
        Some("accepted")
    );
    assert_eq!(admission.refusal, None);
    assert!(!admission.no_effects.review_mutation_performed);
    assert!(!admission.no_effects.provider_execution_performed);
    assert!(!admission.no_effects.scm_or_forge_mutation_performed);
    assert!(json.contains("\"type\":\"selected_task_review_decision_admission\""));
    assert!(!json.contains("raw_payload"));
}

fn review_next_fixture() -> crate::SelectedTaskReviewNext {
    let drilldown = task_workflow_drilldown(TaskWorkflowDrilldownInput {
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        task: Some(TaskWorkflowTaskInput {
            title: "Selected task".to_owned(),
            activity: "in_progress".to_owned(),
            assignment: "agent".to_owned(),
            action_type: "execute".to_owned(),
        }),
        readiness: Some(TaskWorkflowReadinessInput {
            lane: "execution_in_progress".to_owned(),
            rationale_refs: vec!["readiness:1".to_owned()],
        }),
        timeline_entry_refs: vec!["timeline:1".to_owned()],
        work_progress: vec![TaskWorkflowWorkProgressInput {
            work_item_ref: "work:1".to_owned(),
            runtime_status: "completed".to_owned(),
            review_status: "awaiting_review".to_owned(),
            source_ref: "provider:codex".to_owned(),
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
        runtime_receipt_refs: vec!["receipt:1".to_owned()],
        command_evidence_refs: Vec::new(),
        task_completion_refs: Vec::new(),
        review_refs: Vec::new(),
        scm_handoff_refs: Vec::new(),
        next_step: Some(TaskWorkflowNextStepInput {
            source: TaskWorkflowNextStepSource::Review,
            next_ref: Some("work:1".to_owned()),
            summary: "Review completed work".to_owned(),
            rationale_refs: vec!["receipt:1".to_owned()],
        }),
    });
    selected_task_review_next(&drilldown)
}
