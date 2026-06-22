use nucleus_server::ServerStateDomain;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum QueryDomain {
    Projects,
    Tasks,
    Workspaces,
    CommandEvidence,
    ProviderReadIntent,
    ProviderReadinessOverview,
    ProviderLiveReadExecutor,
    ProviderLiveReadSmokeEvidence,
}

impl QueryDomain {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "projects" => Ok(Self::Projects),
            "tasks" => Ok(Self::Tasks),
            "workspaces" => Ok(Self::Workspaces),
            "command-evidence" => Ok(Self::CommandEvidence),
            "provider-read-intent" => Ok(Self::ProviderReadIntent),
            "provider-readiness-overview" => Ok(Self::ProviderReadinessOverview),
            "provider-live-read-executor" => Ok(Self::ProviderLiveReadExecutor),
            "provider-live-read-smoke-evidence" => Ok(Self::ProviderLiveReadSmokeEvidence),
            _ => Err(format!("unsupported query domain: {value}")),
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Projects => "projects",
            Self::Tasks => "tasks",
            Self::Workspaces => "workspaces",
            Self::CommandEvidence => "command-evidence",
            Self::ProviderReadIntent => "provider-read-intent",
            Self::ProviderReadinessOverview => "provider-readiness-overview",
            Self::ProviderLiveReadExecutor => "provider-live-read-executor",
            Self::ProviderLiveReadSmokeEvidence => "provider-live-read-smoke-evidence",
        }
    }

    pub(crate) fn state_domain(self) -> Option<ServerStateDomain> {
        match self {
            Self::Projects => Some(ServerStateDomain::Projects),
            Self::Tasks => Some(ServerStateDomain::Tasks),
            Self::Workspaces => Some(ServerStateDomain::Workspaces),
            Self::CommandEvidence => Some(ServerStateDomain::CommandEvidence),
            Self::ProviderReadIntent
            | Self::ProviderReadinessOverview
            | Self::ProviderLiveReadExecutor
            | Self::ProviderLiveReadSmokeEvidence => None,
        }
    }
}
