use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, SelectedTaskCompletionRouteAdmission,
    SelectedTaskReviewOutcomeRouteCandidate, SelectedTaskReviewOutcomeRouteNoEffects,
    SelectedTaskReworkDelegationRouteAdmission, SelectedTaskRouteAdmission,
    SelectedTaskRouteAdmissionPreview, SelectedTaskRouteAdmissionPreviewFamily,
    SelectedTaskRouteAdmissionStatus, ServerControlResponse, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQueryResult,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

#[test]
fn response_envelope_dto_serializes_selected_task_route_admission_without_effects() {
    let response = ServerControlResponse {
        request_id: crate::ids::ServerControlRequestId("request:route-admission".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::SelectedTaskRouteAdmission(
            route_admission(),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let ControlResponseBodyDto::SelectedTaskRouteAdmission { admission } = &dto.body else {
        panic!("expected selected task route admission body");
    };
    let json = serde_json::to_string(&dto).expect("serialize dto");

    assert_eq!(admission.project_id, "project:1");
    assert_eq!(admission.task_id, "task:1");
    assert_eq!(admission.completion.status, "refused");
    assert_eq!(admission.rework_delegation.status, "admitted");
    assert_eq!(
        admission
            .rework_delegation
            .rework_preview
            .as_ref()
            .map(|preview| preview.family.as_str()),
        Some("prepare_rework")
    );
    assert_eq!(
        admission
            .rework_delegation
            .delegation_preview
            .as_ref()
            .map(|preview| preview.family.as_str()),
        Some("delegate_rework")
    );
    assert!(!admission.no_effects.task_lifecycle_mutation_performed);
    assert!(!admission.no_effects.provider_execution_performed);
    assert!(!admission.no_effects.scm_or_forge_mutation_performed);
    assert!(json.contains("\"type\":\"selected_task_route_admission\""));
    assert!(json.contains("\"agent_scheduling_performed\":false"));
    assert!(!json.contains("raw_payload"));
}

fn route_admission() -> SelectedTaskRouteAdmission {
    let no_effects = SelectedTaskReviewOutcomeRouteNoEffects::read_only();
    SelectedTaskRouteAdmission {
        admission_id: "selected-task-route-admission:task:1".to_owned(),
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        route_id: "selected-task-review-outcome-route:task:1".to_owned(),
        completion: SelectedTaskCompletionRouteAdmission {
            admission_id: "selected-task-completion-route-admission:task:1".to_owned(),
            project_id: ProjectId("project:1".to_owned()),
            task_id: TaskId("task:1".to_owned()),
            route_id: "selected-task-review-outcome-route:task:1".to_owned(),
            route_candidate: SelectedTaskReviewOutcomeRouteCandidate::ReadyForReworkAdmission,
            decision_ref: Some("decision:1".to_owned()),
            status: SelectedTaskRouteAdmissionStatus::Refused,
            command_admission: None,
            refusal: None,
            evidence_refs: vec!["checkpoint:1".to_owned()],
            no_effects: no_effects.clone(),
        },
        rework_delegation: SelectedTaskReworkDelegationRouteAdmission {
            admission_id: "selected-task-rework-delegation-route-admission:task:1".to_owned(),
            project_id: ProjectId("project:1".to_owned()),
            task_id: TaskId("task:1".to_owned()),
            route_id: "selected-task-review-outcome-route:task:1".to_owned(),
            route_candidate: SelectedTaskReviewOutcomeRouteCandidate::ReadyForReworkAdmission,
            decision_ref: Some("decision:1".to_owned()),
            status: SelectedTaskRouteAdmissionStatus::Admitted,
            rework_preview: Some(preview(
                SelectedTaskRouteAdmissionPreviewFamily::PrepareRework,
            )),
            delegation_preview: Some(preview(
                SelectedTaskRouteAdmissionPreviewFamily::DelegateRework,
            )),
            refusal: None,
            work_item_refs: vec!["work:1".to_owned()],
            evidence_refs: vec!["checkpoint:1".to_owned()],
            no_effects: no_effects.clone(),
        },
        no_effects,
    }
}

fn preview(family: SelectedTaskRouteAdmissionPreviewFamily) -> SelectedTaskRouteAdmissionPreview {
    SelectedTaskRouteAdmissionPreview {
        family,
        summary: "preview only".to_owned(),
        source_refs: vec!["work:1".to_owned()],
        evidence_refs: vec!["checkpoint:1".to_owned()],
    }
}
