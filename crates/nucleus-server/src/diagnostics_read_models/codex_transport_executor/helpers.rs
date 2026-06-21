use nucleus_engine::EngineRuntimeReceiptStatus;

use crate::{
    CodexAppServerDecodeOutcomePersistenceRecord, CodexAppServerStdioDecodeStatus,
    CodexAppServerTransportExecutorAuthorityStatus,
    CodexAppServerTurnStartStdioExecutionEnvelopeStatus, ProviderSessionRepairState,
};

pub(super) fn session_repair_required(state: &ProviderSessionRepairState) -> bool {
    !matches!(state, ProviderSessionRepairState::Healthy)
}

pub(super) fn decode_outcome_next_action(
    record: &CodexAppServerDecodeOutcomePersistenceRecord,
) -> String {
    match &record.decode_status {
        CodexAppServerStdioDecodeStatus::Decoded { .. } => "inspect_observation_event",
        CodexAppServerStdioDecodeStatus::Malformed { .. } => "inspect_parse_failure",
        CodexAppServerStdioDecodeStatus::Unsupported { .. } => "inspect_unsupported_method",
        CodexAppServerStdioDecodeStatus::RecoveryRequired { .. } => {
            "repair_provider_session_binding"
        }
    }
    .to_owned()
}

pub(super) fn receipt_next_action(status: &EngineRuntimeReceiptStatus) -> String {
    match status {
        EngineRuntimeReceiptStatus::RecoveryRequired => "inspect_recovery_requirement",
        EngineRuntimeReceiptStatus::Failed => "inspect_failed_receipt",
        EngineRuntimeReceiptStatus::Blocked => "inspect_blocked_receipt",
        _ => "inspect_receipt_evidence",
    }
    .to_owned()
}

pub(super) fn authority_status(status: &CodexAppServerTransportExecutorAuthorityStatus) -> String {
    match status {
        CodexAppServerTransportExecutorAuthorityStatus::ReadyForExecutionHandoff => "ready",
        CodexAppServerTransportExecutorAuthorityStatus::Blocked => "blocked",
    }
    .to_owned()
}

pub(super) fn authority_next_action(
    status: &CodexAppServerTransportExecutorAuthorityStatus,
) -> String {
    match status {
        CodexAppServerTransportExecutorAuthorityStatus::ReadyForExecutionHandoff => {
            "prepare_sanitized_execution_envelope"
        }
        CodexAppServerTransportExecutorAuthorityStatus::Blocked => "repair_executor_authority",
    }
    .to_owned()
}

pub(super) fn envelope_status(
    status: &CodexAppServerTurnStartStdioExecutionEnvelopeStatus,
) -> String {
    match status {
        CodexAppServerTurnStartStdioExecutionEnvelopeStatus::ReadyForExecutorHandoff => "ready",
        CodexAppServerTurnStartStdioExecutionEnvelopeStatus::Blocked => "blocked",
    }
    .to_owned()
}

pub(super) fn envelope_next_action(
    status: &CodexAppServerTurnStartStdioExecutionEnvelopeStatus,
) -> String {
    match status {
        CodexAppServerTurnStartStdioExecutionEnvelopeStatus::ReadyForExecutorHandoff => {
            "persist_transport_execution_attempt"
        }
        CodexAppServerTurnStartStdioExecutionEnvelopeStatus::Blocked => {
            "inspect_execution_envelope_blockers"
        }
    }
    .to_owned()
}
