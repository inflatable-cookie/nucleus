use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_server::{
    AcceptedMemoryActiveApplyDiagnosticsQuery, AcceptedMemoryImportApplyReviewDiagnosticsQuery,
    AcceptedMemoryProjectionDiagnosticsQuery, AcceptedMemoryProjectionImportApplyDiagnosticsQuery,
    AcceptedMemoryProjectionImportDiagnosticsQuery, AcceptedMemoryProjectionWriteDiagnosticsQuery,
    AcceptedMemoryQuery, AcceptedMemoryReviewReadinessQuery,
    AcceptedMemoryReviewReceiptStorageDiagnosticsQuery, MemoryProposalReviewDiagnosticsQuery,
    MemoryProposalsQuery, PlanningCapturePublicationDiagnosticsQuery,
    PlanningProjectionFileWriteDiagnosticsQuery,
    PlanningProjectionImportActiveApplyDiagnosticsQuery,
    PlanningProjectionImportApplyDiagnosticsQuery, PlanningProjectionImportDiagnosticsQuery,
    PlanningSessionsQuery, PlanningTaskSeedsQuery, ProductWorkflowSummaryQuery,
    ProjectAuthorityDomain, ProjectAuthorityMapQuery, ProviderLiveReadExecutorQuery,
    ProviderLiveReadSmokeEvidenceQuery, ProviderReadIntentQuery, ProviderReadinessOverviewQuery,
    ResearchRunBriefsQuery, RuntimeMetadataQuery, SelectedTaskActionReadinessQuery,
    SelectedTaskCommandAdmissionQuery, SelectedTaskCompletionRouteApplyQuery,
    SelectedTaskOperatorActionGateQuery, SelectedTaskProductAggregateQuery,
    SelectedTaskReviewDecisionAdmissionQuery, SelectedTaskReviewDecisionApplyQuery,
    SelectedTaskReviewNextQuery, SelectedTaskReviewOutcomeRouteQuery,
    SelectedTaskReworkPreparationQuery, SelectedTaskRouteAdmissionQuery,
    SelectedTaskScmHandoffQuery, ServerQueryKind, ServerStateDomain, StateRecordQuery,
    StateRecordQueryScope, TaskReadinessQuery, TaskSeedPromotionDiagnosticsQuery,
    TaskTimelineQuery, TaskWorkflowDrilldownQuery,
};
use nucleus_tasks::TaskId;

use crate::cli::QueryDomain;

mod selected_task_labels;
use selected_task_labels::{selected_task_action_family, selected_task_review_decision_action};

pub(super) fn query_kind(query: &QueryDomain) -> ServerQueryKind {
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
        QueryDomain::SelectedTaskReviewNext {
            project_id,
            task_id,
        } => ServerQueryKind::SelectedTaskReviewNext(SelectedTaskReviewNextQuery {
            project_id: ProjectId(project_id.clone()),
            task_id: TaskId(task_id.clone()),
        }),
        QueryDomain::SelectedTaskReviewOutcomeRoute {
            project_id,
            task_id,
        } => ServerQueryKind::SelectedTaskReviewOutcomeRoute(SelectedTaskReviewOutcomeRouteQuery {
            project_id: ProjectId(project_id.clone()),
            task_id: TaskId(task_id.clone()),
        }),
        QueryDomain::SelectedTaskRouteAdmission {
            project_id,
            task_id,
            expected_revision,
            operator_ref,
        } => ServerQueryKind::SelectedTaskRouteAdmission(SelectedTaskRouteAdmissionQuery {
            project_id: ProjectId(project_id.clone()),
            task_id: TaskId(task_id.clone()),
            expected_revision: expected_revision
                .as_ref()
                .map(|revision| RevisionId(revision.clone())),
            operator_ref: operator_ref.clone(),
        }),
        QueryDomain::SelectedTaskCompletionRouteApply {
            project_id,
            task_id,
            expected_revision,
            operator_ref,
            route_admission_id,
            review_decision_ref,
            evidence_refs,
        } => ServerQueryKind::SelectedTaskCompletionRouteApply(
            SelectedTaskCompletionRouteApplyQuery {
                project_id: ProjectId(project_id.clone()),
                task_id: TaskId(task_id.clone()),
                expected_revision: expected_revision
                    .as_ref()
                    .map(|revision| RevisionId(revision.clone())),
                operator_ref: operator_ref.clone(),
                route_admission_id: route_admission_id.clone(),
                review_decision_ref: review_decision_ref.clone(),
                evidence_refs: evidence_refs.clone(),
            },
        ),
        QueryDomain::SelectedTaskReworkPreparation {
            project_id,
            task_id,
            operator_ref,
            route_admission_id,
            review_decision_ref,
            reviewed_work_item_refs,
            reviewed_evidence_refs,
            expected_task_revision,
            expected_work_item_revision,
        } => ServerQueryKind::SelectedTaskReworkPreparation(SelectedTaskReworkPreparationQuery {
            project_id: ProjectId(project_id.clone()),
            task_id: TaskId(task_id.clone()),
            operator_ref: operator_ref.clone(),
            route_admission_id: route_admission_id.clone(),
            review_decision_ref: review_decision_ref.clone(),
            reviewed_work_item_refs: reviewed_work_item_refs.clone(),
            reviewed_evidence_refs: reviewed_evidence_refs.clone(),
            expected_task_revision: expected_task_revision
                .as_ref()
                .map(|revision| RevisionId(revision.clone())),
            expected_work_item_revision: expected_work_item_revision
                .as_ref()
                .map(|revision| RevisionId(revision.clone())),
        }),
        QueryDomain::SelectedTaskProductAggregate {
            project_id,
            task_id,
            expected_revision,
            operator_ref,
        } => ServerQueryKind::SelectedTaskProductAggregate(SelectedTaskProductAggregateQuery {
            project_id: ProjectId(project_id.clone()),
            task_id: TaskId(task_id.clone()),
            expected_revision: expected_revision
                .as_ref()
                .map(|revision| RevisionId(revision.clone())),
            operator_ref: operator_ref.clone(),
        }),
        QueryDomain::SelectedTaskScmHandoff {
            project_id,
            task_id,
        } => ServerQueryKind::SelectedTaskScmHandoff(SelectedTaskScmHandoffQuery {
            project_id: ProjectId(project_id.clone()),
            task_id: TaskId(task_id.clone()),
        }),
        QueryDomain::SelectedTaskCommandAdmission {
            project_id,
            task_id,
            family,
            expected_revision,
            reason,
            operator_ref,
        } => ServerQueryKind::SelectedTaskCommandAdmission(SelectedTaskCommandAdmissionQuery {
            project_id: ProjectId(project_id.clone()),
            task_id: TaskId(task_id.clone()),
            family: selected_task_action_family(family),
            expected_revision: expected_revision
                .as_ref()
                .map(|revision| RevisionId(revision.clone())),
            reason: reason.clone(),
            operator_ref: operator_ref.clone(),
        }),
        QueryDomain::SelectedTaskReviewDecisionAdmission(args) => {
            ServerQueryKind::SelectedTaskReviewDecisionAdmission(
                SelectedTaskReviewDecisionAdmissionQuery {
                    project_id: ProjectId(args.project_id.clone()),
                    task_id: TaskId(args.task_id.clone()),
                    action: selected_task_review_decision_action(&args.action),
                    expected_revision: args
                        .expected_revision
                        .as_ref()
                        .map(|revision| RevisionId(revision.clone())),
                    current_revision: args
                        .current_revision
                        .as_ref()
                        .map(|revision| RevisionId(revision.clone())),
                    reason: args.reason.clone(),
                    operator_ref: args.operator_ref.clone(),
                    reviewed_evidence_refs: args.reviewed_evidence_refs.clone(),
                    idempotency_key: args.idempotency_key.clone(),
                },
            )
        }
        QueryDomain::SelectedTaskReviewDecisionApply(args) => {
            ServerQueryKind::SelectedTaskReviewDecisionApply(SelectedTaskReviewDecisionApplyQuery {
                project_id: ProjectId(args.project_id.clone()),
                task_id: TaskId(args.task_id.clone()),
                action: selected_task_review_decision_action(&args.action),
                expected_revision: args
                    .expected_revision
                    .as_ref()
                    .map(|revision| RevisionId(revision.clone())),
                current_revision: args
                    .current_revision
                    .as_ref()
                    .map(|revision| RevisionId(revision.clone())),
                reason: args.reason.clone(),
                operator_ref: args.operator_ref.clone(),
                reviewed_evidence_refs: args.reviewed_evidence_refs.clone(),
                idempotency_key: args.idempotency_key.clone(),
            })
        }
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

pub(super) fn state_query_kind(domain: ServerStateDomain) -> ServerQueryKind {
    match domain {
        ServerStateDomain::Projects => ServerQueryKind::Project(state_query(domain)),
        ServerStateDomain::Tasks => ServerQueryKind::Task(state_query(domain)),
        ServerStateDomain::Workspaces => ServerQueryKind::Workspace(state_query(domain)),
        _ => ServerQueryKind::RuntimeMetadata(RuntimeMetadataQuery::ListCommandEvidence),
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
        ProjectAuthorityDomain::Terminal,
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
