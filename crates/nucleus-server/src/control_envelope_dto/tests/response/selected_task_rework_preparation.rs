use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, SelectedTaskReworkPreparation,
    SelectedTaskReworkPreparationNoEffects, SelectedTaskReworkPreparationRefusal,
    SelectedTaskReworkPreparationRefusalKind, SelectedTaskReworkPreparationStatus,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult,
};
use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

#[test]
fn response_envelope_dto_serializes_selected_task_rework_preparation_without_effects() {
    let response = ServerControlResponse {
        request_id: crate::ids::ServerControlRequestId("request:rework-preparation".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::SelectedTaskReworkPreparation(
            rework_preparation(),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let ControlResponseBodyDto::SelectedTaskReworkPreparation { preparation } = &dto.body else {
        panic!("expected selected task rework preparation body");
    };
    let json = serde_json::to_string(&dto).expect("serialize dto");

    assert_eq!(preparation.project_id, "project:1");
    assert_eq!(preparation.task_id, "task:1");
    assert_eq!(preparation.status, "refused");
    assert_eq!(
        preparation
            .refusal
            .as_ref()
            .map(|refusal| refusal.kind.as_str()),
        Some("route_admission_refused")
    );
    assert_eq!(preparation.reviewed_work_item_refs, vec!["work:1"]);
    assert_eq!(preparation.reviewed_evidence_refs, vec!["checkpoint:1"]);
    assert!(!preparation.no_effects.work_item_creation_performed);
    assert!(!preparation.no_effects.task_lifecycle_mutation_performed);
    assert!(!preparation.no_effects.provider_execution_performed);
    assert!(!preparation.no_effects.scm_or_forge_mutation_performed);
    assert!(json.contains("\"type\":\"selected_task_rework_preparation\""));
    assert!(json.contains("\"work_item_creation_performed\":false"));
    assert!(!json.contains("raw_payload"));
}

fn rework_preparation() -> SelectedTaskReworkPreparation {
    SelectedTaskReworkPreparation {
        preparation_id: "selected-task-rework-preparation:task:1".to_owned(),
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        route_admission_id: "selected-task-rework-delegation-route-admission:task:1".to_owned(),
        route_id: "selected-task-review-outcome-route:task:1".to_owned(),
        review_decision_ref: Some("selected-task-review-decision:task:1".to_owned()),
        status: SelectedTaskReworkPreparationStatus::Refused,
        refusal: Some(SelectedTaskReworkPreparationRefusal {
            kind: SelectedTaskReworkPreparationRefusalKind::RouteAdmissionRefused,
            reason: "rework preparation requires an admitted rework route".to_owned(),
        }),
        reviewed_work_item_refs: vec!["work:1".to_owned()],
        reviewed_evidence_refs: vec!["checkpoint:1".to_owned()],
        operator_ref: "operator:test".to_owned(),
        expected_task_revision: Some(RevisionId("rev:task:1".to_owned())),
        expected_work_item_revision: Some(RevisionId("rev:work:1".to_owned())),
        rework_summary: None,
        no_effects: SelectedTaskReworkPreparationNoEffects::read_only(),
    }
}
