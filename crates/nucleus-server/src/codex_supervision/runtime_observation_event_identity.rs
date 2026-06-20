//! Runtime observation event identity records.
//!
//! These records derive stable orchestration ids from accepted provider
//! observations. They do not append to storage, replay provider streams, retain
//! raw payloads, or mutate task state.

use super::{
    CodexAppServerDecodeOutcomePersistenceRecord, CodexAppServerFrameAcceptanceRecord,
    CodexAppServerFrameAcceptanceStatus, CodexAppServerObservationKind,
    CodexAppServerStdioDecodeStatus,
};
use crate::{ProviderSessionBindingRecord, ProviderSessionRepairState};

/// Input for deriving one runtime observation event identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexRuntimeObservationEventIdentityInput {
    pub provider_instance_id: String,
    pub session: ProviderSessionBindingRecord,
    pub acceptance: CodexAppServerFrameAcceptanceRecord,
    pub decode_outcome: CodexAppServerDecodeOutcomePersistenceRecord,
}

/// Stable replay-safe identity for one runtime observation event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexRuntimeObservationEventIdentityRecord {
    pub identity_id: String,
    pub event_id: String,
    pub command_id: String,
    pub stream_ref: String,
    pub target_ref: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub binding_id: String,
    pub frame_source_id: String,
    pub decode_outcome_id: String,
    pub method: Option<String>,
    pub sequence: u64,
    pub observation_kind: CodexAppServerObservationKind,
    pub status: CodexRuntimeObservationEventIdentityStatus,
    pub blockers: Vec<CodexRuntimeObservationEventIdentityBlocker>,
    pub confidence: String,
    pub repair_state: String,
    pub unsupported_observation_visible: bool,
    pub replay_safe: bool,
    pub raw_provider_material_retained: bool,
    pub provider_io_executed: bool,
    pub task_mutation_permitted: bool,
}

/// Runtime observation identity status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexRuntimeObservationEventIdentityStatus {
    Accepted,
    UnsupportedObservation,
    Blocked,
}

/// Blockers before a runtime observation can be promoted into the event store.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexRuntimeObservationEventIdentityBlocker {
    AcceptanceNotPromotable,
    BindingIdentityMismatch,
    RuntimeSessionMismatch,
    FrameSourceMismatch,
    MissingProviderInstance,
    MissingMethodForAcceptedObservation,
    RawMaterialRetained,
    ProviderIoExecuted,
    TaskMutationPermitted,
}

/// Derive deterministic runtime observation event identity.
pub fn codex_runtime_observation_event_identity(
    input: CodexRuntimeObservationEventIdentityInput,
) -> CodexRuntimeObservationEventIdentityRecord {
    let blockers = identity_blockers(&input);
    let unsupported_observation_visible = is_unsupported_observation(&input);
    let status = if !blockers.is_empty() {
        CodexRuntimeObservationEventIdentityStatus::Blocked
    } else if unsupported_observation_visible {
        CodexRuntimeObservationEventIdentityStatus::UnsupportedObservation
    } else {
        CodexRuntimeObservationEventIdentityStatus::Accepted
    };
    let method = observation_method(&input.decode_outcome);
    let identity_key = identity_key(&input, method.as_deref(), &status);

    CodexRuntimeObservationEventIdentityRecord {
        identity_id: format!("codex-runtime-observation-identity:{identity_key}"),
        event_id: format!("event:codex-runtime-observation:{identity_key}"),
        command_id: format!(
            "command:codex-runtime-observation:{}",
            input.acceptance.binding_id
        ),
        stream_ref: format!(
            "stream:codex-runtime-observation:{}",
            input.session.runtime_session_ref
        ),
        target_ref: input.acceptance.binding_id.clone(),
        provider_instance_id: input.provider_instance_id,
        runtime_session_ref: input.session.runtime_session_ref,
        binding_id: input.acceptance.binding_id,
        frame_source_id: input.decode_outcome.frame_source_id,
        decode_outcome_id: input.decode_outcome.outcome_id,
        method,
        sequence: input.acceptance.transport_sequence,
        observation_kind: input.acceptance.observation_kind,
        status,
        blockers,
        confidence: "provider_session_binding".to_owned(),
        repair_state: repair_state_label(&input.session.repair_state),
        unsupported_observation_visible,
        replay_safe: true,
        raw_provider_material_retained: false,
        provider_io_executed: false,
        task_mutation_permitted: false,
    }
}

fn identity_blockers(
    input: &CodexRuntimeObservationEventIdentityInput,
) -> Vec<CodexRuntimeObservationEventIdentityBlocker> {
    let mut blockers = Vec::new();

    if input.provider_instance_id.trim().is_empty() {
        blockers.push(CodexRuntimeObservationEventIdentityBlocker::MissingProviderInstance);
    }
    if input.acceptance.binding_id != input.session.binding_id.0 {
        blockers.push(CodexRuntimeObservationEventIdentityBlocker::BindingIdentityMismatch);
    }
    if input.decode_outcome.runtime_instance_id != input.session.runtime_session_ref {
        blockers.push(CodexRuntimeObservationEventIdentityBlocker::RuntimeSessionMismatch);
    }
    if input.decode_outcome.frame_source_id != input.acceptance.source_id {
        blockers.push(CodexRuntimeObservationEventIdentityBlocker::FrameSourceMismatch);
    }
    if !matches!(
        input.acceptance.status,
        CodexAppServerFrameAcceptanceStatus::Accepted
            | CodexAppServerFrameAcceptanceStatus::Unsupported
    ) {
        blockers.push(CodexRuntimeObservationEventIdentityBlocker::AcceptanceNotPromotable);
    }
    if matches!(
        input.acceptance.status,
        CodexAppServerFrameAcceptanceStatus::Accepted
    ) && observation_method(&input.decode_outcome).is_none()
    {
        blockers
            .push(CodexRuntimeObservationEventIdentityBlocker::MissingMethodForAcceptedObservation);
    }
    if input.decode_outcome.raw_json_rpc_payload_retained
        || input.decode_outcome.raw_provider_payload_retained
        || input.session.raw_provider_material_retained
    {
        blockers.push(CodexRuntimeObservationEventIdentityBlocker::RawMaterialRetained);
    }
    if input.decode_outcome.provider_io_executed {
        blockers.push(CodexRuntimeObservationEventIdentityBlocker::ProviderIoExecuted);
    }
    if input.decode_outcome.task_mutation_permitted || input.session.task_mutation_permitted {
        blockers.push(CodexRuntimeObservationEventIdentityBlocker::TaskMutationPermitted);
    }

    blockers
}

fn is_unsupported_observation(input: &CodexRuntimeObservationEventIdentityInput) -> bool {
    matches!(
        input.acceptance.observation_kind,
        CodexAppServerObservationKind::UnsupportedObservation
    ) || matches!(
        input.decode_outcome.decode_status,
        CodexAppServerStdioDecodeStatus::Unsupported { .. }
    )
}

fn observation_method(outcome: &CodexAppServerDecodeOutcomePersistenceRecord) -> Option<String> {
    outcome
        .decoded_method
        .clone()
        .or_else(|| match &outcome.decode_status {
            CodexAppServerStdioDecodeStatus::Unsupported {
                method: Some(method),
                ..
            } => Some(method.clone()),
            _ => None,
        })
}

fn identity_key(
    input: &CodexRuntimeObservationEventIdentityInput,
    method: Option<&str>,
    status: &CodexRuntimeObservationEventIdentityStatus,
) -> String {
    [
        sanitize_id_part(&input.provider_instance_id),
        sanitize_id_part(&input.session.runtime_session_ref),
        sanitize_id_part(&input.decode_outcome.frame_source_id),
        sanitize_id_part(&input.decode_outcome.outcome_id),
        sanitize_id_part(method.unwrap_or("method-unknown")),
        input.acceptance.transport_sequence.to_string(),
        sanitize_id_part(&format!("{:?}", input.acceptance.observation_kind)),
        sanitize_id_part(&format!("{status:?}")),
    ]
    .join(":")
}

fn sanitize_id_part(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' => character,
            _ => '-',
        })
        .collect()
}

fn repair_state_label(state: &ProviderSessionRepairState) -> String {
    match state {
        ProviderSessionRepairState::Healthy => "healthy",
        ProviderSessionRepairState::NeedsIdentityRepair { .. } => "needs_identity_repair",
        ProviderSessionRepairState::NeedsRuntimeRecovery { .. } => "needs_runtime_recovery",
        ProviderSessionRepairState::ProviderUnavailable { .. } => "provider_unavailable",
        ProviderSessionRepairState::Unknown => "unknown",
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ProviderSessionBindingId, ProviderSessionLifecycleState, ProviderSessionRepairState,
    };

    #[test]
    fn runtime_observation_event_identity_is_deterministic_and_replay_safe() {
        let first = codex_runtime_observation_event_identity(input(
            CodexAppServerFrameAcceptanceStatus::Accepted,
            CodexAppServerObservationKind::CanonicalRuntimeEvent,
            decode_outcome(CodexAppServerStdioDecodeStatus::Decoded {
                method: "turn/completed".to_owned(),
            }),
        ));
        let second = codex_runtime_observation_event_identity(input(
            CodexAppServerFrameAcceptanceStatus::Accepted,
            CodexAppServerObservationKind::CanonicalRuntimeEvent,
            decode_outcome(CodexAppServerStdioDecodeStatus::Decoded {
                method: "turn/completed".to_owned(),
            }),
        ));

        assert_eq!(first, second);
        assert_eq!(
            first.status,
            CodexRuntimeObservationEventIdentityStatus::Accepted
        );
        assert_eq!(first.method, Some("turn/completed".to_owned()));
        assert!(first.replay_safe);
        assert!(!first.provider_io_executed);
        assert!(!first.task_mutation_permitted);
    }

    #[test]
    fn runtime_observation_event_identity_keeps_unsupported_identity_visible() {
        let record = codex_runtime_observation_event_identity(input(
            CodexAppServerFrameAcceptanceStatus::Unsupported,
            CodexAppServerObservationKind::UnsupportedObservation,
            decode_outcome(CodexAppServerStdioDecodeStatus::Unsupported {
                method: Some("experimental/event".to_owned()),
                reason: "unsupported".to_owned(),
            }),
        ));

        assert_eq!(
            record.status,
            CodexRuntimeObservationEventIdentityStatus::UnsupportedObservation
        );
        assert_eq!(record.method, Some("experimental/event".to_owned()));
        assert!(record.unsupported_observation_visible);
        assert!(record.event_id.contains("UnsupportedObservation"));
    }

    #[test]
    fn runtime_observation_event_identity_blocks_mismatched_session_identity() {
        let mut input = input(
            CodexAppServerFrameAcceptanceStatus::Accepted,
            CodexAppServerObservationKind::CanonicalRuntimeEvent,
            decode_outcome(CodexAppServerStdioDecodeStatus::Decoded {
                method: "turn/completed".to_owned(),
            }),
        );
        input.decode_outcome.runtime_instance_id = "runtime-session:other".to_owned();

        let record = codex_runtime_observation_event_identity(input);

        assert_eq!(
            record.status,
            CodexRuntimeObservationEventIdentityStatus::Blocked
        );
        assert!(record
            .blockers
            .contains(&CodexRuntimeObservationEventIdentityBlocker::RuntimeSessionMismatch));
        assert!(record.replay_safe);
    }

    #[test]
    fn runtime_observation_event_identity_blocks_raw_or_task_mutating_records() {
        let mut input = input(
            CodexAppServerFrameAcceptanceStatus::Accepted,
            CodexAppServerObservationKind::CanonicalRuntimeEvent,
            decode_outcome(CodexAppServerStdioDecodeStatus::Decoded {
                method: "turn/completed".to_owned(),
            }),
        );
        input.decode_outcome.raw_provider_payload_retained = true;
        input.session.task_mutation_permitted = true;

        let record = codex_runtime_observation_event_identity(input);

        assert_eq!(
            record.status,
            CodexRuntimeObservationEventIdentityStatus::Blocked
        );
        assert!(record
            .blockers
            .contains(&CodexRuntimeObservationEventIdentityBlocker::RawMaterialRetained));
        assert!(record
            .blockers
            .contains(&CodexRuntimeObservationEventIdentityBlocker::TaskMutationPermitted));
    }

    fn input(
        acceptance_status: CodexAppServerFrameAcceptanceStatus,
        observation_kind: CodexAppServerObservationKind,
        decode_outcome: CodexAppServerDecodeOutcomePersistenceRecord,
    ) -> CodexRuntimeObservationEventIdentityInput {
        CodexRuntimeObservationEventIdentityInput {
            provider_instance_id: "codex:local-default".to_owned(),
            session: session(),
            acceptance: CodexAppServerFrameAcceptanceRecord {
                source_id: "codex-frame-source:1".to_owned(),
                binding_id: "provider-session-binding:1".to_owned(),
                frame_key: super::super::CodexAppServerFrameKey("codex-frame-key:1".to_owned()),
                status: acceptance_status,
                observation_kind,
                transport_sequence: 1,
                reason: None,
                raw_payload_policy: "MetadataOnly".to_owned(),
            },
            decode_outcome,
        }
    }

    fn session() -> ProviderSessionBindingRecord {
        ProviderSessionBindingRecord {
            binding_id: ProviderSessionBindingId("provider-session-binding:1".to_owned()),
            provider_instance_id: "codex:local-default".to_owned(),
            provider_service_id: "provider-service:codex".to_owned(),
            runtime_session_ref: "runtime-session:codex:1".to_owned(),
            provider_session_ref: Some("provider-session:codex:1".to_owned()),
            provider_thread_ref: Some("provider-thread:codex:1".to_owned()),
            lifecycle_state: ProviderSessionLifecycleState::Active,
            evidence_refs: vec!["evidence:session".to_owned()],
            repair_state: ProviderSessionRepairState::Healthy,
            provider_write_permitted: false,
            raw_provider_material_retained: false,
            secret_material_retained: false,
            live_handle_retained: false,
            task_mutation_permitted: false,
        }
    }

    fn decode_outcome(
        decode_status: CodexAppServerStdioDecodeStatus,
    ) -> CodexAppServerDecodeOutcomePersistenceRecord {
        let decoded_method = match &decode_status {
            CodexAppServerStdioDecodeStatus::Decoded { method } => Some(method.clone()),
            _ => None,
        };
        let unsupported_reason = match &decode_status {
            CodexAppServerStdioDecodeStatus::Unsupported { reason, .. } => Some(reason.clone()),
            _ => None,
        };

        CodexAppServerDecodeOutcomePersistenceRecord {
            outcome_id: "codex-stdio-decode-outcome:1".to_owned(),
            frame_source_id: "codex-frame-source:1".to_owned(),
            runtime_instance_id: "runtime-session:codex:1".to_owned(),
            sequence: 1,
            decode_status,
            decoded_method,
            supported: unsupported_reason.is_none(),
            parse_failure: None,
            unsupported_reason,
            observation_event_ref: Some("event:frame:1".to_owned()),
            evidence_refs: vec!["evidence:decode".to_owned()],
            shape_summary: "decode outcome".to_owned(),
            raw_json_rpc_payload_retained: false,
            raw_provider_payload_retained: false,
            provider_io_executed: false,
            task_mutation_permitted: false,
        }
    }
}
