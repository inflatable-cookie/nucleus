//! Duplicate-safe Codex app-server frame acceptance records.
//!
//! This module does not persist records or append orchestration events. It
//! shapes the first acceptance decision before later storage work.

use super::session_binding::{
    CodexAppServerIngestionIdentityQuality, CodexAppServerIngestionSourceRecord,
};

/// Stable idempotency key for one decoded Codex observation.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerFrameKey(pub String);

/// Prior acceptance state needed to classify one decoded source.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CodexAppServerFrameAcceptanceContext {
    pub seen_frame_keys: Vec<CodexAppServerFrameKey>,
    pub last_accepted_transport_sequence: Option<u64>,
}

/// Coarse kind after provider-frame projection has run.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerObservationKind {
    CanonicalRuntimeEvent,
    RuntimeReceipt,
    UnsupportedObservation,
}

/// Acceptance decision for one decoded Codex ingestion source.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerFrameAcceptanceRecord {
    pub source_id: String,
    pub binding_id: String,
    pub frame_key: CodexAppServerFrameKey,
    pub status: CodexAppServerFrameAcceptanceStatus,
    pub observation_kind: CodexAppServerObservationKind,
    pub transport_sequence: u64,
    pub reason: Option<String>,
    pub raw_payload_policy: String,
}

/// Result of attempting to accept one decoded frame.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerFrameAcceptanceStatus {
    Accepted,
    Duplicate,
    Unsupported,
    OutOfOrder,
    RecoveryRequired,
}

/// Build the stable idempotency key for a decoded source.
pub fn codex_frame_key_from_source(
    source: &CodexAppServerIngestionSourceRecord,
) -> CodexAppServerFrameKey {
    let provider_scope = source
        .provider_refs
        .thread_id
        .as_deref()
        .or(source.provider_refs.session_id.as_deref())
        .unwrap_or("synthetic-session");
    let event_scope = source
        .provider_refs
        .request_id
        .as_deref()
        .or(source.provider_refs.item_id.as_deref())
        .or(source.provider_refs.turn_id.as_deref())
        .unwrap_or("synthetic-event");
    let sequence_scope = match source.identity_quality {
        CodexAppServerIngestionIdentityQuality::ProviderIdentified => "provider".to_owned(),
        CodexAppServerIngestionIdentityQuality::SyntheticRequired => {
            format!("transport:{}", source.transport_sequence)
        }
        CodexAppServerIngestionIdentityQuality::RecoveryRequired(_) => "recovery".to_owned(),
    };

    CodexAppServerFrameKey(
        format!(
            "codex-frame-key:{}:{}:{}:{}:{}",
            source.adapter_instance_id,
            source.nucleus_session_id.0,
            source.method,
            provider_scope,
            event_scope
        ) + &format!(":{sequence_scope}"),
    )
}

/// Classify a decoded source before later event-store acceptance.
pub fn accept_codex_ingestion_source(
    source: &CodexAppServerIngestionSourceRecord,
    observation_kind: CodexAppServerObservationKind,
    context: &CodexAppServerFrameAcceptanceContext,
) -> CodexAppServerFrameAcceptanceRecord {
    let frame_key = codex_frame_key_from_source(source);
    let (status, reason) = acceptance_status(source, &frame_key, &observation_kind, context);

    CodexAppServerFrameAcceptanceRecord {
        source_id: source.source_id.0.clone(),
        binding_id: source.binding_id.0.clone(),
        frame_key,
        status,
        observation_kind,
        transport_sequence: source.transport_sequence,
        reason,
        raw_payload_policy: format!("{:?}", source.raw_payload_policy),
    }
}

fn acceptance_status(
    source: &CodexAppServerIngestionSourceRecord,
    frame_key: &CodexAppServerFrameKey,
    observation_kind: &CodexAppServerObservationKind,
    context: &CodexAppServerFrameAcceptanceContext,
) -> (CodexAppServerFrameAcceptanceStatus, Option<String>) {
    if let CodexAppServerIngestionIdentityQuality::RecoveryRequired(reason) =
        &source.identity_quality
    {
        return (
            CodexAppServerFrameAcceptanceStatus::RecoveryRequired,
            Some(reason.clone()),
        );
    }

    if context.seen_frame_keys.contains(frame_key) {
        return (
            CodexAppServerFrameAcceptanceStatus::Duplicate,
            Some("idempotency key already accepted".to_owned()),
        );
    }

    if let Some(last_sequence) = context.last_accepted_transport_sequence {
        if source.transport_sequence < last_sequence {
            return (
                CodexAppServerFrameAcceptanceStatus::OutOfOrder,
                Some(format!(
                    "transport sequence {} is older than last accepted sequence {last_sequence}",
                    source.transport_sequence
                )),
            );
        }
    }

    if matches!(
        observation_kind,
        CodexAppServerObservationKind::UnsupportedObservation
    ) {
        return (
            CodexAppServerFrameAcceptanceStatus::Unsupported,
            Some("provider method has no canonical mapping yet".to_owned()),
        );
    }

    (CodexAppServerFrameAcceptanceStatus::Accepted, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        codex_ingestion_source_from_live_frame, codex_session_binding_from_live_frame,
        CodexAppServerLiveFrame,
    };
    use nucleus_agent_protocol::{
        AgentSessionId, CodexAppServerEventFixture, CodexAppServerFixturePayload,
        CodexAppServerProviderRefs,
    };

    fn source(
        transport_sequence: u64,
        provider_refs: CodexAppServerProviderRefs,
    ) -> CodexAppServerIngestionSourceRecord {
        let frame = CodexAppServerLiveFrame {
            fixture: CodexAppServerEventFixture {
                method: "item/agentMessage/delta".to_owned(),
                provider_instance_id: "codex:local-default".to_owned(),
                nucleus_session_id: AgentSessionId("session:nucleus".to_owned()),
                provider_refs,
                sequence: transport_sequence,
                payload: CodexAppServerFixturePayload::AgentMessageDelta {
                    delta: "hello".to_owned(),
                    accumulated: Some("hello".to_owned()),
                },
                raw_payload: None,
            },
            transport_sequence,
        };
        let binding = codex_session_binding_from_live_frame(&frame);
        codex_ingestion_source_from_live_frame(&binding, &frame)
    }

    fn provider_refs(item_id: Option<&str>) -> CodexAppServerProviderRefs {
        CodexAppServerProviderRefs {
            thread_id: Some("thread:provider".to_owned()),
            session_id: None,
            turn_id: Some("turn:provider".to_owned()),
            item_id: item_id.map(str::to_owned),
            request_id: None,
        }
    }

    fn provider_refs_without_event_ids() -> CodexAppServerProviderRefs {
        CodexAppServerProviderRefs {
            thread_id: Some("thread:provider".to_owned()),
            session_id: None,
            turn_id: None,
            item_id: None,
            request_id: None,
        }
    }

    #[test]
    fn provider_ids_make_duplicate_key_stable_across_transport_replay() {
        let first = source(10, provider_refs(Some("item:1")));
        let replay = source(11, provider_refs(Some("item:1")));
        let first_key = codex_frame_key_from_source(&first);
        let replay_key = codex_frame_key_from_source(&replay);

        assert_eq!(first_key, replay_key);

        let record = accept_codex_ingestion_source(
            &replay,
            CodexAppServerObservationKind::CanonicalRuntimeEvent,
            &CodexAppServerFrameAcceptanceContext {
                seen_frame_keys: vec![first_key],
                last_accepted_transport_sequence: Some(10),
            },
        );

        assert_eq!(
            record.status,
            CodexAppServerFrameAcceptanceStatus::Duplicate
        );
    }

    #[test]
    fn synthetic_identity_uses_transport_sequence_in_key() {
        let first = source(10, provider_refs_without_event_ids());
        let second = source(11, provider_refs_without_event_ids());

        assert_ne!(
            codex_frame_key_from_source(&first),
            codex_frame_key_from_source(&second)
        );
    }

    #[test]
    fn older_transport_sequence_is_out_of_order() {
        let record = accept_codex_ingestion_source(
            &source(9, provider_refs(Some("item:2"))),
            CodexAppServerObservationKind::CanonicalRuntimeEvent,
            &CodexAppServerFrameAcceptanceContext {
                seen_frame_keys: Vec::new(),
                last_accepted_transport_sequence: Some(10),
            },
        );

        assert_eq!(
            record.status,
            CodexAppServerFrameAcceptanceStatus::OutOfOrder
        );
    }

    #[test]
    fn unsupported_observation_is_visible_without_accepting_runtime_event() {
        let record = accept_codex_ingestion_source(
            &source(12, provider_refs(Some("item:unsupported"))),
            CodexAppServerObservationKind::UnsupportedObservation,
            &CodexAppServerFrameAcceptanceContext::default(),
        );

        assert_eq!(
            record.status,
            CodexAppServerFrameAcceptanceStatus::Unsupported
        );
        assert_eq!(
            record.reason.as_deref(),
            Some("provider method has no canonical mapping yet")
        );
    }

    #[test]
    fn missing_session_identity_requires_recovery() {
        let recovery_source = source(
            13,
            CodexAppServerProviderRefs {
                thread_id: None,
                session_id: None,
                turn_id: None,
                item_id: None,
                request_id: None,
            },
        );

        let record = accept_codex_ingestion_source(
            &recovery_source,
            CodexAppServerObservationKind::CanonicalRuntimeEvent,
            &CodexAppServerFrameAcceptanceContext::default(),
        );

        assert_eq!(
            record.status,
            CodexAppServerFrameAcceptanceStatus::RecoveryRequired
        );
    }
}
