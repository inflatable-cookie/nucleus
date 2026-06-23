use nucleus_server::{
    ControlPlanningTaskSeedCandidateDto, ControlPlanningTaskSeedSourceCountsDto,
    ControlPlanningTaskSeedStatusCountDto,
};

pub(crate) fn planning_task_seeds_response_lines(
    label: &str,
    project_id: String,
    candidates: Vec<ControlPlanningTaskSeedCandidateDto>,
    status_counts: Vec<ControlPlanningTaskSeedStatusCountDto>,
    source_counts: ControlPlanningTaskSeedSourceCountsDto,
    client_can_promote: bool,
    task_creation_performed: bool,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("project_id={project_id}"),
        format!("candidates={}", candidates.len()),
        format!(
            "source_counts task_seed_records={} source_artifact_refs={} context_refs={} validation_hint_refs={}",
            source_counts.task_seed_records,
            source_counts.source_artifact_refs,
            source_counts.context_refs,
            source_counts.validation_hint_refs
        ),
        format!("client_can_promote={client_can_promote}"),
        format!("task_creation_performed={task_creation_performed}"),
    ];
    lines.extend(
        status_counts
            .into_iter()
            .map(|count| format!("status readiness={} count={}", count.readiness, count.count)),
    );
    lines.extend(candidates.into_iter().map(|candidate| {
        format!(
            "candidate seed_id={} readiness={} action={} importance={} blockers={} context_refs={} validation_hint_refs={} title={}",
            candidate.seed_id,
            candidate.readiness,
            candidate.suggested_action_type,
            candidate.suggested_importance,
            candidate.blocking_questions.len(),
            candidate.context_refs.len(),
            candidate.validation_hint_refs.len(),
            candidate.title
        )
    }));
    lines
}
