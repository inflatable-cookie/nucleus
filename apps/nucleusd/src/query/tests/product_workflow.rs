use nucleus_server::{
    ControlProductWorkflowContextDto, ControlProductWorkflowGapDto, ControlProductWorkflowLaneDto,
    ControlProductWorkflowNextDto, ControlProductWorkflowNoEffectsDto,
    ControlProductWorkflowPlanningContextDto, ControlProductWorkflowProjectDto,
    ControlProductWorkflowReviewDto, ControlProductWorkflowRuntimeDto,
    ControlProductWorkflowScmReadinessDto, ControlProductWorkflowSourceCountsDto,
    ControlProductWorkflowSummaryDto,
};

use super::*;

#[test]
fn product_workflow_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::product_workflow_response_lines(
        "product-workflow-summary",
        ControlProductWorkflowSummaryDto {
            summary_id: "product-workflow-summary".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            project: ControlProductWorkflowProjectDto {
                display_name: Some("Nucleus".to_owned()),
                status: Some("active".to_owned()),
                authority_refs: vec!["authority:project".to_owned()],
            },
            task_lanes: vec![ControlProductWorkflowLaneDto {
                lane: "ready".to_owned(),
                count: 1,
                task_refs: vec!["task:nucleus-local:bootstrap".to_owned()],
                rationale_refs: vec!["roadmap:next".to_owned()],
            }],
            planning_context: ControlProductWorkflowPlanningContextDto {
                planning_session_refs: vec!["planning:1".to_owned()],
                task_seed_refs: Vec::new(),
                accepted_planning_refs: Vec::new(),
            },
            context: ControlProductWorkflowContextDto {
                memory_proposal_refs: Vec::new(),
                accepted_memory_refs: Vec::new(),
                research_run_refs: Vec::new(),
            },
            runtime: ControlProductWorkflowRuntimeDto {
                runtime_evidence_refs: Vec::new(),
                command_evidence_refs: Vec::new(),
            },
            review: ControlProductWorkflowReviewDto {
                review_refs: Vec::new(),
            },
            scm_readiness: ControlProductWorkflowScmReadinessDto {
                readiness_refs: Vec::new(),
            },
            next: ControlProductWorkflowNextDto {
                source: "blocked_by_missing_pathway".to_owned(),
                next_ref: None,
                summary: String::new(),
                rationale_refs: Vec::new(),
                blocked_reason: Some("no next-task pathway source was provided".to_owned()),
            },
            source_counts: ControlProductWorkflowSourceCountsDto {
                task_candidates: 1,
                planning_sessions: 1,
                task_seeds: 0,
                accepted_planning_refs: 0,
                memory_proposals: 0,
                accepted_memories: 0,
                research_runs: 0,
                runtime_evidence_refs: 0,
                command_evidence_refs: 0,
                review_refs: 0,
                scm_readiness_refs: 0,
            },
            gaps: vec![ControlProductWorkflowGapDto {
                area: "runtime".to_owned(),
                reason: "no runtime or command evidence refs were available".to_owned(),
            }],
            no_effects: ControlProductWorkflowNoEffectsDto {
                task_mutation_performed: false,
                provider_execution_performed: false,
                provider_write_performed: false,
                scm_or_forge_mutation_performed: false,
                accepted_memory_apply_performed: false,
                projection_write_performed: false,
                agent_scheduling_performed: false,
                ui_effect_performed: false,
            },
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=product-workflow-summary"));
    assert!(rendered.contains("project_id=project:nucleus-local"));
    assert!(rendered.contains("task_candidates=1"));
    assert!(rendered.contains("lane label=ready count=1"));
    assert!(rendered.contains("task_mutation=false"));
    assert!(rendered.contains("provider_execution=false"));
    assert!(rendered.contains("scm_or_forge_mutation=false"));
    assert!(rendered.contains("ui_effect=false"));
    assert!(rendered.contains("payloads_exposed=false"));
    assert!(!rendered.contains("raw_payload"));
    assert!(!rendered.contains("provider_write_executed=true"));
}
