//! Client-safe diagnostics read models.
//!
//! These DTOs expose steward, Effigy, management sync, and SCM session state to
//! clients without granting command authority or copying raw provider output.

mod codex_callback;
mod codex_callback_response_execution;
mod codex_ingestion;
mod codex_interruption;
mod codex_interruption_execution;
mod codex_live_executor;
mod codex_live_spawn;
mod codex_provider;
mod codex_recovery;
mod codex_recovery_execution;
mod codex_subscription;
mod codex_task_backed_live_execution;
mod codex_transport_executor;
mod codex_turn_start;
mod durable_provider_executor;
mod durable_provider_executor_dispatch;
mod durable_provider_executor_invocation;
mod effigy;
mod helpers;
mod scm;
mod steward;
mod sync;
mod sync_capture;
mod sync_review;
mod task_agent;

pub use codex_callback::{
    codex_callback_diagnostics, CodexCallbackDiagnosticDto, CodexCallbackDiagnosticsDto,
};
pub use codex_callback_response_execution::{
    codex_callback_response_execution_diagnostics,
    CodexCallbackResponseExecutionAttemptDiagnosticDto,
    CodexCallbackResponseExecutionDiagnosticsDto,
};
pub use codex_ingestion::{
    codex_ingestion_diagnostics, CodexIngestionDiagnosticsDto,
    CodexIngestionObservationDiagnosticDto,
};
pub use codex_interruption::{
    codex_interruption_diagnostics, CodexInterruptionDiagnosticDto, CodexInterruptionDiagnosticsDto,
};
pub use codex_interruption_execution::{
    codex_interruption_execution_diagnostics, CodexInterruptionExecutionAttemptDiagnosticDto,
    CodexInterruptionExecutionDiagnosticsDto,
};
pub use codex_live_executor::{
    codex_live_executor_diagnostics, CodexLiveExecutorAttemptDiagnosticDto,
    CodexLiveExecutorDiagnosticsDto,
};
pub use codex_live_spawn::{
    codex_live_spawn_smoke_diagnostics, CodexLiveSpawnSmokeDiagnosticDto,
    CodexLiveSpawnSmokeDiagnosticsDto,
};
pub use codex_provider::{codex_provider_diagnostics, CodexProviderDiagnosticsDto};
pub use codex_recovery::{
    codex_recovery_diagnostics, CodexRecoveryDiagnosticDto, CodexRecoveryDiagnosticsDto,
};
pub use codex_recovery_execution::{
    codex_recovery_execution_diagnostics, CodexRecoveryExecutionAttemptDiagnosticDto,
    CodexRecoveryExecutionDiagnosticsDto,
};
pub use codex_subscription::{
    codex_subscription_diagnostics, CodexStdioWriteDiagnosticDto, CodexSubscriptionDiagnosticDto,
    CodexSubscriptionDiagnosticsDto,
};
pub use codex_task_backed_live_execution::{
    codex_task_backed_live_execution_diagnostics, CodexTaskBackedLiveExecutionAttemptDiagnosticDto,
    CodexTaskBackedLiveExecutionDiagnosticsDto,
};
pub use codex_transport_executor::{
    codex_transport_executor_diagnostics, CodexStdioFrameIngestionDiagnosticDto,
    CodexTransportExecutionDiagnosticDto, CodexTransportExecutorAuthorityDiagnosticDto,
    CodexTransportExecutorDiagnosticsDto, CodexTransportExecutorEnvelopeDiagnosticDto,
};
pub use codex_turn_start::{
    codex_turn_start_diagnostics, CodexTurnStartDiagnosticDto, CodexTurnStartDiagnosticsDto,
};
pub use durable_provider_executor::{
    durable_provider_executor_diagnostics, DurableProviderExecutorCommandDiagnosticDto,
    DurableProviderExecutorDiagnosticsDto, DurableProviderExecutorStatusDiagnosticDto,
};
pub use durable_provider_executor_dispatch::{
    durable_provider_executor_dispatch_diagnostics,
    DurableProviderExecutorDispatchAdmissionDiagnosticDto,
    DurableProviderExecutorDispatchDiagnosticsDto,
    DurableProviderExecutorDispatchOutcomeLinkageDiagnosticDto,
    DurableProviderExecutorDispatchSelectionDiagnosticDto,
};
pub use durable_provider_executor_invocation::{
    durable_provider_executor_invocation_diagnostics, DurableExecutorHandoffDiagnosticDto,
    DurableInvocationPreflightDiagnosticDto, DurableInvocationRequestDiagnosticDto,
    DurableOutcomePersistenceDiagnosticDto, DurableProviderExecutorInvocationDiagnosticsDto,
};
pub use effigy::{effigy_diagnostics, EffigyDiagnosticsDto};
pub use scm::{
    scm_session_diagnostics, ScmCommandAdmissionDiagnosticDto, ScmSessionDiagnosticsDto,
    ScmSessionPlanDiagnosticDto, ScmWorkItemLinkDiagnosticDto,
};
pub use steward::{
    steward_diagnostics, steward_sync_diagnostics, StewardCommandAdmissionDiagnosticDto,
    StewardCommandOutcomeDiagnosticDto, StewardDiagnosticsDto, StewardProposalDiagnosticDto,
    StewardSyncDecisionDiagnosticDto, StewardSyncDiagnosticsDto,
};
pub use sync::{
    sync_diagnostics, SyncAssistanceDiagnosticDto, SyncCapturePrepDiagnosticDto,
    SyncDiagnosticsDto, SyncPlanDiagnosticDto, SyncRepairDiagnosticDto,
};
pub use sync_capture::{
    management_capture_review_model, SyncCaptureAdmissionReviewDto, SyncCapturePrepReviewDto,
    SyncCaptureReviewModelDto,
};
pub use sync_review::{
    management_sync_review_model, SyncAppliedRecordReviewDto, SyncApplyBlockReviewDto,
    SyncConflictReviewDto, SyncReceiptReviewDto, SyncReviewModelDto, SyncStagedRecordReviewDto,
};
pub use task_agent::{
    task_agent_diagnostics, TaskAgentDiagnosticsDto, TaskAgentWorkUnitDiagnosticDto,
    TaskAgentWorkUnitIssueDto,
};

#[cfg(test)]
mod tests;
