use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, SelectedTaskCompletionRouteApply,
    SelectedTaskCompletionRouteApplyRefusal, SelectedTaskCompletionRouteApplyRefusalKind,
    SelectedTaskCompletionRouteApplyStatus, SelectedTaskReviewOutcomeRouteNoEffects,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult, TaskCommand, TaskTransitionCommand,
};
use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

#[test]
fn response_envelope_dto_serializes_selected_task_completion_route_apply_without_effects() {
    let response = ServerControlResponse {
        request_id: crate::ids::ServerControlRequestId("request:completion-route-apply".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(
            ServerQueryResult::SelectedTaskCompletionRouteApply(completion_route_apply()),
        ),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let ControlResponseBodyDto::SelectedTaskCompletionRouteApply { apply } = &dto.body else {
        panic!("expected selected task completion route apply body");
    };
    let json = serde_json::to_string(&dto).expect("serialize dto");

    assert_eq!(apply.project_id, "project:1");
    assert_eq!(apply.task_id, "task:1");
    assert_eq!(apply.status, "refused");
    assert_eq!(
        apply
            .command
            .as_ref()
            .map(|command| command.action.as_str()),
        Some("complete")
    );
    assert_eq!(
        apply.refusal.as_ref().map(|refusal| refusal.kind.as_str()),
        Some("route_admission_refused")
    );
    assert!(!apply.no_effects.task_lifecycle_mutation_performed);
    assert!(!apply.no_effects.provider_execution_performed);
    assert!(!apply.no_effects.scm_or_forge_mutation_performed);
    assert!(json.contains("\"type\":\"selected_task_completion_route_apply\""));
    assert!(json.contains("\"agent_scheduling_performed\":false"));
    assert!(!json.contains("raw_payload"));
}

fn completion_route_apply() -> SelectedTaskCompletionRouteApply {
    SelectedTaskCompletionRouteApply {
        apply_id: "selected-task-completion-route-apply:task:1".to_owned(),
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        route_admission_id: "selected-task-route-admission:task:1".to_owned(),
        route_id: "selected-task-review-outcome-route:task:1".to_owned(),
        review_decision_ref: Some("selected-task-review-decision:task:1".to_owned()),
        status: SelectedTaskCompletionRouteApplyStatus::Refused,
        command: Some(TaskCommand::Complete(TaskTransitionCommand {
            task_id: TaskId("task:1".to_owned()),
            expected_revision: Some(RevisionId("rev:task:1".to_owned())),
        })),
        command_admission: None,
        refusal: Some(SelectedTaskCompletionRouteApplyRefusal {
            kind: SelectedTaskCompletionRouteApplyRefusalKind::RouteAdmissionRefused,
            reason: "completion route apply requires an admitted completion route".to_owned(),
        }),
        evidence_refs: vec!["checkpoint:1".to_owned()],
        operator_ref: "operator:test".to_owned(),
        no_effects: SelectedTaskReviewOutcomeRouteNoEffects::read_only(),
    }
}
