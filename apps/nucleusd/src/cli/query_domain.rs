use nucleus_server::ServerStateDomain;

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
    TaskTimeline { task_id: String },
    TaskReadiness { project_id: String },
    PlanningTaskSeeds { project_id: String },
    PlanningSessions { project_id: String },
    AcceptedMemory { project_id: String },
    AcceptedMemoryProjection { project_id: String },
    AcceptedMemoryProjectionWrites { project_id: String },
    AcceptedMemoryProjectionImport { project_id: String },
    AcceptedMemoryProjectionImportApply { project_id: String },
    AcceptedMemoryImportApplyReviewDiagnostics { project_id: String },
    AcceptedMemoryReviewReceiptStorageDiagnostics { project_id: String },
    AcceptedMemoryActiveApplyDiagnostics { project_id: String },
    AcceptedMemoryReviewReadiness { project_id: String },
    MemoryProposals { project_id: String },
    MemoryProposalReviewDiagnostics { project_id: String },
    ResearchRunBriefs { project_id: String },
    TaskSeedPromotionDiagnostics { project_id: String },
    PlanningProjectionFileWriteDiagnostics { project_id: String },
    PlanningProjectionImportDiagnostics { project_id: String },
    PlanningProjectionImportApplyDiagnostics { project_id: String },
    PlanningProjectionImportActiveApplyDiagnostics { project_id: String },
    PlanningCapturePublicationDiagnostics { project_id: String },
    ProductWorkflowSummary { project_id: String },
    TaskWorkflowDrilldown { project_id: String, task_id: String },
    ProjectAuthorityMap { project_id: String },
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
        match self {
            Self::Projects => "projects",
            Self::Tasks => "tasks",
            Self::Workspaces => "workspaces",
            Self::CommandEvidence => "command-evidence",
            Self::ProviderReadIntent => "provider-read-intent",
            Self::ProviderReadinessOverview => "provider-readiness-overview",
            Self::ProviderLiveReadExecutor => "provider-live-read-executor",
            Self::ProviderLiveReadSmokeEvidence => "provider-live-read-smoke-evidence",
            Self::TaskTimeline { .. } => "task-timeline",
            Self::TaskReadiness { .. } => "task-readiness",
            Self::PlanningTaskSeeds { .. } => "planning-task-seeds",
            Self::PlanningSessions { .. } => "planning-sessions",
            Self::AcceptedMemory { .. } => "accepted-memory",
            Self::AcceptedMemoryProjection { .. } => "accepted-memory-projection",
            Self::AcceptedMemoryProjectionWrites { .. } => "accepted-memory-projection-writes",
            Self::AcceptedMemoryProjectionImport { .. } => "accepted-memory-projection-import",
            Self::AcceptedMemoryProjectionImportApply { .. } => {
                "accepted-memory-projection-import-apply"
            }
            Self::AcceptedMemoryImportApplyReviewDiagnostics { .. } => {
                "accepted-memory-import-apply-review-diagnostics"
            }
            Self::AcceptedMemoryReviewReceiptStorageDiagnostics { .. } => {
                "accepted-memory-review-receipt-storage-diagnostics"
            }
            Self::AcceptedMemoryActiveApplyDiagnostics { .. } => {
                "accepted-memory-active-apply-diagnostics"
            }
            Self::AcceptedMemoryReviewReadiness { .. } => "accepted-memory-review-readiness",
            Self::MemoryProposals { .. } => "memory-proposals",
            Self::MemoryProposalReviewDiagnostics { .. } => "memory-proposal-review-diagnostics",
            Self::ResearchRunBriefs { .. } => "research-run-briefs",
            Self::TaskSeedPromotionDiagnostics { .. } => "task-seed-promotion-diagnostics",
            Self::PlanningProjectionFileWriteDiagnostics { .. } => {
                "planning-projection-file-write-diagnostics"
            }
            Self::PlanningProjectionImportDiagnostics { .. } => {
                "planning-projection-import-diagnostics"
            }
            Self::PlanningProjectionImportApplyDiagnostics { .. } => {
                "planning-projection-import-apply-diagnostics"
            }
            Self::PlanningProjectionImportActiveApplyDiagnostics { .. } => {
                "planning-projection-import-active-apply-diagnostics"
            }
            Self::PlanningCapturePublicationDiagnostics { .. } => {
                "planning-capture-publication-diagnostics"
            }
            Self::ProductWorkflowSummary { .. } => "product-workflow-summary",
            Self::TaskWorkflowDrilldown { .. } => "task-workflow-drilldown",
            Self::ProjectAuthorityMap { .. } => "project-authority-map",
        }
    }

    pub(crate) fn state_domain(&self) -> Option<ServerStateDomain> {
        match self {
            Self::Projects => Some(ServerStateDomain::Projects),
            Self::Tasks => Some(ServerStateDomain::Tasks),
            Self::Workspaces => Some(ServerStateDomain::Workspaces),
            Self::CommandEvidence => Some(ServerStateDomain::CommandEvidence),
            Self::ProviderReadIntent
            | Self::ProviderReadinessOverview
            | Self::ProviderLiveReadExecutor
            | Self::ProviderLiveReadSmokeEvidence
            | Self::TaskTimeline { .. }
            | Self::TaskReadiness { .. }
            | Self::PlanningTaskSeeds { .. }
            | Self::PlanningSessions { .. }
            | Self::AcceptedMemory { .. }
            | Self::AcceptedMemoryProjection { .. }
            | Self::AcceptedMemoryProjectionWrites { .. }
            | Self::AcceptedMemoryProjectionImport { .. }
            | Self::AcceptedMemoryProjectionImportApply { .. }
            | Self::AcceptedMemoryImportApplyReviewDiagnostics { .. }
            | Self::AcceptedMemoryReviewReceiptStorageDiagnostics { .. }
            | Self::AcceptedMemoryActiveApplyDiagnostics { .. }
            | Self::AcceptedMemoryReviewReadiness { .. }
            | Self::MemoryProposals { .. }
            | Self::MemoryProposalReviewDiagnostics { .. }
            | Self::ResearchRunBriefs { .. }
            | Self::TaskSeedPromotionDiagnostics { .. }
            | Self::PlanningProjectionFileWriteDiagnostics { .. }
            | Self::PlanningProjectionImportDiagnostics { .. }
            | Self::PlanningProjectionImportApplyDiagnostics { .. }
            | Self::PlanningProjectionImportActiveApplyDiagnostics { .. }
            | Self::PlanningCapturePublicationDiagnostics { .. }
            | Self::ProductWorkflowSummary { .. }
            | Self::TaskWorkflowDrilldown { .. }
            | Self::ProjectAuthorityMap { .. } => None,
        }
    }
}

fn expect_flag<I>(iter: &mut I, expected: &str) -> Result<(), String>
where
    I: Iterator<Item = String>,
{
    match iter.next().as_deref() {
        Some(flag) if flag == expected => Ok(()),
        Some(flag) => Err(format!("expected {expected}, got {flag}")),
        None => Err(format!("expected {expected}")),
    }
}
