use nucleus_server::{ControlProjectAuthorityMapDto, ControlTaskTimelineEntryDto};

pub(crate) fn task_timeline_response_lines(
    label: &str,
    task_id: String,
    entries: Vec<ControlTaskTimelineEntryDto>,
    last_source_event_id: Option<String>,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("task_id={task_id}"),
        format!("records={}", entries.len()),
        format!(
            "last_source_event_id={}",
            last_source_event_id.as_deref().unwrap_or("none")
        ),
        "client_can_mutate=false".to_owned(),
    ];
    for entry in entries {
        lines.extend(task_timeline_entry_lines(entry));
    }
    lines
}

pub(crate) fn project_authority_map_response_lines(
    label: &str,
    record: ControlProjectAuthorityMapDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("project_id={}", record.project_id),
        format!("domains={}", record.domains.len()),
        format!("issues={}", record.issues.len()),
        "client_can_grant_authority=false".to_owned(),
        "client_can_mutate=false".to_owned(),
    ];
    for domain in record.domains {
        lines.push(format!(
            "authority domain={} state={} host={} fallbacks={} mutation_allowed={} reason={}",
            domain.domain,
            domain.state,
            domain.authoritative_host_id.as_deref().unwrap_or("none"),
            domain.fallback_host_ids.len(),
            domain
                .mutation_allowed
                .map(|allowed| allowed.to_string())
                .unwrap_or_else(|| "none".to_owned()),
            domain.reason.as_deref().unwrap_or("none")
        ));
    }
    for issue in record.issues {
        lines.push(format!(
            "issue kind={} domain={} host={} reason={}",
            issue.kind,
            issue.domain.as_deref().unwrap_or("none"),
            issue.host_id.as_deref().unwrap_or("none"),
            issue.reason.as_deref().unwrap_or("none")
        ));
    }
    lines
}

fn task_timeline_entry_lines(entry: ControlTaskTimelineEntryDto) -> Vec<String> {
    vec![
        format!("timeline entry_id={} kind={}", entry.entry_id, entry.kind),
        format!("  source_command_id={}", entry.source_command_id),
        format!("  source_event_id={}", entry.source_event_id),
        format!("  source_projection_id={}", entry.source_projection_id),
        format!("  summary={}", entry.summary),
    ]
}
