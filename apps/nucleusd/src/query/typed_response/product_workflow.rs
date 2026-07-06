use nucleus_server::ControlProductWorkflowSummaryDto;

pub(crate) fn product_workflow_response_lines(
    label: &str,
    summary: ControlProductWorkflowSummaryDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("summary_id={}", summary.summary_id),
        format!("project_id={}", summary.project_id),
        format!(
            "project display_name={} status={} authority_refs={}",
            summary.project.display_name.unwrap_or_else(|| "-".to_owned()),
            summary.project.status.unwrap_or_else(|| "-".to_owned()),
            summary.project.authority_refs.len()
        ),
        format!(
            "counts task_candidates={} planning_sessions={} task_seeds={} accepted_planning_refs={} memory_proposals={} accepted_memories={} research_runs={} runtime_evidence_refs={} command_evidence_refs={} review_refs={} scm_readiness_refs={}",
            summary.source_counts.task_candidates,
            summary.source_counts.planning_sessions,
            summary.source_counts.task_seeds,
            summary.source_counts.accepted_planning_refs,
            summary.source_counts.memory_proposals,
            summary.source_counts.accepted_memories,
            summary.source_counts.research_runs,
            summary.source_counts.runtime_evidence_refs,
            summary.source_counts.command_evidence_refs,
            summary.source_counts.review_refs,
            summary.source_counts.scm_readiness_refs
        ),
        format!(
            "next source={} next_ref={} blocked_reason={}",
            summary.next.source,
            summary.next.next_ref.unwrap_or_else(|| "-".to_owned()),
            summary.next.blocked_reason.unwrap_or_else(|| "-".to_owned())
        ),
        format!(
            "no_effects task_mutation={} provider_execution={} provider_write={} scm_or_forge_mutation={} accepted_memory_apply={} projection_write={} agent_scheduling={} ui_effect={}",
            summary.no_effects.task_mutation_performed,
            summary.no_effects.provider_execution_performed,
            summary.no_effects.provider_write_performed,
            summary.no_effects.scm_or_forge_mutation_performed,
            summary.no_effects.accepted_memory_apply_performed,
            summary.no_effects.projection_write_performed,
            summary.no_effects.agent_scheduling_performed,
            summary.no_effects.ui_effect_performed
        ),
        format!("gaps={}", summary.gaps.len()),
        "payloads_exposed=false".to_owned(),
    ];

    lines.extend(summary.task_lanes.into_iter().map(|lane| {
        format!(
            "lane label={} count={} task_refs={} rationale_refs={}",
            lane.lane,
            lane.count,
            lane.task_refs.len(),
            lane.rationale_refs.len()
        )
    }));
    lines.extend(
        summary
            .gaps
            .into_iter()
            .map(|gap| format!("gap area={} reason={}", gap.area, gap.reason)),
    );

    lines
}
