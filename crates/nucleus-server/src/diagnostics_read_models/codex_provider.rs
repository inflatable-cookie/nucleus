use serde::{Deserialize, Serialize};

use super::{
    CodexCallbackDiagnosticsDto, CodexIngestionDiagnosticsDto, CodexInterruptionDiagnosticsDto,
    CodexLiveExecutorDiagnosticsDto, CodexLiveSpawnSmokeDiagnosticsDto,
    CodexRecoveryDiagnosticsDto, CodexSubscriptionDiagnosticsDto,
    CodexTransportExecutorDiagnosticsDto, CodexTurnStartDiagnosticsDto,
};

/// Client-safe combined diagnostics for Codex provider runtime surfaces.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexProviderDiagnosticsDto {
    pub ingestion: CodexIngestionDiagnosticsDto,
    pub live_spawn_smoke: CodexLiveSpawnSmokeDiagnosticsDto,
    pub live_executor: CodexLiveExecutorDiagnosticsDto,
    pub turn_start: CodexTurnStartDiagnosticsDto,
    pub subscription: CodexSubscriptionDiagnosticsDto,
    pub transport_executor: CodexTransportExecutorDiagnosticsDto,
    pub callback: CodexCallbackDiagnosticsDto,
    pub interruption: CodexInterruptionDiagnosticsDto,
    pub recovery: CodexRecoveryDiagnosticsDto,
    pub client_can_control_provider: bool,
    pub client_can_mutate_tasks: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

/// Build a combined Codex diagnostics snapshot from sanitized read models.
pub fn codex_provider_diagnostics(
    ingestion: CodexIngestionDiagnosticsDto,
    live_spawn_smoke: CodexLiveSpawnSmokeDiagnosticsDto,
    live_executor: CodexLiveExecutorDiagnosticsDto,
    turn_start: CodexTurnStartDiagnosticsDto,
    subscription: CodexSubscriptionDiagnosticsDto,
    transport_executor: CodexTransportExecutorDiagnosticsDto,
    callback: CodexCallbackDiagnosticsDto,
    interruption: CodexInterruptionDiagnosticsDto,
    recovery: CodexRecoveryDiagnosticsDto,
) -> CodexProviderDiagnosticsDto {
    let source_status = if [
        &ingestion.source_status,
        &live_spawn_smoke.source_status,
        &live_executor.source_status,
        &turn_start.source_status,
        &subscription.source_status,
        &transport_executor.source_status,
        &callback.source_status,
        &interruption.source_status,
        &recovery.source_status,
    ]
    .iter()
    .all(|status| *status == "empty")
    {
        "empty"
    } else {
        "available"
    }
    .to_owned();

    CodexProviderDiagnosticsDto {
        ingestion,
        live_spawn_smoke,
        live_executor,
        turn_start,
        subscription,
        transport_executor,
        callback,
        interruption,
        recovery,
        client_can_control_provider: false,
        client_can_mutate_tasks: false,
        source_summary: Some("Codex provider diagnostics are read-only and sanitized".to_owned()),
        source_status,
    }
}
