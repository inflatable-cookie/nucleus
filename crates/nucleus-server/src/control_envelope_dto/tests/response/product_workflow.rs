use crate::{
    product_workflow_summary, ControlResponseBodyDto, ControlResponseEnvelopeDto,
    ProductWorkflowNextStepInput, ProductWorkflowNextStepSource, ProductWorkflowSummaryInput,
    ProductWorkflowTaskCandidateInput, ProductWorkflowTaskLane, ServerControlRequestId,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult,
};
use nucleus_projects::ProjectId;

#[test]
fn response_envelope_dto_serializes_product_workflow_summary_without_effects() {
    let summary = product_workflow_summary(ProductWorkflowSummaryInput {
        project_id: ProjectId("project:dto".to_owned()),
        project_display_name: Some("Nucleus".to_owned()),
        project_status: Some("active".to_owned()),
        authority_refs: vec!["authority:project".to_owned()],
        task_candidates: vec![ProductWorkflowTaskCandidateInput {
            task_ref: "task:ready".to_owned(),
            lane: ProductWorkflowTaskLane::Ready,
            rationale_refs: vec!["roadmap:next".to_owned()],
        }],
        planning_session_refs: vec!["planning:1".to_owned()],
        task_seed_refs: Vec::new(),
        accepted_planning_refs: Vec::new(),
        memory_proposal_refs: Vec::new(),
        accepted_memory_refs: Vec::new(),
        research_run_refs: Vec::new(),
        runtime_evidence_refs: Vec::new(),
        command_evidence_refs: Vec::new(),
        review_refs: Vec::new(),
        scm_readiness_refs: Vec::new(),
        next_step: Some(ProductWorkflowNextStepInput {
            source: ProductWorkflowNextStepSource::Roadmap,
            next_ref: Some("docs/roadmaps/g04/batch-cards/003".to_owned()),
            summary: "Expose product workflow query.".to_owned(),
            rationale_refs: vec!["roadmap:next".to_owned()],
        }),
    });
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:product-workflow".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::ProductWorkflowSummary(summary)),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::ProductWorkflowSummary { summary }
            if summary.project_id == "project:dto"
                && summary.task_lanes.iter().any(|lane| lane.lane == "ready" && lane.count == 1)
                && summary.next.source == "roadmap"
                && !summary.no_effects.task_mutation_performed
                && !summary.no_effects.provider_execution_performed
                && !summary.no_effects.scm_or_forge_mutation_performed
                && !summary.no_effects.ui_effect_performed
    ));
    assert!(json.contains("\"type\":\"product_workflow_summary\""));
    assert!(json.contains("\"task_mutation_performed\":false"));
    assert!(json.contains("\"provider_execution_performed\":false"));
}
