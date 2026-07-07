use std::path::PathBuf;

use nucleus_local_store::{LocalStoreRecord, SqliteBackend};
use nucleus_server::{
    ClientId, ControlResponseEnvelopeDto, LocalControlRequestHandler, ServerControlRequest,
    ServerControlRequestKind, ServerControlResponseBody, ServerControlResponseStatus, ServerQuery,
    ServerQueryId, ServerStateDomain,
};

use crate::cli::QueryDomain;

mod kind;
mod typed_response;

use kind::{query_kind, state_query_kind};

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
            kind: query_kind(&query),
        }),
    });

    if matches!(
        query,
        QueryDomain::CommandEvidence
            | QueryDomain::ProviderReadIntent
            | QueryDomain::ProviderReadinessOverview
            | QueryDomain::ProviderLiveReadExecutor
            | QueryDomain::ProviderLiveReadSmokeEvidence
            | QueryDomain::TaskTimeline { .. }
            | QueryDomain::TaskReadiness { .. }
            | QueryDomain::PlanningTaskSeeds { .. }
            | QueryDomain::PlanningSessions { .. }
            | QueryDomain::AcceptedMemory { .. }
            | QueryDomain::AcceptedMemoryProjection { .. }
            | QueryDomain::AcceptedMemoryProjectionWrites { .. }
            | QueryDomain::AcceptedMemoryProjectionImport { .. }
            | QueryDomain::AcceptedMemoryProjectionImportApply { .. }
            | QueryDomain::AcceptedMemoryImportApplyReviewDiagnostics { .. }
            | QueryDomain::AcceptedMemoryReviewReceiptStorageDiagnostics { .. }
            | QueryDomain::AcceptedMemoryActiveApplyDiagnostics { .. }
            | QueryDomain::AcceptedMemoryReviewReadiness { .. }
            | QueryDomain::MemoryProposals { .. }
            | QueryDomain::MemoryProposalReviewDiagnostics { .. }
            | QueryDomain::ResearchRunBriefs { .. }
            | QueryDomain::TaskSeedPromotionDiagnostics { .. }
            | QueryDomain::PlanningProjectionFileWriteDiagnostics { .. }
            | QueryDomain::PlanningProjectionImportDiagnostics { .. }
            | QueryDomain::PlanningProjectionImportApplyDiagnostics { .. }
            | QueryDomain::PlanningProjectionImportActiveApplyDiagnostics { .. }
            | QueryDomain::PlanningCapturePublicationDiagnostics { .. }
            | QueryDomain::ProductWorkflowSummary { .. }
            | QueryDomain::TaskWorkflowDrilldown { .. }
            | QueryDomain::SelectedTaskActionReadiness { .. }
            | QueryDomain::SelectedTaskOperatorActionGate { .. }
            | QueryDomain::SelectedTaskReviewNext { .. }
            | QueryDomain::SelectedTaskReviewOutcomeRoute { .. }
            | QueryDomain::SelectedTaskScmHandoff { .. }
            | QueryDomain::SelectedTaskCommandAdmission { .. }
            | QueryDomain::SelectedTaskReviewDecisionAdmission(_)
            | QueryDomain::SelectedTaskReviewDecisionApply(_)
            | QueryDomain::ProjectAuthorityMap { .. }
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

#[cfg(test)]
mod tests;
