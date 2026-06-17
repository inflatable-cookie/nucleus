//! Engine receipt projection for Codex runtime fixture evidence.

use nucleus_agent_protocol::{CodexRuntimeReceiptFixture, CodexRuntimeReceiptStatus};

use crate::runtime_receipts::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};

pub fn runtime_receipt_from_codex_fixture(
    fixture: &CodexRuntimeReceiptFixture,
) -> EngineRuntimeReceiptRecord {
    EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(fixture.receipt_id.clone()),
        family: EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status: codex_receipt_status(&fixture.status),
        command_ref: None,
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(format!(
            "{}:{}",
            fixture.provider_instance_id, fixture.nucleus_session_id.0
        ))),
        evidence_refs: fixture
            .evidence_event_id
            .iter()
            .map(|event_id| EngineRuntimeReceiptRef::EventId(event_id.clone()))
            .collect(),
        artifact_refs: Vec::new(),
        summary: Some(fixture.summary.clone()),
    }
}

fn codex_receipt_status(status: &CodexRuntimeReceiptStatus) -> EngineRuntimeReceiptStatus {
    match status {
        CodexRuntimeReceiptStatus::WaitingForApproval => {
            EngineRuntimeReceiptStatus::WaitingForApproval
        }
        CodexRuntimeReceiptStatus::WaitingForUserInput => {
            EngineRuntimeReceiptStatus::WaitingForUserInput
        }
        CodexRuntimeReceiptStatus::Cancelled => EngineRuntimeReceiptStatus::Cancelled,
        CodexRuntimeReceiptStatus::Completed => EngineRuntimeReceiptStatus::Completed,
        CodexRuntimeReceiptStatus::Failed => EngineRuntimeReceiptStatus::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_agent_protocol::{
        AgentSessionId, CodexAppServerProviderRefs, CodexRuntimeReceiptFixture,
        CodexRuntimeReceiptStatus,
    };

    #[test]
    fn codex_interruption_fixture_becomes_harness_provider_receipt() {
        let fixture = CodexRuntimeReceiptFixture {
            receipt_id: "receipt:codex:1".to_owned(),
            provider_instance_id: "adapter:codex-app-server".to_owned(),
            nucleus_session_id: AgentSessionId("session:nucleus".to_owned()),
            provider_refs: CodexAppServerProviderRefs {
                thread_id: Some("thread:provider".to_owned()),
                session_id: Some("session:provider".to_owned()),
                turn_id: Some("turn:provider".to_owned()),
                item_id: None,
                request_id: Some("request:provider".to_owned()),
            },
            status: CodexRuntimeReceiptStatus::Cancelled,
            evidence_event_id: Some("event:codex:interrupt".to_owned()),
            summary: "turn interrupted by operator".to_owned(),
        };

        let receipt = runtime_receipt_from_codex_fixture(&fixture);

        assert_eq!(receipt.receipt_id.0, "receipt:codex:1");
        assert_eq!(
            receipt.family,
            EngineRuntimeReceiptEffectFamily::HarnessProvider
        );
        assert_eq!(receipt.status, EngineRuntimeReceiptStatus::Cancelled);
        assert_eq!(
            receipt.evidence_refs,
            vec![EngineRuntimeReceiptRef::EventId(
                "event:codex:interrupt".to_owned()
            )]
        );
        assert_eq!(
            receipt.summary.as_deref(),
            Some("turn interrupted by operator")
        );
    }
}
