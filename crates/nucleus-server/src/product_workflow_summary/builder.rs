use std::collections::HashMap;

use super::types::{
    ProductWorkflowContextSummary, ProductWorkflowGap, ProductWorkflowGapArea,
    ProductWorkflowLaneSummary, ProductWorkflowNextStep, ProductWorkflowNextStepInput,
    ProductWorkflowNextStepSource, ProductWorkflowNoEffects, ProductWorkflowPlanningContext,
    ProductWorkflowProjectSummary, ProductWorkflowReviewSummary, ProductWorkflowRuntimeSummary,
    ProductWorkflowScmReadinessSummary, ProductWorkflowSourceCounts, ProductWorkflowSummary,
    ProductWorkflowSummaryInput, ProductWorkflowTaskCandidateInput, ProductWorkflowTaskLane,
};

pub fn product_workflow_summary(input: ProductWorkflowSummaryInput) -> ProductWorkflowSummary {
    let authority_refs = clean_refs(input.authority_refs);
    let task_lanes = task_lane_summaries(input.task_candidates);
    let planning_session_refs = clean_refs(input.planning_session_refs);
    let task_seed_refs = clean_refs(input.task_seed_refs);
    let accepted_planning_refs = clean_refs(input.accepted_planning_refs);
    let memory_proposal_refs = clean_refs(input.memory_proposal_refs);
    let accepted_memory_refs = clean_refs(input.accepted_memory_refs);
    let research_run_refs = clean_refs(input.research_run_refs);
    let runtime_evidence_refs = clean_refs(input.runtime_evidence_refs);
    let command_evidence_refs = clean_refs(input.command_evidence_refs);
    let review_refs = clean_refs(input.review_refs);
    let scm_readiness_refs = clean_refs(input.scm_readiness_refs);
    let next = next_step(input.next_step);

    let source_counts = ProductWorkflowSourceCounts {
        task_candidates: task_lanes.iter().map(|lane| lane.count).sum(),
        planning_sessions: planning_session_refs.len(),
        task_seeds: task_seed_refs.len(),
        accepted_planning_refs: accepted_planning_refs.len(),
        memory_proposals: memory_proposal_refs.len(),
        accepted_memories: accepted_memory_refs.len(),
        research_runs: research_run_refs.len(),
        runtime_evidence_refs: runtime_evidence_refs.len(),
        command_evidence_refs: command_evidence_refs.len(),
        review_refs: review_refs.len(),
        scm_readiness_refs: scm_readiness_refs.len(),
    };

    ProductWorkflowSummary {
        summary_id: "product-workflow-summary".to_owned(),
        project_id: input.project_id,
        project: ProductWorkflowProjectSummary {
            display_name: clean_optional_ref(input.project_display_name),
            status: clean_optional_ref(input.project_status),
            authority_refs,
        },
        task_lanes,
        planning_context: ProductWorkflowPlanningContext {
            planning_session_refs,
            task_seed_refs,
            accepted_planning_refs,
        },
        context: ProductWorkflowContextSummary {
            memory_proposal_refs,
            accepted_memory_refs,
            research_run_refs,
        },
        runtime: ProductWorkflowRuntimeSummary {
            runtime_evidence_refs,
            command_evidence_refs,
        },
        review: ProductWorkflowReviewSummary { review_refs },
        scm_readiness: ProductWorkflowScmReadinessSummary {
            readiness_refs: scm_readiness_refs,
        },
        gaps: gaps(&source_counts, &next),
        next,
        source_counts,
        no_effects: ProductWorkflowNoEffects::read_only(),
    }
}

fn task_lane_summaries(
    candidates: Vec<ProductWorkflowTaskCandidateInput>,
) -> Vec<ProductWorkflowLaneSummary> {
    let mut task_refs_by_lane: HashMap<ProductWorkflowTaskLane, Vec<String>> = HashMap::new();
    let mut rationale_refs_by_lane: HashMap<ProductWorkflowTaskLane, Vec<String>> = HashMap::new();

    for candidate in candidates {
        let task_ref = candidate.task_ref.trim();
        if task_ref.is_empty() {
            continue;
        }

        task_refs_by_lane
            .entry(candidate.lane)
            .or_default()
            .push(task_ref.to_owned());
        rationale_refs_by_lane
            .entry(candidate.lane)
            .or_default()
            .extend(candidate.rationale_refs);
    }

    ProductWorkflowTaskLane::ORDERED
        .iter()
        .map(|lane| {
            let task_refs = clean_refs(task_refs_by_lane.remove(lane).unwrap_or_default());
            let rationale_refs =
                clean_refs(rationale_refs_by_lane.remove(lane).unwrap_or_default());
            ProductWorkflowLaneSummary {
                lane: *lane,
                count: task_refs.len(),
                task_refs,
                rationale_refs,
            }
        })
        .collect()
}

fn next_step(input: Option<ProductWorkflowNextStepInput>) -> ProductWorkflowNextStep {
    match input {
        Some(next) => ProductWorkflowNextStep {
            source: next.source,
            next_ref: clean_optional(next.next_ref.unwrap_or_default()),
            summary: next.summary.trim().to_owned(),
            rationale_refs: clean_refs(next.rationale_refs),
            blocked_reason: None,
        },
        None => ProductWorkflowNextStep {
            source: ProductWorkflowNextStepSource::BlockedByMissingPathway,
            next_ref: None,
            summary: String::new(),
            rationale_refs: Vec::new(),
            blocked_reason: Some("no next-task pathway source was provided".to_owned()),
        },
    }
}

fn gaps(
    counts: &ProductWorkflowSourceCounts,
    next: &ProductWorkflowNextStep,
) -> Vec<ProductWorkflowGap> {
    let mut gaps = Vec::new();

    if counts.task_candidates == 0 {
        gaps.push(gap(
            ProductWorkflowGapArea::Tasks,
            "no task candidates were available",
        ));
    }

    if counts.planning_sessions == 0 && counts.task_seeds == 0 && counts.accepted_planning_refs == 0
    {
        gaps.push(gap(
            ProductWorkflowGapArea::Planning,
            "no planning sessions, task seeds, or accepted planning refs were available",
        ));
    }

    if counts.memory_proposals == 0 && counts.accepted_memories == 0 && counts.research_runs == 0 {
        gaps.push(gap(
            ProductWorkflowGapArea::Context,
            "no memory, accepted context, or research refs were available",
        ));
    }

    if counts.runtime_evidence_refs == 0 && counts.command_evidence_refs == 0 {
        gaps.push(gap(
            ProductWorkflowGapArea::Runtime,
            "no runtime or command evidence refs were available",
        ));
    }

    if counts.review_refs == 0 {
        gaps.push(gap(
            ProductWorkflowGapArea::Review,
            "no review refs were available",
        ));
    }

    if counts.scm_readiness_refs == 0 {
        gaps.push(gap(
            ProductWorkflowGapArea::ScmReadiness,
            "no SCM readiness refs were available",
        ));
    }

    if next.source == ProductWorkflowNextStepSource::BlockedByMissingPathway {
        gaps.push(gap(
            ProductWorkflowGapArea::Next,
            "no next task source was available",
        ));
    }

    gaps
}

fn gap(area: ProductWorkflowGapArea, reason: &str) -> ProductWorkflowGap {
    ProductWorkflowGap {
        area,
        reason: reason.to_owned(),
    }
}

fn clean_refs(refs: Vec<String>) -> Vec<String> {
    let mut refs: Vec<String> = refs
        .into_iter()
        .map(|reference| reference.trim().to_owned())
        .filter(|reference| !reference.is_empty())
        .collect();
    refs.sort();
    refs.dedup();
    refs
}

fn clean_optional(value: String) -> Option<String> {
    let value = value.trim().to_owned();
    (!value.is_empty()).then_some(value)
}

fn clean_optional_ref(value: Option<String>) -> Option<String> {
    value.and_then(clean_optional)
}
