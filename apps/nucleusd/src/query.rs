use std::path::PathBuf;

use nucleus_local_store::{LocalStoreRecord, SqliteBackend};
use nucleus_server::{
    ClientId, ControlCommandEvidenceRecordDto, ControlResponseBodyDto, ControlResponseEnvelopeDto,
    LocalControlRequestHandler, ServerControlRequest, ServerControlRequestKind,
    ServerControlResponseBody, ServerControlResponseStatus, ServerQuery, ServerQueryId,
    ServerQueryKind, ServerStateDomain, StateRecordQuery, StateRecordQueryScope,
};

use crate::cli::QueryDomain;

pub(crate) fn print_status(
    handler: &mut LocalControlRequestHandler<SqliteBackend>,
    state_path: &PathBuf,
) -> Result<(), String> {
    let project_count = list_count(handler, ServerStateDomain::Projects, "projects")?;
    let task_count = list_count(handler, ServerStateDomain::Tasks, "tasks")?;

    println!("nucleusd local server smoke");
    println!("state_path={}", state_path.display());
    println!("projects={project_count}");
    println!("tasks={task_count}");
    println!("transport=none");
    println!("runtime_execution=disabled");

    Ok(())
}

pub(crate) fn print_query(
    handler: &mut LocalControlRequestHandler<SqliteBackend>,
    query: QueryDomain,
) -> Result<(), String> {
    let domain = query.state_domain();
    let label = query.label();
    let response = handler.handle(ServerControlRequest {
        id: nucleus_server::ServerControlRequestId(format!("request:nucleusd:query:{label}")),
        client_id: ClientId("client:nucleusd".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId(format!("query:nucleusd:{label}")),
            client_id: ClientId("client:nucleusd".to_owned()),
            kind: query_kind(domain),
        }),
    });

    if query == QueryDomain::CommandEvidence {
        let dto = ControlResponseEnvelopeDto::try_from(&response)
            .map_err(|error| format!("{label} query response encoding failed: {}", error.reason))?;
        return print_command_evidence_response(label, dto);
    }

    match response.body {
        ServerControlResponseBody::Query(nucleus_server::ServerQueryResult::StateRecords(set))
            if response.status == ServerControlResponseStatus::Complete =>
        {
            print_record_set(label, set.records)
        }
        ServerControlResponseBody::Query(nucleus_server::ServerQueryResult::RuntimeMetadata(
            set,
        )) if response.status == ServerControlResponseStatus::Complete => {
            print_record_set(label, set.records)
        }
        ServerControlResponseBody::Error(error) => Err(format!("{label} query failed: {error:?}")),
        body => Err(format!(
            "{label} query returned unexpected response: {body:?}"
        )),
    }
}

fn list_count(
    handler: &mut LocalControlRequestHandler<SqliteBackend>,
    domain: ServerStateDomain,
    label: &str,
) -> Result<usize, String> {
    let response = handler.handle(ServerControlRequest {
        id: nucleus_server::ServerControlRequestId(format!("request:nucleusd:{label}")),
        client_id: ClientId("client:nucleusd".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId(format!("query:nucleusd:{label}")),
            client_id: ClientId("client:nucleusd".to_owned()),
            kind: query_kind(domain),
        }),
    });

    match response.body {
        ServerControlResponseBody::Query(nucleus_server::ServerQueryResult::StateRecords(set))
            if response.status == ServerControlResponseStatus::Complete =>
        {
            Ok(set.records.len())
        }
        ServerControlResponseBody::Error(error) => Err(format!("{label} query failed: {error:?}")),
        body => Err(format!(
            "{label} query returned unexpected response: {body:?}"
        )),
    }
}

fn print_record_set(label: &str, records: Vec<LocalStoreRecord>) -> Result<(), String> {
    println!("domain={label}");
    println!("records={}", records.len());
    for record in records {
        println!(
            "record id={} kind={:?} revision={}",
            record.id.0, record.kind, record.revision_id.0
        );
    }
    Ok(())
}

fn print_command_evidence_response(
    label: &str,
    dto: ControlResponseEnvelopeDto,
) -> Result<(), String> {
    if dto.status != nucleus_server::ControlResponseStatusDto::Complete {
        return Err(format!("{label} query returned status {:?}", dto.status));
    }

    match dto.body {
        ControlResponseBodyDto::CommandEvidenceRecords { records } => {
            for line in command_evidence_response_lines(label, records) {
                println!("{line}");
            }
            Ok(())
        }
        ControlResponseBodyDto::Error { kind, reason } => {
            Err(format!("{label} query failed: {kind}: {reason}"))
        }
        body => Err(format!(
            "{label} query returned unexpected DTO response: {body:?}"
        )),
    }
}

fn command_evidence_response_lines(
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

fn query_kind(domain: ServerStateDomain) -> ServerQueryKind {
    match domain {
        ServerStateDomain::Projects => ServerQueryKind::Project(state_query(domain)),
        ServerStateDomain::Tasks => ServerQueryKind::Task(state_query(domain)),
        ServerStateDomain::Workspaces => ServerQueryKind::Workspace(state_query(domain)),
        _ => ServerQueryKind::RuntimeMetadata(
            nucleus_server::RuntimeMetadataQuery::ListCommandEvidence,
        ),
    }
}

fn state_query(domain: ServerStateDomain) -> StateRecordQuery {
    StateRecordQuery {
        domain,
        scope: StateRecordQueryScope::List,
    }
}

#[cfg(test)]
mod tests {
    use nucleus_local_store::SqliteBackend;
    use nucleus_server::LocalControlRequestHandler;

    use super::*;

    #[test]
    fn command_evidence_query_decodes_sanitized_records() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state_path = temp_dir.path().join("nucleus.sqlite");
        crate::run(vec![
            "--state".to_owned(),
            state_path.display().to_string(),
            "command-runner".to_owned(),
            "smoke".to_owned(),
        ])
        .expect("run command-runner smoke");

        let backend = SqliteBackend::new(state_path);
        let mut handler = LocalControlRequestHandler::new(backend, None);

        print_query(&mut handler, QueryDomain::CommandEvidence).expect("print evidence query");
    }

    #[test]
    fn command_evidence_response_lines_do_not_include_raw_output() {
        let lines = command_evidence_response_lines(
            "command-evidence",
            vec![ControlCommandEvidenceRecordDto {
                evidence_id: "command:evidence:test".to_owned(),
                command_request_id: "command:request:test".to_owned(),
                status: "succeeded".to_owned(),
                exit_status: Some(0),
                retention: "summary_only".to_owned(),
                summary: Some("sanitized summary".to_owned()),
                stdout_artifact_ref: None,
                stderr_artifact_ref: None,
            }],
        );
        let rendered = lines.join("\n");

        assert!(rendered.contains("raw_output=not_retained"));
        assert!(rendered.contains("sanitized summary"));
        assert!(!rendered.contains("raw_stdout"));
        assert!(!rendered.contains("raw_stderr"));
        assert!(!rendered.contains("recognizable-raw-output"));
    }
}
