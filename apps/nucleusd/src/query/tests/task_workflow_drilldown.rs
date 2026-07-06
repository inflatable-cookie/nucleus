use nucleus_server::{
    ControlTaskWorkflowDrilldownDto, ControlTaskWorkflowGapDto, ControlTaskWorkflowNextDto,
    ControlTaskWorkflowNoEffectsDto, ControlTaskWorkflowReadinessDto, ControlTaskWorkflowReviewDto,
    ControlTaskWorkflowRuntimeDto, ControlTaskWorkflowScmHandoffDto,
    ControlTaskWorkflowSourceCountsDto, ControlTaskWorkflowTaskDto, ControlTaskWorkflowTimelineDto,
    ControlTaskWorkflowWorkItemDto, ControlTaskWorkflowWorkProgressDto,
};

use super::*;

#[test]
fn task_workflow_drilldown_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::task_workflow_drilldown_response_lines(
        "task-workflow-drilldown",
        ControlTaskWorkflowDrilldownDto {
            drilldown_id: "task-workflow-drilldown:task:nucleus-local:bootstrap".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            task: Some(ControlTaskWorkflowTaskDto {
                title: "Review Nucleus task workflow".to_owned(),
                activity: "ready".to_owned(),
                assignment: "unassigned".to_owned(),
                action_type: "plan".to_owned(),
            }),
            readiness: Some(ControlTaskWorkflowReadinessDto {
                lane: "human_planning_ready".to_owned(),
                rationale_refs: vec!["roadmap:next".to_owned()],
            }),
            timeline: ControlTaskWorkflowTimelineDto {
                entry_refs: vec!["timeline:1".to_owned()],
            },
            work_progress: ControlTaskWorkflowWorkProgressDto {
                work_items: vec![ControlTaskWorkflowWorkItemDto {
                    work_item_ref: "work:1".to_owned(),
                    runtime_status: "running".to_owned(),
                    review_status: "not_ready".to_owned(),
                    source_ref: "source:1".to_owned(),
                    source_count: 1,
                    session_ref: None,
                    turn_refs: Vec::new(),
                    receipt_refs: vec!["receipt:1".to_owned()],
                    checkpoint_refs: Vec::new(),
                    diff_summary_refs: Vec::new(),
                    timeline_entry_refs: vec!["timeline:1".to_owned()],
                    validation_refs: Vec::new(),
                    artifact_refs: Vec::new(),
                    issue_refs: Vec::new(),
                }],
            },
            runtime: ControlTaskWorkflowRuntimeDto {
                runtime_receipt_refs: vec!["receipt:1".to_owned()],
                command_evidence_refs: vec!["command:evidence:1".to_owned()],
                task_completion_refs: Vec::new(),
            },
            review: ControlTaskWorkflowReviewDto {
                review_refs: Vec::new(),
            },
            scm_handoff: ControlTaskWorkflowScmHandoffDto {
                handoff_refs: Vec::new(),
            },
            next: ControlTaskWorkflowNextDto {
                source: "task".to_owned(),
                next_ref: Some("task:nucleus-local:bootstrap".to_owned()),
                summary: "Continue selected task.".to_owned(),
                rationale_refs: vec!["roadmap:next".to_owned()],
                blocked_reason: None,
            },
            source_counts: ControlTaskWorkflowSourceCountsDto {
                task_records: 1,
                readiness_refs: 1,
                timeline_entry_refs: 1,
                work_items: 1,
                runtime_receipt_refs: 1,
                command_evidence_refs: 1,
                task_completion_refs: 0,
                review_refs: 0,
                scm_handoff_refs: 0,
            },
            gaps: vec![ControlTaskWorkflowGapDto {
                area: "review_missing".to_owned(),
                reason: "no review refs were available for the selected task".to_owned(),
            }],
            no_effects: ControlTaskWorkflowNoEffectsDto {
                task_mutation_performed: false,
                provider_execution_performed: false,
                provider_write_performed: false,
                scm_or_forge_mutation_performed: false,
                accepted_memory_apply_performed: false,
                planning_apply_performed: false,
                projection_write_performed: false,
                agent_scheduling_performed: false,
                ui_effect_performed: false,
            },
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=task-workflow-drilldown"));
    assert!(rendered.contains("project_id=project:nucleus-local"));
    assert!(rendered.contains("task_id=task:nucleus-local:bootstrap"));
    assert!(rendered.contains("work_items=1"));
    assert!(rendered.contains("next source=task"));
    assert!(rendered.contains("task_mutation=false"));
    assert!(rendered.contains("provider_execution=false"));
    assert!(rendered.contains("scm_or_forge_mutation=false"));
    assert!(rendered.contains("ui_effect=false"));
    assert!(rendered.contains("payloads_exposed=false"));
    assert!(!rendered.contains("raw_payload"));
    assert!(!rendered.contains("provider_write_executed=true"));
}
