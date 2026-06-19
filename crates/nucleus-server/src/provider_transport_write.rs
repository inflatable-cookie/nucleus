//! Provider transport write attempt records.
//!
//! These records represent attempts to write to provider transports. They do
//! not execute writes, retain raw provider payloads, or mutate task state.

use crate::provider_command_reactor::{
    ProviderCommandDispatchAttemptId, ProviderCommandId, ProviderCommandReactorOutcomeId,
};
use crate::provider_service_runtime::{ProviderCommandLaneId, ProviderServiceId};

/// Stable id for one provider transport write attempt.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderTransportWriteAttemptId(pub String);

/// Idempotency key for one provider transport write attempt.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderTransportWriteIdempotencyKey(pub String);

/// Provider transport target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderTransportWriteTarget {
    Stdio { endpoint_label: String },
    Http { endpoint_ref: String },
    WebSocket { endpoint_ref: String },
    Pty { terminal_ref: String },
    Custom { target_ref: String },
}

/// Input for creating a provider transport write attempt record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderTransportWriteAttemptInput {
    pub command_id: ProviderCommandId,
    pub dispatch_attempt_id: ProviderCommandDispatchAttemptId,
    pub reactor_outcome_id: ProviderCommandReactorOutcomeId,
    pub service_id: ProviderServiceId,
    pub command_lane_id: ProviderCommandLaneId,
    pub target: ProviderTransportWriteTarget,
    pub idempotency_key: ProviderTransportWriteIdempotencyKey,
    pub preflight_status: ProviderTransportWritePreflightStatus,
    pub payload_shape: ProviderTransportWritePayloadShape,
    pub evidence_refs: Vec<String>,
}

/// Preflight state entering a transport write attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderTransportWritePreflightStatus {
    Accepted,
    Blocked(String),
}

/// Payload retention posture for a provider write attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderTransportWritePayloadShape {
    MetadataOnly,
    EvidenceRefsOnly,
    RawPayloadRequested,
}

/// Provider transport write attempt record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderTransportWriteAttemptRecord {
    pub attempt_id: ProviderTransportWriteAttemptId,
    pub command_id: ProviderCommandId,
    pub dispatch_attempt_id: ProviderCommandDispatchAttemptId,
    pub reactor_outcome_id: ProviderCommandReactorOutcomeId,
    pub service_id: ProviderServiceId,
    pub command_lane_id: ProviderCommandLaneId,
    pub target: ProviderTransportWriteTarget,
    pub idempotency_key: ProviderTransportWriteIdempotencyKey,
    pub status: ProviderTransportWriteAttemptStatus,
    pub blockers: Vec<ProviderTransportWriteBlocker>,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub provider_write_executed: bool,
    pub task_mutation_permitted: bool,
}

/// Status of a provider transport write attempt record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderTransportWriteAttemptStatus {
    Queued,
    Blocked,
}

/// Why a transport write attempt is blocked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderTransportWriteBlocker {
    PreflightBlocked(String),
    RawPayloadRetentionNotAllowed,
    EmptyIdempotencyKey,
    EmptyTransportTarget,
}

/// Build a provider transport write attempt record without executing the write.
pub fn provider_transport_write_attempt(
    input: ProviderTransportWriteAttemptInput,
) -> ProviderTransportWriteAttemptRecord {
    let mut blockers = Vec::new();

    if let ProviderTransportWritePreflightStatus::Blocked(reason) = &input.preflight_status {
        blockers.push(ProviderTransportWriteBlocker::PreflightBlocked(
            reason.clone(),
        ));
    }
    if input.payload_shape == ProviderTransportWritePayloadShape::RawPayloadRequested {
        blockers.push(ProviderTransportWriteBlocker::RawPayloadRetentionNotAllowed);
    }
    if input.idempotency_key.0.is_empty() {
        blockers.push(ProviderTransportWriteBlocker::EmptyIdempotencyKey);
    }
    if transport_target_is_empty(&input.target) {
        blockers.push(ProviderTransportWriteBlocker::EmptyTransportTarget);
    }

    let status = if blockers.is_empty() {
        ProviderTransportWriteAttemptStatus::Queued
    } else {
        ProviderTransportWriteAttemptStatus::Blocked
    };

    ProviderTransportWriteAttemptRecord {
        attempt_id: ProviderTransportWriteAttemptId(format!(
            "provider-transport-write:{}",
            input.idempotency_key.0
        )),
        command_id: input.command_id,
        dispatch_attempt_id: input.dispatch_attempt_id,
        reactor_outcome_id: input.reactor_outcome_id,
        service_id: input.service_id,
        command_lane_id: input.command_lane_id,
        target: input.target,
        idempotency_key: input.idempotency_key,
        status,
        blockers,
        evidence_refs: input.evidence_refs,
        raw_payload_retained: false,
        provider_write_executed: false,
        task_mutation_permitted: false,
    }
}

fn transport_target_is_empty(target: &ProviderTransportWriteTarget) -> bool {
    match target {
        ProviderTransportWriteTarget::Stdio { endpoint_label } => endpoint_label.is_empty(),
        ProviderTransportWriteTarget::Http { endpoint_ref }
        | ProviderTransportWriteTarget::WebSocket { endpoint_ref } => endpoint_ref.is_empty(),
        ProviderTransportWriteTarget::Pty { terminal_ref } => terminal_ref.is_empty(),
        ProviderTransportWriteTarget::Custom { target_ref } => target_ref.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_write_attempt_is_queued_without_executing_write() {
        let record = provider_transport_write_attempt(input(
            ProviderTransportWritePreflightStatus::Accepted,
            ProviderTransportWritePayloadShape::MetadataOnly,
        ));

        assert_eq!(record.status, ProviderTransportWriteAttemptStatus::Queued);
        assert!(record.blockers.is_empty());
        assert_eq!(
            record.target,
            ProviderTransportWriteTarget::Stdio {
                endpoint_label: "stdio://codex-app-server".to_owned()
            }
        );
        assert!(!record.raw_payload_retained);
        assert!(!record.provider_write_executed);
        assert!(!record.task_mutation_permitted);
    }

    #[test]
    fn transport_write_attempt_blocks_preflight_and_raw_payload_requests() {
        let record = provider_transport_write_attempt(input(
            ProviderTransportWritePreflightStatus::Blocked("missing auth".to_owned()),
            ProviderTransportWritePayloadShape::RawPayloadRequested,
        ));

        assert_eq!(record.status, ProviderTransportWriteAttemptStatus::Blocked);
        assert!(record
            .blockers
            .contains(&ProviderTransportWriteBlocker::PreflightBlocked(
                "missing auth".to_owned()
            )));
        assert!(record
            .blockers
            .contains(&ProviderTransportWriteBlocker::RawPayloadRetentionNotAllowed));
        assert!(!record.provider_write_executed);
    }

    fn input(
        preflight_status: ProviderTransportWritePreflightStatus,
        payload_shape: ProviderTransportWritePayloadShape,
    ) -> ProviderTransportWriteAttemptInput {
        ProviderTransportWriteAttemptInput {
            command_id: ProviderCommandId("provider-command:1".to_owned()),
            dispatch_attempt_id: ProviderCommandDispatchAttemptId(
                "provider-command-dispatch:1".to_owned(),
            ),
            reactor_outcome_id: ProviderCommandReactorOutcomeId(
                "provider-command-outcome:1".to_owned(),
            ),
            service_id: ProviderServiceId("provider-service:codex".to_owned()),
            command_lane_id: ProviderCommandLaneId("provider-command-lane:codex".to_owned()),
            target: ProviderTransportWriteTarget::Stdio {
                endpoint_label: "stdio://codex-app-server".to_owned(),
            },
            idempotency_key: ProviderTransportWriteIdempotencyKey(
                "codex-turn-start:session:1:work:1".to_owned(),
            ),
            preflight_status,
            payload_shape,
            evidence_refs: vec!["evidence:preflight".to_owned()],
        }
    }
}
