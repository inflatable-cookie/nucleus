//! Codex send/subscription receipt mappings.
//!
//! These mappings summarize write/subscription state. They do not retain raw
//! streams, raw provider payloads, or callback payloads.

use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};

use super::turn_start_subscription::{
    CodexAppServerStdioWriteState, CodexAppServerStdioWriteStateRecord,
    CodexAppServerSubscriptionState, CodexAppServerSubscriptionStateRecord,
};

/// Convert stdio write state into a sanitized runtime receipt.
pub fn codex_receipt_from_stdio_write_state(
    record: &CodexAppServerStdioWriteStateRecord,
) -> EngineRuntimeReceiptRecord {
    EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:{}:stdio-write",
            record.write_id.0
        )),
        family: EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status: write_status(&record.state),
        command_ref: None,
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(record.command_id.clone())),
        evidence_refs: record
            .evidence_refs
            .iter()
            .map(|value| EngineRuntimeReceiptRef::Custom(value.clone()))
            .collect(),
        artifact_refs: Vec::new(),
        summary: Some(write_summary(record)),
    }
}

/// Convert subscription state into a sanitized runtime receipt.
pub fn codex_receipt_from_subscription_state(
    record: &CodexAppServerSubscriptionStateRecord,
) -> EngineRuntimeReceiptRecord {
    EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:{}:subscription",
            record.subscription_id.0
        )),
        family: EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status: subscription_status(&record.state),
        command_ref: None,
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(record.command_id.clone())),
        evidence_refs: record
            .evidence_refs
            .iter()
            .map(|value| EngineRuntimeReceiptRef::Custom(value.clone()))
            .collect(),
        artifact_refs: Vec::new(),
        summary: Some(subscription_summary(record)),
    }
}

fn write_status(state: &CodexAppServerStdioWriteState) -> EngineRuntimeReceiptStatus {
    match state {
        CodexAppServerStdioWriteState::Queued => EngineRuntimeReceiptStatus::Queued,
        CodexAppServerStdioWriteState::Written => EngineRuntimeReceiptStatus::Completed,
        CodexAppServerStdioWriteState::Blocked(_) => EngineRuntimeReceiptStatus::Blocked,
        CodexAppServerStdioWriteState::Failed(_) => EngineRuntimeReceiptStatus::Failed,
    }
}

fn subscription_status(state: &CodexAppServerSubscriptionState) -> EngineRuntimeReceiptStatus {
    match state {
        CodexAppServerSubscriptionState::Pending => EngineRuntimeReceiptStatus::Queued,
        CodexAppServerSubscriptionState::Open => EngineRuntimeReceiptStatus::InProgress,
        CodexAppServerSubscriptionState::Closed => EngineRuntimeReceiptStatus::Completed,
        CodexAppServerSubscriptionState::Blocked(_) => EngineRuntimeReceiptStatus::Blocked,
        CodexAppServerSubscriptionState::Failed(_) => EngineRuntimeReceiptStatus::Failed,
        CodexAppServerSubscriptionState::RecoveryRequired(_) => {
            EngineRuntimeReceiptStatus::RecoveryRequired
        }
    }
}

fn write_summary(record: &CodexAppServerStdioWriteStateRecord) -> String {
    format!(
        "Codex stdio write {:?}: command_id={}, raw_stream_retained={}, raw_payload_retained={}",
        record.state, record.command_id, record.raw_stream_retained, record.raw_payload_retained
    )
}

fn subscription_summary(record: &CodexAppServerSubscriptionStateRecord) -> String {
    format!(
        "Codex subscription {:?}: command_id={}, raw_stream_retained={}, callback_response_permitted={}, cancellation_permitted={}, task_mutation_permitted={}",
        record.state,
        record.command_id,
        record.raw_stream_retained,
        record.callback_response_permitted,
        record.cancellation_permitted,
        record.task_mutation_permitted
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        CodexAppServerStdioWriteStateId, CodexAppServerSubscriptionStateId,
    };

    #[test]
    fn stdio_write_receipt_is_sanitized() {
        let receipt = codex_receipt_from_stdio_write_state(&CodexAppServerStdioWriteStateRecord {
            write_id: CodexAppServerStdioWriteStateId("write:1".to_owned()),
            command_id: "send:1".to_owned(),
            envelope_id: "envelope:1".to_owned(),
            request_id: "request:1".to_owned(),
            method: "turn/start".to_owned(),
            state: CodexAppServerStdioWriteState::Written,
            evidence_refs: vec!["evidence:write".to_owned()],
            raw_payload_retained: false,
            raw_stream_retained: false,
        });

        assert_eq!(receipt.status, EngineRuntimeReceiptStatus::Completed);
        assert!(receipt.artifact_refs.is_empty());
        assert!(receipt
            .summary
            .as_deref()
            .unwrap_or_default()
            .contains("raw_stream_retained=false"));
    }

    #[test]
    fn subscription_recovery_receipt_is_explicit() {
        let receipt =
            codex_receipt_from_subscription_state(&CodexAppServerSubscriptionStateRecord {
                subscription_id: CodexAppServerSubscriptionStateId("subscription:1".to_owned()),
                command_id: "send:1".to_owned(),
                envelope_id: "envelope:1".to_owned(),
                request_id: "request:1".to_owned(),
                state: CodexAppServerSubscriptionState::RecoveryRequired(
                    "process exited".to_owned(),
                ),
                evidence_refs: vec!["evidence:subscription".to_owned()],
                raw_stream_retained: false,
                callback_response_permitted: false,
                cancellation_permitted: false,
                task_mutation_permitted: false,
            });

        assert_eq!(receipt.status, EngineRuntimeReceiptStatus::RecoveryRequired);
        assert!(receipt
            .summary
            .as_deref()
            .unwrap_or_default()
            .contains("task_mutation_permitted=false"));
    }
}
