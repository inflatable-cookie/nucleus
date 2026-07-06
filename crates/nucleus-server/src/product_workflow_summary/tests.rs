use nucleus_projects::ProjectId;

use super::{
    product_workflow_summary, ProductWorkflowGapArea, ProductWorkflowNextStepInput,
    ProductWorkflowNextStepSource, ProductWorkflowNoEffects, ProductWorkflowSummaryInput,
    ProductWorkflowTaskCandidateInput, ProductWorkflowTaskLane,
};

#[test]
fn product_workflow_summary_groups_lanes_and_sanitizes_refs() {
    let summary = product_workflow_summary(ProductWorkflowSummaryInput {
        project_id: ProjectId("project:nucleus".to_owned()),
        project_display_name: Some(" Nucleus ".to_owned()),
        project_status: Some(" active ".to_owned()),
        authority_refs: vec![
            " authority:project ".to_owned(),
            "authority:project".to_owned(),
        ],
        task_candidates: vec![
            ProductWorkflowTaskCandidateInput {
                task_ref: " task:ready:2 ".to_owned(),
                lane: ProductWorkflowTaskLane::Ready,
                rationale_refs: vec!["roadmap:2".to_owned(), " ".to_owned()],
            },
            ProductWorkflowTaskCandidateInput {
                task_ref: "task:ready:1".to_owned(),
                lane: ProductWorkflowTaskLane::Ready,
                rationale_refs: vec!["roadmap:1".to_owned(), "roadmap:1".to_owned()],
            },
            ProductWorkflowTaskCandidateInput {
                task_ref: "task:blocked".to_owned(),
                lane: ProductWorkflowTaskLane::Blocked,
                rationale_refs: vec!["gap:blocked".to_owned()],
            },
            ProductWorkflowTaskCandidateInput {
                task_ref: " ".to_owned(),
                lane: ProductWorkflowTaskLane::Active,
                rationale_refs: vec!["ignored".to_owned()],
            },
        ],
        planning_session_refs: vec!["planning:1".to_owned()],
        task_seed_refs: vec!["seed:1".to_owned()],
        accepted_planning_refs: vec!["accepted:planning:1".to_owned()],
        memory_proposal_refs: vec!["memory:proposal:1".to_owned()],
        accepted_memory_refs: vec![
            "memory:accepted:2".to_owned(),
            "memory:accepted:1".to_owned(),
        ],
        research_run_refs: vec!["research:1".to_owned()],
        runtime_evidence_refs: vec!["runtime:1".to_owned()],
        command_evidence_refs: vec!["command:1".to_owned()],
        review_refs: vec!["review:1".to_owned()],
        scm_readiness_refs: vec!["scm:ready".to_owned()],
        next_step: Some(ProductWorkflowNextStepInput {
            source: ProductWorkflowNextStepSource::Roadmap,
            next_ref: Some(" docs/roadmaps/g04/batch-cards/003 ".to_owned()),
            summary: "Expose the summary through diagnostics.".to_owned(),
            rationale_refs: vec!["roadmap:next".to_owned(), "roadmap:next".to_owned()],
        }),
    });

    let ready_lane = summary
        .task_lanes
        .iter()
        .find(|lane| lane.lane == ProductWorkflowTaskLane::Ready)
        .expect("ready lane");
    assert_eq!(ready_lane.count, 2);
    assert_eq!(
        ready_lane.task_refs,
        vec!["task:ready:1".to_owned(), "task:ready:2".to_owned()]
    );
    assert_eq!(
        ready_lane.rationale_refs,
        vec!["roadmap:1".to_owned(), "roadmap:2".to_owned()]
    );

    assert_eq!(summary.project.display_name, Some("Nucleus".to_owned()));
    assert_eq!(summary.project.status, Some("active".to_owned()));
    assert_eq!(
        summary.project.authority_refs,
        vec!["authority:project".to_owned()]
    );
    assert_eq!(
        summary.context.accepted_memory_refs,
        vec![
            "memory:accepted:1".to_owned(),
            "memory:accepted:2".to_owned()
        ]
    );
    assert_eq!(summary.next.rationale_refs, vec!["roadmap:next".to_owned()]);
    assert_eq!(summary.no_effects, ProductWorkflowNoEffects::read_only());
    assert!(summary.gaps.is_empty());
}

#[test]
fn product_workflow_summary_reports_missing_sources_as_gaps() {
    let summary = product_workflow_summary(ProductWorkflowSummaryInput {
        project_id: ProjectId("project:nucleus".to_owned()),
        project_display_name: None,
        project_status: None,
        authority_refs: Vec::new(),
        task_candidates: Vec::new(),
        planning_session_refs: Vec::new(),
        task_seed_refs: Vec::new(),
        accepted_planning_refs: Vec::new(),
        memory_proposal_refs: Vec::new(),
        accepted_memory_refs: Vec::new(),
        research_run_refs: Vec::new(),
        runtime_evidence_refs: Vec::new(),
        command_evidence_refs: Vec::new(),
        review_refs: Vec::new(),
        scm_readiness_refs: Vec::new(),
        next_step: None,
    });

    let gap_areas: Vec<ProductWorkflowGapArea> = summary.gaps.iter().map(|gap| gap.area).collect();
    assert_eq!(
        gap_areas,
        vec![
            ProductWorkflowGapArea::Tasks,
            ProductWorkflowGapArea::Planning,
            ProductWorkflowGapArea::Context,
            ProductWorkflowGapArea::Runtime,
            ProductWorkflowGapArea::Review,
            ProductWorkflowGapArea::ScmReadiness,
            ProductWorkflowGapArea::Next,
        ]
    );
    assert_eq!(
        summary.next.source,
        ProductWorkflowNextStepSource::BlockedByMissingPathway
    );
    assert_eq!(
        summary.next.blocked_reason,
        Some("no next-task pathway source was provided".to_owned())
    );
    assert_eq!(summary.source_counts.task_candidates, 0);
    assert!(!summary.no_effects.task_mutation_performed);
    assert!(!summary.no_effects.provider_execution_performed);
    assert!(!summary.no_effects.scm_or_forge_mutation_performed);
    assert!(!summary.no_effects.ui_effect_performed);
}
