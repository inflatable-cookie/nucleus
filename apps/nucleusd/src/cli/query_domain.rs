use nucleus_server::ServerStateDomain;

mod labels;
mod selected_task_command_admission;
mod selected_task_queries;
mod selected_task_review_decision;
mod state_domain;

use labels::query_domain_label;
use selected_task_command_admission::parse_selected_task_command_admission;
use selected_task_queries::{
    parse_selected_task_action_readiness, parse_selected_task_operator_action_gate,
    parse_selected_task_review_next, parse_selected_task_scm_handoff,
};
use selected_task_review_decision::{
    parse_selected_task_review_decision_admission, parse_selected_task_review_decision_apply,
    SelectedTaskReviewDecisionQueryArgs,
};
use state_domain::query_domain_state_domain;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum QueryDomain {
    Projects,
    Tasks,
    Workspaces,
    CommandEvidence,
    ProviderReadIntent,
    ProviderReadinessOverview,
    ProviderLiveReadExecutor,
    ProviderLiveReadSmokeEvidence,
    TaskTimeline {
        task_id: String,
    },
    TaskReadiness {
        project_id: String,
    },
    PlanningTaskSeeds {
        project_id: String,
    },
    PlanningSessions {
        project_id: String,
    },
    AcceptedMemory {
        project_id: String,
    },
    AcceptedMemoryProjection {
        project_id: String,
    },
    AcceptedMemoryProjectionWrites {
        project_id: String,
    },
    AcceptedMemoryProjectionImport {
        project_id: String,
    },
    AcceptedMemoryProjectionImportApply {
        project_id: String,
    },
    AcceptedMemoryImportApplyReviewDiagnostics {
        project_id: String,
    },
    AcceptedMemoryReviewReceiptStorageDiagnostics {
        project_id: String,
    },
    AcceptedMemoryActiveApplyDiagnostics {
        project_id: String,
    },
    AcceptedMemoryReviewReadiness {
        project_id: String,
    },
    MemoryProposals {
        project_id: String,
    },
    MemoryProposalReviewDiagnostics {
        project_id: String,
    },
    ResearchRunBriefs {
        project_id: String,
    },
    TaskSeedPromotionDiagnostics {
        project_id: String,
    },
    PlanningProjectionFileWriteDiagnostics {
        project_id: String,
    },
    PlanningProjectionImportDiagnostics {
        project_id: String,
    },
    PlanningProjectionImportApplyDiagnostics {
        project_id: String,
    },
    PlanningProjectionImportActiveApplyDiagnostics {
        project_id: String,
    },
    PlanningCapturePublicationDiagnostics {
        project_id: String,
    },
    ProductWorkflowSummary {
        project_id: String,
    },
    TaskWorkflowDrilldown {
        project_id: String,
        task_id: String,
    },
    SelectedTaskActionReadiness {
        project_id: String,
        task_id: String,
    },
    SelectedTaskOperatorActionGate {
        project_id: String,
        task_id: String,
    },
    SelectedTaskReviewNext {
        project_id: String,
        task_id: String,
    },
    SelectedTaskScmHandoff {
        project_id: String,
        task_id: String,
    },
    SelectedTaskCommandAdmission {
        project_id: String,
        task_id: String,
        family: String,
        expected_revision: Option<String>,
        reason: Option<String>,
        operator_ref: String,
    },
    SelectedTaskReviewDecisionAdmission(SelectedTaskReviewDecisionQueryArgs),
    SelectedTaskReviewDecisionApply(SelectedTaskReviewDecisionQueryArgs),
    ProjectAuthorityMap {
        project_id: String,
    },
}

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
            "task-readiness" => {
                expect_flag(iter, "--project")?;
                Ok(Self::TaskReadiness {
                    project_id: iter.next().ok_or_else(|| {
                        "task-readiness requires --project <project-id>".to_owned()
                    })?,
                })
            }
            "planning-task-seeds" => {
                expect_flag(iter, "--project")?;
                Ok(Self::PlanningTaskSeeds {
                    project_id: iter.next().ok_or_else(|| {
                        "planning-task-seeds requires --project <project-id>".to_owned()
                    })?,
                })
            }
            "planning-sessions" => {
                expect_flag(iter, "--project")?;
                Ok(Self::PlanningSessions {
                    project_id: iter.next().ok_or_else(|| {
                        "planning-sessions requires --project <project-id>".to_owned()
                    })?,
                })
            }
            "accepted-memory" => {
                expect_flag(iter, "--project")?;
                Ok(Self::AcceptedMemory {
                    project_id: iter.next().ok_or_else(|| {
                        "accepted-memory requires --project <project-id>".to_owned()
                    })?,
                })
            }
            "accepted-memory-projection" => {
                expect_flag(iter, "--project")?;
                Ok(Self::AcceptedMemoryProjection {
                    project_id: iter.next().ok_or_else(|| {
                        "accepted-memory-projection requires --project <project-id>".to_owned()
                    })?,
                })
            }
            "accepted-memory-projection-writes" => {
                expect_flag(iter, "--project")?;
                Ok(Self::AcceptedMemoryProjectionWrites {
                    project_id: iter.next().ok_or_else(|| {
                        "accepted-memory-projection-writes requires --project <project-id>"
                            .to_owned()
                    })?,
                })
            }
            "accepted-memory-import" | "accepted-memory-projection-import" => {
                expect_flag(iter, "--project")?;
                Ok(Self::AcceptedMemoryProjectionImport {
                    project_id: iter.next().ok_or_else(|| {
                        "accepted-memory-projection-import requires --project <project-id>"
                            .to_owned()
                    })?,
                })
            }
            "accepted-memory-import-apply" | "accepted-memory-projection-import-apply" => {
                expect_flag(iter, "--project")?;
                Ok(Self::AcceptedMemoryProjectionImportApply {
                    project_id: iter.next().ok_or_else(|| {
                        "accepted-memory-projection-import-apply requires --project <project-id>"
                            .to_owned()
                    })?,
                })
            }
            "accepted-memory-import-apply-review-diagnostics" => {
                expect_flag(iter, "--project")?;
                Ok(Self::AcceptedMemoryImportApplyReviewDiagnostics {
                    project_id: iter.next().ok_or_else(|| {
                        "accepted-memory-import-apply-review-diagnostics requires --project <project-id>"
                            .to_owned()
                    })?,
                })
            }
            "accepted-memory-review-receipt-storage-diagnostics" => {
                expect_flag(iter, "--project")?;
                Ok(Self::AcceptedMemoryReviewReceiptStorageDiagnostics {
                    project_id: iter.next().ok_or_else(|| {
                        "accepted-memory-review-receipt-storage-diagnostics requires --project <project-id>"
                            .to_owned()
                    })?,
                })
            }
            "accepted-memory-active-apply-diagnostics" => {
                expect_flag(iter, "--project")?;
                Ok(Self::AcceptedMemoryActiveApplyDiagnostics {
                    project_id: iter.next().ok_or_else(|| {
                        "accepted-memory-active-apply-diagnostics requires --project <project-id>"
                            .to_owned()
                    })?,
                })
            }
            "accepted-memory-review" | "accepted-memory-review-readiness" => {
                expect_flag(iter, "--project")?;
                Ok(Self::AcceptedMemoryReviewReadiness {
                    project_id: iter.next().ok_or_else(|| {
                        "accepted-memory-review-readiness requires --project <project-id>"
                            .to_owned()
                    })?,
                })
            }
            "memory-proposals" => {
                expect_flag(iter, "--project")?;
                Ok(Self::MemoryProposals {
                    project_id: iter.next().ok_or_else(|| {
                        "memory-proposals requires --project <project-id>".to_owned()
                    })?,
                })
            }
            "memory-proposal-review-diagnostics" => {
                expect_flag(iter, "--project")?;
                Ok(Self::MemoryProposalReviewDiagnostics {
                    project_id: iter.next().ok_or_else(|| {
                        "memory-proposal-review-diagnostics requires --project <project-id>"
                            .to_owned()
                    })?,
                })
            }
            "research-run-briefs" => {
                expect_flag(iter, "--project")?;
                Ok(Self::ResearchRunBriefs {
                    project_id: iter.next().ok_or_else(|| {
                        "research-run-briefs requires --project <project-id>".to_owned()
                    })?,
                })
            }
            "task-seed-promotion-diagnostics" => {
                expect_flag(iter, "--project")?;
                Ok(Self::TaskSeedPromotionDiagnostics {
                    project_id: iter.next().ok_or_else(|| {
                        "task-seed-promotion-diagnostics requires --project <project-id>".to_owned()
                    })?,
                })
            }
            "planning-projection-file-write-diagnostics" => {
                expect_flag(iter, "--project")?;
                Ok(Self::PlanningProjectionFileWriteDiagnostics {
                    project_id: iter.next().ok_or_else(|| {
                        "planning-projection-file-write-diagnostics requires --project <project-id>"
                            .to_owned()
                    })?,
                })
            }
            "planning-projection-import-diagnostics" => {
                expect_flag(iter, "--project")?;
                Ok(Self::PlanningProjectionImportDiagnostics {
                    project_id: iter.next().ok_or_else(|| {
                        "planning-projection-import-diagnostics requires --project <project-id>"
                            .to_owned()
                    })?,
                })
            }
            "planning-projection-import-apply-diagnostics" => {
                expect_flag(iter, "--project")?;
                Ok(Self::PlanningProjectionImportApplyDiagnostics {
                    project_id: iter.next().ok_or_else(|| {
                        "planning-projection-import-apply-diagnostics requires --project <project-id>"
                            .to_owned()
                    })?,
                })
            }
            "planning-projection-import-active-apply-diagnostics" => {
                expect_flag(iter, "--project")?;
                Ok(Self::PlanningProjectionImportActiveApplyDiagnostics {
                    project_id: iter.next().ok_or_else(|| {
                        "planning-projection-import-active-apply-diagnostics requires --project <project-id>"
                            .to_owned()
                    })?,
                })
            }
            "planning-capture-publication-diagnostics" => {
                expect_flag(iter, "--project")?;
                Ok(Self::PlanningCapturePublicationDiagnostics {
                    project_id: iter.next().ok_or_else(|| {
                        "planning-capture-publication-diagnostics requires --project <project-id>"
                            .to_owned()
                    })?,
                })
            }
            "product-workflow-summary" => {
                expect_flag(iter, "--project")?;
                Ok(Self::ProductWorkflowSummary {
                    project_id: iter.next().ok_or_else(|| {
                        "product-workflow-summary requires --project <project-id>".to_owned()
                    })?,
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
            "selected-task-scm-handoff" => parse_selected_task_scm_handoff(iter),
            "selected-task-command-admission" => parse_selected_task_command_admission(iter),
            "selected-task-review-decision-admission" => {
                parse_selected_task_review_decision_admission(iter)
            }
            "selected-task-review-decision-apply" => {
                parse_selected_task_review_decision_apply(iter)
            }
            "project-authority-map" => {
                expect_flag(iter, "--project")?;
                Ok(Self::ProjectAuthorityMap {
                    project_id: iter.next().ok_or_else(|| {
                        "project-authority-map requires --project <project-id>".to_owned()
                    })?,
                })
            }
            _ => Err(format!("unsupported query domain: {value}")),
        }
    }

    pub(crate) fn label(&self) -> &'static str {
        query_domain_label(self)
    }

    pub(crate) fn state_domain(&self) -> Option<ServerStateDomain> {
        query_domain_state_domain(self)
    }
}

pub(super) fn expect_flag<I>(iter: &mut I, expected: &str) -> Result<(), String>
where
    I: Iterator<Item = String>,
{
    match iter.next().as_deref() {
        Some(flag) if flag == expected => Ok(()),
        Some(flag) => Err(format!("expected {expected}, got {flag}")),
        None => Err(format!("expected {expected}")),
    }
}
