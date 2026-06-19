//! Durable Codex app-server session binding and ingestion source records.
//!
//! These records identify decoded observations before any live transport,
//! provider command reactor, or task mutation exists.

use nucleus_agent_protocol::{
    AgentSessionId, AgentSessionRecoveryState, CodexAppServerProviderRefs,
};

use super::live_ingestion::{CodexAppServerLiveFrame, CodexRawPayloadPolicy};

/// Stable server id for one Codex/Nucleus session binding record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerSessionBindingId(pub String);

/// Stable server id for one decoded Codex ingestion source.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerIngestionSourceId(pub String);

/// Durable binding between a Nucleus session and Codex provider refs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerSessionBindingRecord {
    pub binding_id: CodexAppServerSessionBindingId,
    pub adapter_instance_id: String,
    pub nucleus_session_id: AgentSessionId,
    pub provider_refs: CodexAppServerProviderRefs,
    pub confidence: CodexAppServerBindingConfidence,
    pub status: CodexAppServerBindingStatus,
    pub recovery_state: AgentSessionRecoveryState,
    pub evidence_ref: String,
    pub latest_ingestion_source_id: Option<CodexAppServerIngestionSourceId>,
}

/// How strong the provider identity is for this binding.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerBindingConfidence {
    ProviderThreadAndSession,
    ProviderThreadOnly,
    ProviderSessionOnly,
    SyntheticOrMissingProviderIds,
}

/// Local status for a Codex session binding.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerBindingStatus {
    Active,
    RecoveryRequired(String),
    ReplacementThreadObserved {
        requested_thread_id: Option<String>,
        replacement_thread_id: String,
        reason: String,
    },
}

/// One decoded Codex frame source before event-store acceptance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerIngestionSourceRecord {
    pub source_id: CodexAppServerIngestionSourceId,
    pub binding_id: CodexAppServerSessionBindingId,
    pub adapter_instance_id: String,
    pub nucleus_session_id: AgentSessionId,
    pub provider_refs: CodexAppServerProviderRefs,
    pub method: String,
    pub transport_sequence: u64,
    pub identity_quality: CodexAppServerIngestionIdentityQuality,
    pub raw_payload_policy: CodexRawPayloadPolicy,
    pub evidence_ref: String,
}

/// Whether a decoded frame has enough provider identity for acceptance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerIngestionIdentityQuality {
    ProviderIdentified,
    SyntheticRequired,
    RecoveryRequired(String),
}

/// Build a server-owned Codex session binding from a decoded live frame.
pub fn codex_session_binding_from_live_frame(
    frame: &CodexAppServerLiveFrame,
) -> CodexAppServerSessionBindingRecord {
    let provider_refs = frame.fixture.provider_refs.clone();
    let confidence = binding_confidence(&provider_refs);
    let recovery_state = recovery_state_for_confidence(&confidence);
    let status = match confidence {
        CodexAppServerBindingConfidence::SyntheticOrMissingProviderIds => {
            CodexAppServerBindingStatus::RecoveryRequired(
                "Codex frame did not include provider thread or session id".to_owned(),
            )
        }
        _ => CodexAppServerBindingStatus::Active,
    };
    let binding_id = binding_id(
        &frame.fixture.provider_instance_id,
        &frame.fixture.nucleus_session_id,
        &provider_refs,
    );

    CodexAppServerSessionBindingRecord {
        binding_id,
        adapter_instance_id: frame.fixture.provider_instance_id.clone(),
        nucleus_session_id: frame.fixture.nucleus_session_id.clone(),
        provider_refs,
        confidence,
        status,
        recovery_state,
        evidence_ref: evidence_ref(frame),
        latest_ingestion_source_id: None,
    }
}

/// Build a decoded-frame source record linked to a session binding.
pub fn codex_ingestion_source_from_live_frame(
    binding: &CodexAppServerSessionBindingRecord,
    frame: &CodexAppServerLiveFrame,
) -> CodexAppServerIngestionSourceRecord {
    CodexAppServerIngestionSourceRecord {
        source_id: source_id(binding, frame),
        binding_id: binding.binding_id.clone(),
        adapter_instance_id: frame.fixture.provider_instance_id.clone(),
        nucleus_session_id: frame.fixture.nucleus_session_id.clone(),
        provider_refs: frame.fixture.provider_refs.clone(),
        method: frame.fixture.method.clone(),
        transport_sequence: frame.transport_sequence,
        identity_quality: ingestion_identity_quality(binding, frame),
        raw_payload_policy: CodexRawPayloadPolicy::MetadataOnly,
        evidence_ref: evidence_ref(frame),
    }
}

/// Record that recovery observed a replacement Codex thread.
pub fn codex_replacement_thread_recovery_binding(
    binding: &CodexAppServerSessionBindingRecord,
    replacement_thread_id: String,
    reason: String,
    evidence_ref: String,
) -> CodexAppServerSessionBindingRecord {
    let mut replacement = binding.clone();
    let requested_thread_id = replacement.provider_refs.thread_id.clone();
    replacement.provider_refs.thread_id = Some(replacement_thread_id.clone());
    replacement.confidence = CodexAppServerBindingConfidence::ProviderThreadOnly;
    replacement.status = CodexAppServerBindingStatus::ReplacementThreadObserved {
        requested_thread_id,
        replacement_thread_id,
        reason,
    };
    replacement.recovery_state = AgentSessionRecoveryState::RecoveryRequired;
    replacement.evidence_ref = evidence_ref;
    replacement.latest_ingestion_source_id = None;
    replacement
}

fn binding_confidence(
    provider_refs: &CodexAppServerProviderRefs,
) -> CodexAppServerBindingConfidence {
    match (
        provider_refs.thread_id.as_ref(),
        provider_refs.session_id.as_ref(),
    ) {
        (Some(_), Some(_)) => CodexAppServerBindingConfidence::ProviderThreadAndSession,
        (Some(_), None) => CodexAppServerBindingConfidence::ProviderThreadOnly,
        (None, Some(_)) => CodexAppServerBindingConfidence::ProviderSessionOnly,
        (None, None) => CodexAppServerBindingConfidence::SyntheticOrMissingProviderIds,
    }
}

fn recovery_state_for_confidence(
    confidence: &CodexAppServerBindingConfidence,
) -> AgentSessionRecoveryState {
    match confidence {
        CodexAppServerBindingConfidence::SyntheticOrMissingProviderIds => {
            AgentSessionRecoveryState::RecoveryRequired
        }
        _ => AgentSessionRecoveryState::Recoverable,
    }
}

fn ingestion_identity_quality(
    binding: &CodexAppServerSessionBindingRecord,
    frame: &CodexAppServerLiveFrame,
) -> CodexAppServerIngestionIdentityQuality {
    if matches!(
        binding.confidence,
        CodexAppServerBindingConfidence::SyntheticOrMissingProviderIds
    ) {
        return CodexAppServerIngestionIdentityQuality::RecoveryRequired(
            "session binding lacks provider thread/session identity".to_owned(),
        );
    }

    if frame.fixture.provider_refs.turn_id.is_none()
        && frame.fixture.provider_refs.item_id.is_none()
        && frame.fixture.provider_refs.request_id.is_none()
    {
        CodexAppServerIngestionIdentityQuality::SyntheticRequired
    } else {
        CodexAppServerIngestionIdentityQuality::ProviderIdentified
    }
}

fn binding_id(
    adapter_instance_id: &str,
    nucleus_session_id: &AgentSessionId,
    provider_refs: &CodexAppServerProviderRefs,
) -> CodexAppServerSessionBindingId {
    let provider_key = provider_refs
        .thread_id
        .as_deref()
        .or(provider_refs.session_id.as_deref())
        .unwrap_or("synthetic");
    CodexAppServerSessionBindingId(format!(
        "codex-binding:{adapter_instance_id}:{}:{provider_key}",
        nucleus_session_id.0
    ))
}

fn source_id(
    binding: &CodexAppServerSessionBindingRecord,
    frame: &CodexAppServerLiveFrame,
) -> CodexAppServerIngestionSourceId {
    CodexAppServerIngestionSourceId(format!(
        "codex-source:{}:{}:{}",
        binding.binding_id.0, frame.fixture.method, frame.transport_sequence
    ))
}

fn evidence_ref(frame: &CodexAppServerLiveFrame) -> String {
    format!(
        "codex-frame:{}:{}:{}",
        frame.fixture.provider_instance_id,
        frame.fixture.nucleus_session_id.0,
        frame.transport_sequence
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_agent_protocol::{CodexAppServerEventFixture, CodexAppServerFixturePayload};

    fn frame(provider_refs: CodexAppServerProviderRefs) -> CodexAppServerLiveFrame {
        CodexAppServerLiveFrame {
            fixture: CodexAppServerEventFixture {
                method: "turn/started".to_owned(),
                provider_instance_id: "codex:local-default".to_owned(),
                nucleus_session_id: AgentSessionId("session:nucleus".to_owned()),
                provider_refs,
                sequence: 7,
                payload: CodexAppServerFixturePayload::TurnStarted,
                raw_payload: Some("raw provider payload".to_owned()),
            },
            transport_sequence: 42,
        }
    }

    #[test]
    fn binding_keeps_nucleus_session_authoritative() {
        let binding = codex_session_binding_from_live_frame(&frame(CodexAppServerProviderRefs {
            thread_id: Some("thread:provider".to_owned()),
            session_id: Some("session:provider".to_owned()),
            turn_id: Some("turn:provider".to_owned()),
            item_id: None,
            request_id: None,
        }));

        assert_eq!(
            binding.nucleus_session_id,
            AgentSessionId("session:nucleus".to_owned())
        );
        assert_eq!(
            binding.confidence,
            CodexAppServerBindingConfidence::ProviderThreadAndSession
        );
        assert_eq!(binding.status, CodexAppServerBindingStatus::Active);
        assert_eq!(
            binding.recovery_state,
            AgentSessionRecoveryState::Recoverable
        );
    }

    #[test]
    fn binding_marks_missing_provider_ids_as_recovery_required() {
        let binding = codex_session_binding_from_live_frame(&frame(CodexAppServerProviderRefs {
            thread_id: None,
            session_id: None,
            turn_id: None,
            item_id: None,
            request_id: None,
        }));

        assert_eq!(
            binding.confidence,
            CodexAppServerBindingConfidence::SyntheticOrMissingProviderIds
        );
        assert!(matches!(
            binding.status,
            CodexAppServerBindingStatus::RecoveryRequired(_)
        ));
        assert_eq!(
            binding.recovery_state,
            AgentSessionRecoveryState::RecoveryRequired
        );
    }

    #[test]
    fn ingestion_source_refs_binding_without_raw_payload() {
        let live_frame = frame(CodexAppServerProviderRefs {
            thread_id: Some("thread:provider".to_owned()),
            session_id: None,
            turn_id: Some("turn:provider".to_owned()),
            item_id: None,
            request_id: None,
        });
        let binding = codex_session_binding_from_live_frame(&live_frame);
        let source = codex_ingestion_source_from_live_frame(&binding, &live_frame);

        assert_eq!(source.binding_id, binding.binding_id);
        assert_eq!(
            source.identity_quality,
            CodexAppServerIngestionIdentityQuality::ProviderIdentified
        );
        assert_eq!(
            source.raw_payload_policy,
            CodexRawPayloadPolicy::MetadataOnly
        );
        assert!(source.evidence_ref.contains("session:nucleus"));
    }

    #[test]
    fn replacement_thread_is_recovery_evidence_not_same_session_claim() {
        let binding = codex_session_binding_from_live_frame(&frame(CodexAppServerProviderRefs {
            thread_id: Some("thread:requested".to_owned()),
            session_id: None,
            turn_id: None,
            item_id: None,
            request_id: None,
        }));

        let replacement = codex_replacement_thread_recovery_binding(
            &binding,
            "thread:replacement".to_owned(),
            "thread/resume failed".to_owned(),
            "evidence:resume-fallback".to_owned(),
        );

        assert!(matches!(
            replacement.status,
            CodexAppServerBindingStatus::ReplacementThreadObserved {
                requested_thread_id: Some(ref requested),
                replacement_thread_id: ref replacement_thread,
                ..
            } if requested == "thread:requested" && replacement_thread == "thread:replacement"
        ));
        assert_eq!(
            replacement.recovery_state,
            AgentSessionRecoveryState::RecoveryRequired
        );
        assert_eq!(replacement.evidence_ref, "evidence:resume-fallback");
    }
}
