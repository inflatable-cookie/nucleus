use nucleus_server::ControlCommandEvidenceRecordDto;

pub(crate) fn command_evidence_response_lines(
    label: &str,
    records: Vec<ControlCommandEvidenceRecordDto>,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("records={}", records.len()),
    ];
    for record in records {
        lines.extend(command_evidence_record_lines(record));
    }
    lines
}

fn command_evidence_record_lines(record: ControlCommandEvidenceRecordDto) -> Vec<String> {
    let mut lines = vec![
        format!("record evidence_id={}", record.evidence_id),
        format!("  request_id={}", record.command_request_id),
        format!("  status={}", record.status),
        format!("  retention={}", record.retention),
    ];
    match record.exit_status {
        Some(status) => lines.push(format!("  exit_status={status}")),
        None => lines.push("  exit_status=none".to_owned()),
    }
    lines.push(format!(
        "  stdout_artifact_ref={}",
        record.stdout_artifact_ref.as_deref().unwrap_or("none")
    ));
    lines.push(format!(
        "  stderr_artifact_ref={}",
        record.stderr_artifact_ref.as_deref().unwrap_or("none")
    ));
    lines.push("  raw_output=not_retained".to_owned());
    if let Some(summary) = record.summary {
        lines.push(format!("  summary={summary}"));
    }
    lines
}
