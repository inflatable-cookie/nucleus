use nucleus_server::{
    ControlPlanningSessionSourceCountsDto, ControlPlanningSessionStatusCountDto,
    ControlPlanningSessionSummaryDto,
};

pub(crate) fn planning_sessions_response_lines(
    label: &str,
    project_id: String,
    sessions: Vec<ControlPlanningSessionSummaryDto>,
    status_counts: Vec<ControlPlanningSessionStatusCountDto>,
    source_counts: ControlPlanningSessionSourceCountsDto,
    client_can_mutate: bool,
    provider_execution_available: bool,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("project_id={project_id}"),
        format!("sessions={}", sessions.len()),
        format!(
            "source_counts planning_session_records={} exploration_session_records={} prompt_or_template_refs={} participant_refs={} source_refs={} output_refs={}",
            source_counts.planning_session_records,
            source_counts.exploration_session_records,
            source_counts.prompt_or_template_refs,
            source_counts.participant_refs,
            source_counts.source_refs,
            source_counts.output_refs
        ),
        format!("client_can_mutate={client_can_mutate}"),
        format!("provider_execution_available={provider_execution_available}"),
    ];
    lines.extend(
        status_counts
            .into_iter()
            .map(|count| format!("status state={} count={}", count.status, count.count)),
    );
    lines.extend(sessions.into_iter().map(|session| {
        format!(
            "session session_id={} kind={} status={} prompts={} participants={} source_refs={} artifact_refs={} task_seed_refs={} memory_proposal_refs={} research_run_brief_refs={}",
            session.session_id,
            session.kind,
            session.status,
            session.prompt_or_template_refs.len(),
            session.participant_count,
            session.source_ref_count,
            session.output_refs.artifact_refs.len(),
            session.output_refs.task_seed_refs.len(),
            session.output_refs.memory_proposal_refs.len(),
            session.output_refs.research_run_brief_refs.len()
        )
    }));
    lines
}
