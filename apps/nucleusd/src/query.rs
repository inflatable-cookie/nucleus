use std::path::PathBuf;

use nucleus_local_store::{LocalStoreRecord, SqliteBackend};
use nucleus_server::{
    ClientId, ControlResponseEnvelopeDto, LocalControlRequestHandler,
    ProviderLiveReadExecutorQuery, ProviderLiveReadSmokeEvidenceQuery, ProviderReadIntentQuery,
    ProviderReadinessOverviewQuery, ServerControlRequest, ServerControlRequestKind,
    ServerControlResponseBody, ServerControlResponseStatus, ServerQuery, ServerQueryId,
    ServerQueryKind, ServerStateDomain, StateRecordQuery, StateRecordQueryScope,
};

use crate::cli::QueryDomain;

mod typed_response;

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
    let label = query.label();
    let response = handler.handle(ServerControlRequest {
        id: nucleus_server::ServerControlRequestId(format!("request:nucleusd:query:{label}")),
        client_id: ClientId("client:nucleusd".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId(format!("query:nucleusd:{label}")),
            client_id: ClientId("client:nucleusd".to_owned()),
            kind: query_kind(query),
        }),
    });

    if matches!(
        query,
        QueryDomain::CommandEvidence
            | QueryDomain::ProviderReadIntent
            | QueryDomain::ProviderReadinessOverview
            | QueryDomain::ProviderLiveReadExecutor
            | QueryDomain::ProviderLiveReadSmokeEvidence
    ) {
        let dto = ControlResponseEnvelopeDto::try_from(&response)
            .map_err(|error| format!("{label} query response encoding failed: {}", error.reason))?;
        return typed_response::print_typed_dto_response(label, dto);
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
            kind: state_query_kind(domain),
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

fn query_kind(query: QueryDomain) -> ServerQueryKind {
    match query {
        QueryDomain::ProviderReadIntent => {
            ServerQueryKind::ProviderReadIntent(ProviderReadIntentQuery::Projection)
        }
        QueryDomain::ProviderReadinessOverview => {
            ServerQueryKind::ProviderReadinessOverview(ProviderReadinessOverviewQuery::Overview)
        }
        QueryDomain::ProviderLiveReadExecutor => {
            ServerQueryKind::ProviderLiveReadExecutor(ProviderLiveReadExecutorQuery::Diagnostics)
        }
        QueryDomain::ProviderLiveReadSmokeEvidence => {
            ServerQueryKind::ProviderLiveReadSmokeEvidence(
                ProviderLiveReadSmokeEvidenceQuery::Diagnostics,
            )
        }
        _ => state_query_kind(query.state_domain().expect("state query domain")),
    }
}

fn state_query_kind(domain: ServerStateDomain) -> ServerQueryKind {
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
    use nucleus_server::{
        ControlCommandEvidenceRecordDto, ControlProviderLiveReadExecutorDiagnosticsDto,
        ControlProviderLiveReadSmokeEvidenceDiagnosticsDto, ControlProviderReadIntentProjectionDto,
        ControlProviderReadIntentQueryResultDto, ControlProviderReadIntentSourceCountsDto,
        ControlProviderReadinessOverviewDto, LocalControlRequestHandler,
    };

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
        let lines = typed_response::command_evidence_response_lines(
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

    #[test]
    fn provider_read_intent_response_lines_do_not_include_provider_effects() {
        let lines = typed_response::provider_read_intent_response_lines(
            "provider-read-intent",
            ControlProviderReadIntentQueryResultDto {
                query_id: "forge-read-intent-query".to_owned(),
                projection: ControlProviderReadIntentProjectionDto {
                    projection_id: "forge-read-intent-projection".to_owned(),
                    total_count: 0,
                    credential_status_count: 0,
                    repository_metadata_count: 0,
                    pull_request_count: 0,
                    status_check_count: 0,
                    ready_count: 0,
                    duplicate_noop_count: 0,
                    blocked_count: 0,
                    repair_required_count: 0,
                    blocker_count: 0,
                    evidence_ref_count: 0,
                    entries: Vec::new(),
                    credential_resolution_performed: false,
                    provider_network_call_performed: false,
                    provider_effect_executed: false,
                    callback_effect_executed: false,
                    interruption_effect_executed: false,
                    recovery_effect_executed: false,
                    task_mutation_executed: false,
                    raw_provider_payload_retained: false,
                },
                source_counts: ControlProviderReadIntentSourceCountsDto {
                    credential_status_records: 0,
                    repository_metadata_records: 0,
                    pull_request_records: 0,
                    status_check_records: 0,
                },
                credential_resolution_performed: false,
                provider_network_call_performed: false,
                provider_effect_executed: false,
                callback_effect_executed: false,
                interruption_effect_executed: false,
                recovery_effect_executed: false,
                task_mutation_executed: false,
                raw_provider_payload_retained: false,
            },
        );
        let rendered = lines.join("\n");

        assert!(rendered.contains("domain=provider-read-intent"));
        assert!(rendered.contains("records=0"));
        assert!(rendered.contains("provider_network_call_performed=false"));
        assert!(rendered.contains("raw_provider_payload_retained=false"));
        assert!(!rendered.contains("access_token"));
        assert!(!rendered.contains("authorization"));
        assert!(!rendered.contains("raw_response_body"));
    }

    #[test]
    fn provider_readiness_overview_response_lines_do_not_include_provider_effects() {
        let lines = typed_response::provider_readiness_overview_response_lines(
            "provider-readiness-overview",
            ControlProviderReadinessOverviewDto {
                overview_id: "forge-readiness-overview".to_owned(),
                projection_id: "forge-read-intent-projection".to_owned(),
                project_ref: None,
                repo_ref: None,
                authority_host_ref: Some("host:local".to_owned()),
                provider_instance_refs: Vec::new(),
                remote_repo_refs: Vec::new(),
                forge_providers: Vec::new(),
                status: "unknown".to_owned(),
                supported_read_families: vec![
                    "credential_status".to_owned(),
                    "repository_metadata".to_owned(),
                    "pull_request".to_owned(),
                ],
                represented_read_families: Vec::new(),
                represented_mutating_families: Vec::new(),
                total_read_intent_count: 0,
                missing_evidence_family_count: 3,
                ready_count: 0,
                blocked_count: 0,
                repair_required_count: 0,
                duplicate_noop_count: 0,
                blocker_count: 3,
                evidence_ref_count: 0,
                approved_live_read_smoke_evidence_count: 0,
                credential_resolution_performed: false,
                provider_network_call_performed: false,
                provider_effect_executed: false,
                callback_effect_executed: false,
                interruption_effect_executed: false,
                recovery_effect_executed: false,
                task_mutation_executed: false,
                raw_provider_payload_retained: false,
            },
        );
        let rendered = lines.join("\n");

        assert!(rendered.contains("domain=provider-readiness-overview"));
        assert!(rendered.contains("status=unknown"));
        assert!(rendered.contains("records=0"));
        assert!(rendered.contains("missing_evidence_families=3"));
        assert!(rendered.contains("approved_smoke_evidence=0"));
        assert!(rendered.contains("provider_network_call_performed=false"));
        assert!(rendered.contains("raw_provider_payload_retained=false"));
        assert!(!rendered.contains("access_token"));
        assert!(!rendered.contains("authorization"));
        assert!(!rendered.contains("raw_response_body"));
    }

    #[test]
    fn provider_live_read_executor_response_lines_do_not_include_provider_effects() {
        let lines = typed_response::provider_live_read_executor_response_lines(
            "provider-live-read-executor",
            ControlProviderLiveReadExecutorDiagnosticsDto {
                diagnostics_id: "provider-live-read-server-executor-diagnostics".to_owned(),
                request_count: 0,
                ready_request_count: 0,
                blocked_request_count: 0,
                descriptor_ready_count: 0,
                sanitized_output_count: 0,
                parse_error_count: 0,
                receipt_count: 0,
                provider_network_read_performed_count: 0,
                blocker_count: 0,
                provider_write_executed: false,
                callback_effect_executed: false,
                interruption_effect_executed: false,
                recovery_effect_executed: false,
                task_mutation_executed: false,
                raw_provider_payload_retained: false,
            },
        );
        let rendered = lines.join("\n");

        assert!(rendered.contains("domain=provider-live-read-executor"));
        assert!(rendered.contains("records=0"));
        assert!(rendered.contains("provider_network_reads=0"));
        assert!(rendered.contains("provider_write_executed=false"));
        assert!(rendered.contains("raw_provider_payload_retained=false"));
        assert!(!rendered.contains("access_token"));
        assert!(!rendered.contains("authorization"));
        assert!(!rendered.contains("raw_response_body"));
    }

    #[test]
    fn provider_live_read_smoke_evidence_response_lines_do_not_include_provider_effects() {
        let lines = typed_response::provider_live_read_smoke_evidence_response_lines(
            "provider-live-read-smoke-evidence",
            ControlProviderLiveReadSmokeEvidenceDiagnosticsDto {
                diagnostics_id: "provider-live-read-approved-smoke-evidence-diagnostics".to_owned(),
                evidence_count: 1,
                promoted_count: 1,
                repair_required_count: 0,
                blocked_count: 0,
                duplicate_count: 0,
                provider_network_read_performed_count: 1,
                blocker_count: 0,
                provider_write_executed: false,
                callback_effect_executed: false,
                interruption_effect_executed: false,
                recovery_effect_executed: false,
                task_mutation_executed: false,
                raw_provider_payload_retained: false,
            },
        );
        let rendered = lines.join("\n");

        assert!(rendered.contains("domain=provider-live-read-smoke-evidence"));
        assert!(rendered.contains("records=1"));
        assert!(rendered.contains("promoted=1"));
        assert!(rendered.contains("provider_network_reads=1"));
        assert!(rendered.contains("provider_write_executed=false"));
        assert!(rendered.contains("raw_provider_payload_retained=false"));
        assert!(!rendered.contains("access_token"));
        assert!(!rendered.contains("authorization"));
        assert!(!rendered.contains("raw_response_body"));
    }
}
