//! Codex observation linkage to orchestration event-store envelopes.
//!
//! This module builds replay-safe event and receipt refs. It does not append
//! records to storage or re-run provider work.

use nucleus_engine::{EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId};
use nucleus_orchestration::{
    EventStreamRef, OrchestrationCommandId, OrchestrationEventId, OrchestrationEventRecord,
    OrchestrationEventStoreRecord,
};

use super::idempotency::{
    CodexAppServerFrameAcceptanceRecord, CodexAppServerFrameAcceptanceStatus,
    CodexAppServerObservationKind,
};

/// Link between one Codex accepted observation and replay-safe evidence refs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerObservationEventLink {
    pub source_id: String,
    pub binding_id: String,
    pub status: CodexAppServerObservationEventLinkStatus,
    pub event_store_record: Option<OrchestrationEventStoreRecord>,
    pub receipt_id: Option<EngineRuntimeReceiptRecordId>,
    pub replay_runs_provider_work: bool,
    pub reason: Option<String>,
}

/// Event-store linkage state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerObservationEventLinkStatus {
    Linked,
    ReceiptOnly,
    NotLinked(String),
}

/// Link an accepted Codex observation to an event-store envelope and optional
/// sanitized runtime receipt ref.
pub fn link_codex_observation_to_event_store(
    acceptance: &CodexAppServerFrameAcceptanceRecord,
    receipt: Option<&EngineRuntimeReceiptRecord>,
) -> CodexAppServerObservationEventLink {
    let receipt_id = receipt.map(|record| record.receipt_id.clone());

    if acceptance.status != CodexAppServerFrameAcceptanceStatus::Accepted {
        return CodexAppServerObservationEventLink {
            source_id: acceptance.source_id.clone(),
            binding_id: acceptance.binding_id.clone(),
            status: CodexAppServerObservationEventLinkStatus::NotLinked(format!(
                "observation status is {:?}",
                acceptance.status
            )),
            event_store_record: None,
            receipt_id,
            replay_runs_provider_work: false,
            reason: acceptance.reason.clone(),
        };
    }

    let event_store_record = event_store_record_for_acceptance(acceptance);
    let status = match acceptance.observation_kind {
        CodexAppServerObservationKind::RuntimeReceipt => {
            CodexAppServerObservationEventLinkStatus::ReceiptOnly
        }
        _ => CodexAppServerObservationEventLinkStatus::Linked,
    };

    CodexAppServerObservationEventLink {
        source_id: acceptance.source_id.clone(),
        binding_id: acceptance.binding_id.clone(),
        status,
        event_store_record: Some(event_store_record),
        receipt_id,
        replay_runs_provider_work: false,
        reason: None,
    }
}

fn event_store_record_for_acceptance(
    acceptance: &CodexAppServerFrameAcceptanceRecord,
) -> OrchestrationEventStoreRecord {
    let event_id =
        OrchestrationEventId(format!("event:codex-observation:{}", acceptance.source_id));
    let command_id = OrchestrationCommandId(format!(
        "command:codex-observation:{}",
        acceptance.binding_id
    ));
    let payload = OrchestrationEventRecord::runtime_observation_accepted(
        event_id,
        command_id,
        Some(acceptance.binding_id.clone()),
    );

    OrchestrationEventStoreRecord::from_event(
        EventStreamRef(format!("stream:codex-session:{}", acceptance.binding_id)),
        payload,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        accept_codex_ingestion_source, codex_ingestion_source_from_live_frame,
        codex_session_binding_from_live_frame, CodexAppServerFrameAcceptanceContext,
        CodexAppServerLiveFrame,
    };
    use nucleus_agent_protocol::{
        AgentSessionId, CodexAppServerEventFixture, CodexAppServerFixturePayload,
        CodexAppServerProviderRefs,
    };
    use nucleus_engine::{
        EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
    };
    use nucleus_orchestration::OrchestrationEventKind;

    fn accepted(kind: CodexAppServerObservationKind) -> CodexAppServerFrameAcceptanceRecord {
        let frame = CodexAppServerLiveFrame {
            fixture: CodexAppServerEventFixture {
                method: "turn/completed".to_owned(),
                provider_instance_id: "codex:local-default".to_owned(),
                nucleus_session_id: AgentSessionId("session:nucleus".to_owned()),
                provider_refs: CodexAppServerProviderRefs {
                    thread_id: Some("thread:provider".to_owned()),
                    session_id: None,
                    turn_id: Some("turn:provider".to_owned()),
                    item_id: None,
                    request_id: None,
                },
                sequence: 7,
                payload: CodexAppServerFixturePayload::TurnCompleted {
                    status_detail: Some("done".to_owned()),
                },
                raw_payload: None,
            },
            transport_sequence: 7,
        };
        let binding = codex_session_binding_from_live_frame(&frame);
        let source = codex_ingestion_source_from_live_frame(&binding, &frame);
        accept_codex_ingestion_source(
            &source,
            kind,
            &CodexAppServerFrameAcceptanceContext::default(),
        )
    }

    #[test]
    fn accepted_observation_gets_runtime_event_store_record() {
        let link = link_codex_observation_to_event_store(
            &accepted(CodexAppServerObservationKind::CanonicalRuntimeEvent),
            None,
        );
        let event = link.event_store_record.as_ref().expect("event record");

        assert_eq!(
            link.status,
            CodexAppServerObservationEventLinkStatus::Linked
        );
        assert_eq!(
            event.kind,
            OrchestrationEventKind::RuntimeObservationAccepted
        );
        assert_eq!(event.target_ref.as_deref(), Some(link.binding_id.as_str()));
        assert!(event.stream_ref.0.contains(&link.binding_id));
        assert!(!link.replay_runs_provider_work);
    }

    #[test]
    fn duplicate_observation_does_not_get_event_store_record() {
        let mut duplicate = accepted(CodexAppServerObservationKind::CanonicalRuntimeEvent);
        duplicate.status = CodexAppServerFrameAcceptanceStatus::Duplicate;
        duplicate.reason = Some("already accepted".to_owned());

        let link = link_codex_observation_to_event_store(&duplicate, None);

        assert!(link.event_store_record.is_none());
        assert!(matches!(
            link.status,
            CodexAppServerObservationEventLinkStatus::NotLinked(_)
        ));
        assert!(!link.replay_runs_provider_work);
    }

    #[test]
    fn runtime_receipt_observation_links_sanitized_receipt_ref() {
        let acceptance = accepted(CodexAppServerObservationKind::RuntimeReceipt);
        let receipt = EngineRuntimeReceiptRecord {
            receipt_id: EngineRuntimeReceiptRecordId("receipt:codex:1".to_owned()),
            family: EngineRuntimeReceiptEffectFamily::HarnessProvider,
            status: EngineRuntimeReceiptStatus::Completed,
            command_ref: None,
            effect_ref: Some(EngineRuntimeReceiptRef::Custom("codex:effect".to_owned())),
            evidence_refs: vec![EngineRuntimeReceiptRef::EventId("event:codex".to_owned())],
            artifact_refs: Vec::new(),
            summary: Some("provider completed turn".to_owned()),
        };

        let link = link_codex_observation_to_event_store(&acceptance, Some(&receipt));

        assert_eq!(
            link.status,
            CodexAppServerObservationEventLinkStatus::ReceiptOnly
        );
        assert_eq!(link.receipt_id, Some(receipt.receipt_id));
        assert!(link.event_store_record.is_some());
        assert!(!link.replay_runs_provider_work);
    }
}
