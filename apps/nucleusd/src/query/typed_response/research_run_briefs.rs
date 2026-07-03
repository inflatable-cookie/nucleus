use nucleus_server::{
    ControlResearchObservationKindCountDto, ControlResearchRunBriefSourceCountsDto,
    ControlResearchRunBriefStatusCountDto, ControlResearchRunBriefSummaryDto,
    ControlResearchSourceKindCountDto, ControlResearchSynthesisKindCountDto,
};

pub(crate) fn research_run_briefs_response_lines(
    label: &str,
    project_id: String,
    runs: Vec<ControlResearchRunBriefSummaryDto>,
    status_counts: Vec<ControlResearchRunBriefStatusCountDto>,
    source_kind_counts: Vec<ControlResearchSourceKindCountDto>,
    observation_kind_counts: Vec<ControlResearchObservationKindCountDto>,
    synthesis_kind_counts: Vec<ControlResearchSynthesisKindCountDto>,
    source_counts: ControlResearchRunBriefSourceCountsDto,
    client_can_mutate: bool,
    provider_execution_available: bool,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("project_id={project_id}"),
        format!("runs={}", runs.len()),
        format!(
            "source_counts run_records={} source_plan_refs={} questions={} source_refs={} observation_refs={} synthesis_refs={} promotion_target_refs={} coverage_refs={} gap_refs={}",
            source_counts.run_records,
            source_counts.source_plan_refs,
            source_counts.questions,
            source_counts.source_refs,
            source_counts.observation_refs,
            source_counts.synthesis_refs,
            source_counts.promotion_target_refs,
            source_counts.coverage_refs,
            source_counts.gap_refs
        ),
        format!("client_can_mutate={client_can_mutate}"),
        format!("provider_execution_available={provider_execution_available}"),
    ];
    lines.extend(
        status_counts
            .into_iter()
            .map(|count| format!("status state={} count={}", count.status, count.count)),
    );
    lines.extend(
        source_kind_counts
            .into_iter()
            .map(|count| format!("source_kind kind={} count={}", count.kind, count.count)),
    );
    lines.extend(
        observation_kind_counts
            .into_iter()
            .map(|count| format!("observation_kind kind={} count={}", count.kind, count.count)),
    );
    lines.extend(
        synthesis_kind_counts
            .into_iter()
            .map(|count| format!("synthesis_kind kind={} count={}", count.kind, count.count)),
    );
    lines.extend(runs.into_iter().map(|run| {
        format!(
            "run run_id={} status={} source_plan_refs={} questions={} source_refs={} observation_refs={} synthesis_refs={} promotion_target_refs={} coverage_refs={} gap_refs={}",
            run.run_id,
            run.status,
            run.source_plan_ref_count,
            run.question_count,
            run.source_ref_count,
            run.observation_ref_count,
            run.synthesis_ref_count,
            run.promotion_target_ref_count,
            run.coverage_ref_count,
            run.gap_ref_count
        )
    }));
    lines
}
