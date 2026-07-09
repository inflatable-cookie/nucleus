use super::selected_task_command_admission::parse_selected_task_command_admission;
use super::selected_task_queries::{
    parse_selected_task_action_readiness, parse_selected_task_completion_route_apply,
    parse_selected_task_operator_action_gate, parse_selected_task_product_aggregate,
    parse_selected_task_review_next, parse_selected_task_review_outcome_route,
    parse_selected_task_rework_preparation, parse_selected_task_route_admission,
    parse_selected_task_scm_handoff,
};
use super::selected_task_review_decision::{
    parse_selected_task_review_decision_admission, parse_selected_task_review_decision_apply,
};
use super::{expect_flag, QueryDomain};

impl QueryDomain {
    pub(crate) fn parse_from_iter<I>(value: &str, iter: &mut I) -> Result<Self, String>
    where
        I: Iterator<Item = String>,
    {
        match value {
            "projects" => Ok(Self::Projects),
            "tasks" => Ok(Self::Tasks),
            "workspaces" => Ok(Self::Workspaces),
            "command-evidence" => Ok(Self::CommandEvidence),
            "provider-read-intent" => Ok(Self::ProviderReadIntent),
            "provider-readiness-overview" => Ok(Self::ProviderReadinessOverview),
            "provider-live-read-executor" => Ok(Self::ProviderLiveReadExecutor),
            "provider-live-read-smoke-evidence" => Ok(Self::ProviderLiveReadSmokeEvidence),
            "task-timeline" => {
                expect_flag(iter, "--task")?;
                Ok(Self::TaskTimeline {
                    task_id: iter
                        .next()
                        .ok_or_else(|| "task-timeline requires --task <task-id>".to_owned())?,
                })
            }
            "task-readiness" => project_query(iter, "task-readiness", |project_id| {
                Self::TaskReadiness { project_id }
            }),
            "planning-task-seeds" => project_query(iter, "planning-task-seeds", |project_id| {
                Self::PlanningTaskSeeds { project_id }
            }),
            "planning-sessions" => project_query(iter, "planning-sessions", |project_id| {
                Self::PlanningSessions { project_id }
            }),
            "accepted-memory" => project_query(iter, "accepted-memory", |project_id| {
                Self::AcceptedMemory { project_id }
            }),
            "accepted-memory-projection" => {
                project_query(iter, "accepted-memory-projection", |project_id| {
                    Self::AcceptedMemoryProjection { project_id }
                })
            }
            "accepted-memory-projection-writes" => {
                project_query(iter, "accepted-memory-projection-writes", |project_id| {
                    Self::AcceptedMemoryProjectionWrites { project_id }
                })
            }
            "accepted-memory-import" | "accepted-memory-projection-import" => {
                project_query(iter, "accepted-memory-projection-import", |project_id| {
                    Self::AcceptedMemoryProjectionImport { project_id }
                })
            }
            "accepted-memory-import-apply" | "accepted-memory-projection-import-apply" => {
                project_query(
                    iter,
                    "accepted-memory-projection-import-apply",
                    |project_id| Self::AcceptedMemoryProjectionImportApply { project_id },
                )
            }
            "accepted-memory-import-apply-review-diagnostics" => project_query(
                iter,
                "accepted-memory-import-apply-review-diagnostics",
                |project_id| Self::AcceptedMemoryImportApplyReviewDiagnostics { project_id },
            ),
            "accepted-memory-review-receipt-storage-diagnostics" => project_query(
                iter,
                "accepted-memory-review-receipt-storage-diagnostics",
                |project_id| Self::AcceptedMemoryReviewReceiptStorageDiagnostics { project_id },
            ),
            "accepted-memory-active-apply-diagnostics" => project_query(
                iter,
                "accepted-memory-active-apply-diagnostics",
                |project_id| Self::AcceptedMemoryActiveApplyDiagnostics { project_id },
            ),
            "accepted-memory-review" | "accepted-memory-review-readiness" => {
                project_query(iter, "accepted-memory-review-readiness", |project_id| {
                    Self::AcceptedMemoryReviewReadiness { project_id }
                })
            }
            "memory-proposals" => project_query(iter, "memory-proposals", |project_id| {
                Self::MemoryProposals { project_id }
            }),
            "memory-proposal-review-diagnostics" => {
                project_query(iter, "memory-proposal-review-diagnostics", |project_id| {
                    Self::MemoryProposalReviewDiagnostics { project_id }
                })
            }
            "research-run-briefs" => project_query(iter, "research-run-briefs", |project_id| {
                Self::ResearchRunBriefs { project_id }
            }),
            "task-seed-promotion-diagnostics" => {
                project_query(iter, "task-seed-promotion-diagnostics", |project_id| {
                    Self::TaskSeedPromotionDiagnostics { project_id }
                })
            }
            "planning-projection-file-write-diagnostics" => project_query(
                iter,
                "planning-projection-file-write-diagnostics",
                |project_id| Self::PlanningProjectionFileWriteDiagnostics { project_id },
            ),
            "planning-projection-import-diagnostics" => project_query(
                iter,
                "planning-projection-import-diagnostics",
                |project_id| Self::PlanningProjectionImportDiagnostics { project_id },
            ),
            "planning-projection-import-apply-diagnostics" => project_query(
                iter,
                "planning-projection-import-apply-diagnostics",
                |project_id| Self::PlanningProjectionImportApplyDiagnostics { project_id },
            ),
            "planning-projection-import-active-apply-diagnostics" => project_query(
                iter,
                "planning-projection-import-active-apply-diagnostics",
                |project_id| Self::PlanningProjectionImportActiveApplyDiagnostics { project_id },
            ),
            "planning-capture-publication-diagnostics" => project_query(
                iter,
                "planning-capture-publication-diagnostics",
                |project_id| Self::PlanningCapturePublicationDiagnostics { project_id },
            ),
            "product-workflow-summary" => {
                project_query(iter, "product-workflow-summary", |project_id| {
                    Self::ProductWorkflowSummary { project_id }
                })
            }
            "task-workflow-drilldown" => {
                expect_flag(iter, "--project")?;
                let project_id = iter.next().ok_or_else(|| {
                    "task-workflow-drilldown requires --project <project-id>".to_owned()
                })?;
                expect_flag(iter, "--task")?;
                Ok(Self::TaskWorkflowDrilldown {
                    project_id,
                    task_id: iter.next().ok_or_else(|| {
                        "task-workflow-drilldown requires --task <task-id>".to_owned()
                    })?,
                })
            }
            "selected-task-action-readiness" => parse_selected_task_action_readiness(iter),
            "selected-task-operator-action-gate" => parse_selected_task_operator_action_gate(iter),
            "selected-task-review-next" => parse_selected_task_review_next(iter),
            "selected-task-review-outcome-route" => parse_selected_task_review_outcome_route(iter),
            "selected-task-route-admission" => parse_selected_task_route_admission(iter),
            "selected-task-completion-route-apply" => {
                parse_selected_task_completion_route_apply(iter)
            }
            "selected-task-rework-preparation" => parse_selected_task_rework_preparation(iter),
            "selected-task-product-aggregate" => parse_selected_task_product_aggregate(iter),
            "selected-task-scm-handoff" => parse_selected_task_scm_handoff(iter),
            "selected-task-command-admission" => parse_selected_task_command_admission(iter),
            "selected-task-review-decision-admission" => {
                parse_selected_task_review_decision_admission(iter)
            }
            "selected-task-review-decision-apply" => {
                parse_selected_task_review_decision_apply(iter)
            }
            "project-authority-map" => project_query(iter, "project-authority-map", |project_id| {
                Self::ProjectAuthorityMap { project_id }
            }),
            _ => Err(format!("unsupported query domain: {value}")),
        }
    }
}

fn project_query<I, F>(iter: &mut I, label: &str, build: F) -> Result<QueryDomain, String>
where
    I: Iterator<Item = String>,
    F: FnOnce(String) -> QueryDomain,
{
    expect_flag(iter, "--project")?;
    Ok(build(iter.next().ok_or_else(|| {
        format!("{label} requires --project <project-id>")
    })?))
}
