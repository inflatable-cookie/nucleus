#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderLiveReadSmokeEvidenceCommand {
    ReplayApproved,
}

impl ProviderLiveReadSmokeEvidenceCommand {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "replay-approved" => Ok(Self::ReplayApproved),
            _ => Err(format!(
                "unsupported provider-live-read-smoke-evidence command: {value}"
            )),
        }
    }
}
