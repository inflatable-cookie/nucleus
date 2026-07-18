use serde::{Deserialize, Serialize};

use super::{
    CodexCallbackDiagnosticsDto, CodexCallbackResponseExecutionDiagnosticsDto,
    CodexIngestionDiagnosticsDto, CodexInterruptionDiagnosticsDto,
    CodexInterruptionExecutionDiagnosticsDto, CodexLiveExecutorDiagnosticsDto,
    CodexLiveSpawnSmokeDiagnosticsDto, CodexRecoveryDiagnosticsDto,
    CodexRecoveryExecutionDiagnosticsDto, CodexSubscriptionDiagnosticsDto,
    CodexTaskBackedLiveExecutionDiagnosticsDto, CodexTransportExecutorDiagnosticsDto,
    CodexTurnStartDiagnosticsDto, DurableProviderExecutorDiagnosticsDto,
};

/// Client-safe combined diagnostics for Codex provider runtime surfaces.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodexProviderDiagnosticsDto {
    pub ingestion: CodexIngestionDiagnosticsDto,
    pub live_spawn_smoke: CodexLiveSpawnSmokeDiagnosticsDto,
    pub live_executor: CodexLiveExecutorDiagnosticsDto,
    pub task_backed_live_execution: CodexTaskBackedLiveExecutionDiagnosticsDto,
    pub turn_start: CodexTurnStartDiagnosticsDto,
    pub subscription: CodexSubscriptionDiagnosticsDto,
    pub transport_executor: CodexTransportExecutorDiagnosticsDto,
    pub callback: CodexCallbackDiagnosticsDto,
    pub callback_response_execution: CodexCallbackResponseExecutionDiagnosticsDto,
    pub interruption: CodexInterruptionDiagnosticsDto,
    pub interruption_execution: CodexInterruptionExecutionDiagnosticsDto,
    pub recovery: CodexRecoveryDiagnosticsDto,
    pub recovery_execution: CodexRecoveryExecutionDiagnosticsDto,
    pub durable_provider_executor: DurableProviderExecutorDiagnosticsDto,
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
    task_backed_live_execution: CodexTaskBackedLiveExecutionDiagnosticsDto,
    turn_start: CodexTurnStartDiagnosticsDto,
    subscription: CodexSubscriptionDiagnosticsDto,
    transport_executor: CodexTransportExecutorDiagnosticsDto,
    callback: CodexCallbackDiagnosticsDto,
    callback_response_execution: CodexCallbackResponseExecutionDiagnosticsDto,
    interruption: CodexInterruptionDiagnosticsDto,
    interruption_execution: CodexInterruptionExecutionDiagnosticsDto,
    recovery: CodexRecoveryDiagnosticsDto,
    recovery_execution: CodexRecoveryExecutionDiagnosticsDto,
    durable_provider_executor: DurableProviderExecutorDiagnosticsDto,
) -> CodexProviderDiagnosticsDto {
    let source_status = if [
        &ingestion.source_status,
        &live_spawn_smoke.source_status,
        &live_executor.source_status,
        &task_backed_live_execution.source_status,
        &turn_start.source_status,
        &subscription.source_status,
        &transport_executor.source_status,
        &callback.source_status,
        &callback_response_execution.source_status,
        &interruption.source_status,
        &interruption_execution.source_status,
        &recovery.source_status,
        &recovery_execution.source_status,
        &durable_provider_executor.source_status,
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
        task_backed_live_execution,
        turn_start,
        subscription,
        transport_executor,
        callback,
        callback_response_execution,
        interruption,
        interruption_execution,
        recovery,
        recovery_execution,
        durable_provider_executor,
        client_can_control_provider: false,
        client_can_mutate_tasks: false,
        source_summary: Some("Codex provider diagnostics are read-only and sanitized".to_owned()),
        source_status,
    }
}
