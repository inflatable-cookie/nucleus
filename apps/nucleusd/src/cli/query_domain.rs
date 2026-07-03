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
    TaskSeedPromotionDiagnostics { project_id: String },
    PlanningProjectionFileWriteDiagnostics { project_id: String },
    PlanningProjectionImportDiagnostics { project_id: String },
    PlanningCapturePublicationDiagnostics { project_id: String },
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
            "planning-capture-publication-diagnostics" => {
                expect_flag(iter, "--project")?;
                Ok(Self::PlanningCapturePublicationDiagnostics {
                    project_id: iter.next().ok_or_else(|| {
                        "planning-capture-publication-diagnostics requires --project <project-id>"
                            .to_owned()
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
            Self::TaskSeedPromotionDiagnostics { .. } => "task-seed-promotion-diagnostics",
            Self::PlanningProjectionFileWriteDiagnostics { .. } => {
                "planning-projection-file-write-diagnostics"
            }
            Self::PlanningProjectionImportDiagnostics { .. } => {
                "planning-projection-import-diagnostics"
            }
            Self::PlanningCapturePublicationDiagnostics { .. } => {
                "planning-capture-publication-diagnostics"
            }
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
            | Self::TaskSeedPromotionDiagnostics { .. }
            | Self::PlanningProjectionFileWriteDiagnostics { .. }
            | Self::PlanningProjectionImportDiagnostics { .. }
            | Self::PlanningCapturePublicationDiagnostics { .. }
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
