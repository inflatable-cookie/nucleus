use nucleus_server::{
    ControlTaskReadinessCandidateDto, ControlTaskReadinessSourceCountsDto,
    ControlTaskReadinessStatusCountDto,
};

pub(crate) fn task_readiness_response_lines(
    label: &str,
    project_id: String,
    candidates: Vec<ControlTaskReadinessCandidateDto>,
    status_counts: Vec<ControlTaskReadinessStatusCountDto>,
    source_counts: ControlTaskReadinessSourceCountsDto,
    client_can_mutate: bool,
    provider_execution_available: bool,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("project_id={project_id}"),
        format!("candidates={}", candidates.len()),
        format!(
            "source_counts task_records={} work_item_evidence_refs={} timeline_evidence_refs={} validation_command_refs={}",
            source_counts.task_records,
            source_counts.work_item_evidence_refs,
            source_counts.timeline_evidence_refs,
            source_counts.validation_command_refs
        ),
        format!("client_can_mutate={client_can_mutate}"),
        format!("provider_execution_available={provider_execution_available}"),
    ];
    lines.extend(
        status_counts
            .into_iter()
            .map(|count| format!("status readiness={} count={}", count.readiness, count.count)),
    );
    lines.extend(candidates.into_iter().map(|candidate| {
        format!(
            "candidate task_id={} readiness={} activity={} action={} agent_ready={} blockers={} evidence_refs={} validation_commands={} title={}",
            candidate.task_id,
            candidate.readiness,
            candidate.activity,
            candidate.action_type,
            candidate.agent_ready,
            candidate.blocker_refs.len(),
            candidate.evidence_refs.len(),
            candidate.validation_commands.len(),
            candidate.title
        )
    }));
    lines
}
