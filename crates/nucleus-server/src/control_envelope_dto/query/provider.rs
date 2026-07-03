use crate::control_api::{
    ProviderLiveReadExecutorQuery, ProviderLiveReadSmokeEvidenceQuery, ProviderReadIntentQuery,
    ProviderReadinessOverviewQuery, ServerQueryKind,
};

use super::ControlApiCodecError;

pub(super) fn provider_read_intent_query_from_action(
    action: &str,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "projection" => Ok(ServerQueryKind::ProviderReadIntent(
            ProviderReadIntentQuery::Projection,
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported provider read-intent query action: {action}"
        ))),
    }
}

pub(super) fn provider_readiness_overview_query_from_action(
    action: &str,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "overview" => Ok(ServerQueryKind::ProviderReadinessOverview(
            ProviderReadinessOverviewQuery::Overview,
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported provider readiness overview query action: {action}"
        ))),
    }
}

pub(super) fn provider_live_read_executor_query_from_action(
    action: &str,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" => Ok(ServerQueryKind::ProviderLiveReadExecutor(
            ProviderLiveReadExecutorQuery::Diagnostics,
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported provider live-read executor query action: {action}"
        ))),
    }
}

pub(super) fn provider_live_read_smoke_evidence_query_from_action(
    action: &str,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" => Ok(ServerQueryKind::ProviderLiveReadSmokeEvidence(
            ProviderLiveReadSmokeEvidenceQuery::Diagnostics,
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported provider live-read smoke evidence query action: {action}"
        ))),
    }
}
