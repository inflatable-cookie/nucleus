use std::path::PathBuf;

use nucleus_local_store::{LocalStoreRecord, SqliteBackend};
use nucleus_projects::ProjectId;
use nucleus_server::{
    AcceptedMemoryActiveApplyDiagnosticsQuery, AcceptedMemoryImportApplyReviewDiagnosticsQuery,
    AcceptedMemoryProjectionDiagnosticsQuery, AcceptedMemoryProjectionImportApplyDiagnosticsQuery,
    AcceptedMemoryProjectionImportDiagnosticsQuery, AcceptedMemoryProjectionWriteDiagnosticsQuery,
    AcceptedMemoryQuery, AcceptedMemoryReviewReadinessQuery,
    AcceptedMemoryReviewReceiptStorageDiagnosticsQuery, ClientId, ControlResponseEnvelopeDto,
    LocalControlRequestHandler, MemoryProposalReviewDiagnosticsQuery, MemoryProposalsQuery,
    PlanningCapturePublicationDiagnosticsQuery, PlanningProjectionFileWriteDiagnosticsQuery,
    PlanningProjectionImportActiveApplyDiagnosticsQuery,
    PlanningProjectionImportApplyDiagnosticsQuery, PlanningProjectionImportDiagnosticsQuery,
    PlanningSessionsQuery, PlanningTaskSeedsQuery, ProductWorkflowSummaryQuery,
    ProjectAuthorityDomain, ProjectAuthorityMapQuery, ProviderLiveReadExecutorQuery,
    ProviderLiveReadSmokeEvidenceQuery, ProviderReadIntentQuery, ProviderReadinessOverviewQuery,
    ResearchRunBriefsQuery, SelectedTaskActionReadinessQuery, SelectedTaskOperatorActionGateQuery,
    ServerControlRequest, ServerControlRequestKind, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQuery, ServerQueryId, ServerQueryKind, ServerStateDomain,
    StateRecordQuery, StateRecordQueryScope, TaskReadinessQuery, TaskSeedPromotionDiagnosticsQuery,
    TaskTimelineQuery, TaskWorkflowDrilldownQuery,
};
use nucleus_tasks::TaskId;

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

fn query_kind(query: &QueryDomain) -> ServerQueryKind {
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
        QueryDomain::TaskTimeline { task_id } => ServerQueryKind::TaskTimeline(TaskTimelineQuery {
            task_id: TaskId(task_id.clone()),
        }),
        QueryDomain::TaskReadiness { project_id } => {
            ServerQueryKind::TaskReadiness(TaskReadinessQuery {
                project_id: ProjectId(project_id.clone()),
            })
        }
        QueryDomain::PlanningTaskSeeds { project_id } => {
            ServerQueryKind::PlanningTaskSeeds(PlanningTaskSeedsQuery {
                project_id: ProjectId(project_id.clone()),
            })
        }
        QueryDomain::PlanningSessions { project_id } => {
            ServerQueryKind::PlanningSessions(PlanningSessionsQuery {
                project_id: ProjectId(project_id.clone()),
            })
        }
        QueryDomain::AcceptedMemory { project_id } => {
            ServerQueryKind::AcceptedMemory(AcceptedMemoryQuery {
                project_id: ProjectId(project_id.clone()),
            })
        }
        QueryDomain::AcceptedMemoryProjection { project_id } => {
            ServerQueryKind::AcceptedMemoryProjectionDiagnostics(
                AcceptedMemoryProjectionDiagnosticsQuery {
                    project_id: ProjectId(project_id.clone()),
                },
            )
        }
        QueryDomain::AcceptedMemoryProjectionWrites { project_id } => {
            ServerQueryKind::AcceptedMemoryProjectionWriteDiagnostics(
                AcceptedMemoryProjectionWriteDiagnosticsQuery {
                    project_id: ProjectId(project_id.clone()),
                },
            )
        }
        QueryDomain::AcceptedMemoryProjectionImport { project_id } => {
            ServerQueryKind::AcceptedMemoryProjectionImportDiagnostics(
                AcceptedMemoryProjectionImportDiagnosticsQuery {
                    project_id: ProjectId(project_id.clone()),
                },
            )
        }
        QueryDomain::AcceptedMemoryProjectionImportApply { project_id } => {
            ServerQueryKind::AcceptedMemoryProjectionImportApplyDiagnostics(
                AcceptedMemoryProjectionImportApplyDiagnosticsQuery {
                    project_id: ProjectId(project_id.clone()),
                },
            )
        }
        QueryDomain::AcceptedMemoryImportApplyReviewDiagnostics { project_id } => {
            ServerQueryKind::AcceptedMemoryImportApplyReviewDiagnostics(
                AcceptedMemoryImportApplyReviewDiagnosticsQuery {
                    project_id: ProjectId(project_id.clone()),
                },
            )
        }
        QueryDomain::AcceptedMemoryReviewReceiptStorageDiagnostics { project_id } => {
            ServerQueryKind::AcceptedMemoryReviewReceiptStorageDiagnostics(
                AcceptedMemoryReviewReceiptStorageDiagnosticsQuery {
                    project_id: ProjectId(project_id.clone()),
                },
            )
        }
        QueryDomain::AcceptedMemoryActiveApplyDiagnostics { project_id } => {
            ServerQueryKind::AcceptedMemoryActiveApplyDiagnostics(
                AcceptedMemoryActiveApplyDiagnosticsQuery {
                    project_id: ProjectId(project_id.clone()),
                },
            )
        }
        QueryDomain::AcceptedMemoryReviewReadiness { project_id } => {
            ServerQueryKind::AcceptedMemoryReviewReadiness(AcceptedMemoryReviewReadinessQuery {
                project_id: ProjectId(project_id.clone()),
            })
        }
        QueryDomain::MemoryProposals { project_id } => {
            ServerQueryKind::MemoryProposals(MemoryProposalsQuery {
                project_id: ProjectId(project_id.clone()),
            })
        }
        QueryDomain::MemoryProposalReviewDiagnostics { project_id } => {
            ServerQueryKind::MemoryProposalReviewDiagnostics(MemoryProposalReviewDiagnosticsQuery {
                project_id: ProjectId(project_id.clone()),
            })
        }
        QueryDomain::ResearchRunBriefs { project_id } => {
            ServerQueryKind::ResearchRunBriefs(ResearchRunBriefsQuery {
                project_id: ProjectId(project_id.clone()),
            })
        }
        QueryDomain::TaskSeedPromotionDiagnostics { project_id } => {
            ServerQueryKind::TaskSeedPromotionDiagnostics(TaskSeedPromotionDiagnosticsQuery {
                project_id: ProjectId(project_id.clone()),
            })
        }
        QueryDomain::PlanningProjectionFileWriteDiagnostics { project_id } => {
            ServerQueryKind::PlanningProjectionFileWriteDiagnostics(
                PlanningProjectionFileWriteDiagnosticsQuery {
                    project_id: ProjectId(project_id.clone()),
                },
            )
        }
        QueryDomain::PlanningProjectionImportDiagnostics { project_id } => {
            ServerQueryKind::PlanningProjectionImportDiagnostics(
                PlanningProjectionImportDiagnosticsQuery {
                    project_id: ProjectId(project_id.clone()),
                },
            )
        }
        QueryDomain::PlanningProjectionImportApplyDiagnostics { project_id } => {
            ServerQueryKind::PlanningProjectionImportApplyDiagnostics(
                PlanningProjectionImportApplyDiagnosticsQuery {
                    project_id: ProjectId(project_id.clone()),
                },
            )
        }
        QueryDomain::PlanningProjectionImportActiveApplyDiagnostics { project_id } => {
            ServerQueryKind::PlanningProjectionImportActiveApplyDiagnostics(
                PlanningProjectionImportActiveApplyDiagnosticsQuery {
                    project_id: ProjectId(project_id.clone()),
                },
            )
        }
        QueryDomain::PlanningCapturePublicationDiagnostics { project_id } => {
            ServerQueryKind::PlanningCapturePublicationDiagnostics(
                PlanningCapturePublicationDiagnosticsQuery {
                    project_id: ProjectId(project_id.clone()),
                },
            )
        }
        QueryDomain::ProductWorkflowSummary { project_id } => {
            ServerQueryKind::ProductWorkflowSummary(ProductWorkflowSummaryQuery {
                project_id: ProjectId(project_id.clone()),
            })
        }
        QueryDomain::TaskWorkflowDrilldown {
            project_id,
            task_id,
        } => ServerQueryKind::TaskWorkflowDrilldown(TaskWorkflowDrilldownQuery {
            project_id: ProjectId(project_id.clone()),
            task_id: TaskId(task_id.clone()),
        }),
        QueryDomain::SelectedTaskActionReadiness {
            project_id,
            task_id,
        } => ServerQueryKind::SelectedTaskActionReadiness(SelectedTaskActionReadinessQuery {
            project_id: ProjectId(project_id.clone()),
            task_id: TaskId(task_id.clone()),
        }),
        QueryDomain::SelectedTaskOperatorActionGate {
            project_id,
            task_id,
        } => ServerQueryKind::SelectedTaskOperatorActionGate(SelectedTaskOperatorActionGateQuery {
            project_id: ProjectId(project_id.clone()),
            task_id: TaskId(task_id.clone()),
        }),
        QueryDomain::ProjectAuthorityMap { project_id } => {
            ServerQueryKind::ProjectAuthorityMap(ProjectAuthorityMapQuery {
                project_id: ProjectId(project_id.clone()),
                expected_domains: default_authority_domains(),
            })
        }
        QueryDomain::Projects
        | QueryDomain::Tasks
        | QueryDomain::Workspaces
        | QueryDomain::CommandEvidence => {
            state_query_kind(query.state_domain().expect("state query domain"))
        }
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

fn default_authority_domains() -> Vec<ProjectAuthorityDomain> {
    vec![
        ProjectAuthorityDomain::Project,
        ProjectAuthorityDomain::Source,
        ProjectAuthorityDomain::Task,
        ProjectAuthorityDomain::Workspace,
        ProjectAuthorityDomain::Session,
        ProjectAuthorityDomain::Execution,
        ProjectAuthorityDomain::ScmForge,
        ProjectAuthorityDomain::Projection,
    ]
}

fn state_query(domain: ServerStateDomain) -> StateRecordQuery {
    StateRecordQuery {
        domain,
        scope: StateRecordQueryScope::List,
    }
}

#[cfg(test)]
mod tests;
