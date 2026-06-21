use nucleus_engine::{EngineRuntimeReceiptRecord, EngineRuntimeReceiptStatus};

use super::helpers::session_repair_required;
use super::types::{
    CodexDecodeOutcomeDiagnosticDto, CodexStdioFrameIngestionDiagnosticDto,
    CodexTransportExecutionDiagnosticDto, CodexTransportExecutorAuthorityDiagnosticDto,
    CodexTransportExecutorDiagnosticsDto, CodexTransportExecutorEnvelopeDiagnosticDto,
    CodexTransportReceiptDiagnosticDto, CodexTransportSessionDiagnosticDto,
};
use crate::{
    CodexAppServerDecodeOutcomePersistenceRecord,
    CodexAppServerStdioFrameIngestionPersistenceRecord,
    CodexAppServerTransportExecutorAuthorityRecord,
    CodexAppServerTurnStartStdioExecutionEnvelopeRecord,
    CodexAppServerTurnStartTransportExecutionPersistenceRecord, ProviderSessionBindingRecord,
};

use super::super::helpers::{source_status, source_summary};

pub fn codex_transport_executor_diagnostics(
    sessions: &[ProviderSessionBindingRecord],
    authorities: &[CodexAppServerTransportExecutorAuthorityRecord],
    envelopes: &[CodexAppServerTurnStartStdioExecutionEnvelopeRecord],
    executions: &[CodexAppServerTurnStartTransportExecutionPersistenceRecord],
    frames: &[CodexAppServerStdioFrameIngestionPersistenceRecord],
    decode_outcomes: &[CodexAppServerDecodeOutcomePersistenceRecord],
    transport_receipts: &[EngineRuntimeReceiptRecord],
) -> CodexTransportExecutorDiagnosticsDto {
    let count = sessions.len()
        + authorities.len()
        + envelopes.len()
        + executions.len()
        + frames.len()
        + decode_outcomes.len()
        + transport_receipts.len();
    let repair_required_count = sessions
        .iter()
        .filter(|record| session_repair_required(&record.repair_state))
        .count()
        + transport_receipts
            .iter()
            .filter(|record| record.status == EngineRuntimeReceiptStatus::RecoveryRequired)
            .count();

    CodexTransportExecutorDiagnosticsDto {
        sessions: sessions
            .iter()
            .map(CodexTransportSessionDiagnosticDto::from)
            .collect(),
        authorities: authorities
            .iter()
            .map(CodexTransportExecutorAuthorityDiagnosticDto::from)
            .collect(),
        envelopes: envelopes
            .iter()
            .map(CodexTransportExecutorEnvelopeDiagnosticDto::from)
            .collect(),
        executions: executions
            .iter()
            .map(CodexTransportExecutionDiagnosticDto::from)
            .collect(),
        frames: frames
            .iter()
            .map(CodexStdioFrameIngestionDiagnosticDto::from)
            .collect(),
        decode_outcomes: decode_outcomes
            .iter()
            .map(CodexDecodeOutcomeDiagnosticDto::from)
            .collect(),
        transport_receipts: transport_receipts
            .iter()
            .map(CodexTransportReceiptDiagnosticDto::from)
            .collect(),
        session_count: sessions.len(),
        frame_count: frames.len(),
        decode_outcome_count: decode_outcomes.len(),
        receipt_count: transport_receipts.len(),
        repair_required_count,
        client_can_execute_provider_write: false,
        client_can_answer_callbacks: false,
        client_can_cancel_provider: false,
        client_can_mutate_tasks: false,
        provider_material_exposed: false,
        raw_streams_exposed: false,
        source_status: source_status(count),
        source_summary: Some(source_summary(
            count,
            "Codex transport executor diagnostics have no records yet",
            "Codex transport executor diagnostics loaded from sanitized records",
        )),
    }
}
