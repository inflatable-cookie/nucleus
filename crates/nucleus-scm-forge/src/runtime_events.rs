//! Compile-only adapter runtime effect event payload vocabulary.
//!
//! These records describe sanitized adapter effect event payloads only. They do
//! not implement transport, subscriptions, persistence, replay, scheduling,
//! provider calls, or server event fan-out.

use crate::effects::{AdapterEffectAdapter, AdapterEffectRequestId, AdapterEffectRetry};
use crate::runtime_states::{AdapterEffectNonTerminalState, AdapterEffectTerminalState};

/// Symbolic ref to a normalized adapter observation batch.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AdapterObservationBatchRef(pub String);

/// Symbolic ref to an adapter task-link proposal set.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AdapterTaskLinkProposalRef(pub String);

/// Symbolic ref to sanitized adapter evidence (shared core type).
pub use nucleus_core::EvidenceRef as AdapterSanitizedEvidenceRef;

/// Symbolic ref to a server-owned command authority request.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AdapterCommandAuthorityRequestRef(pub String);

/// Sanitized adapter effect event payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterEffectEventPayload {
    pub request_id: AdapterEffectRequestId,
    pub adapter: AdapterEffectAdapter,
    pub kind: AdapterEffectEventKind,
    pub state: Option<AdapterEffectNonTerminalState>,
    pub terminal_state: Option<AdapterEffectTerminalState>,
    pub retry: Option<AdapterEffectRetry>,
    pub observation_batch_ref: Option<AdapterObservationBatchRef>,
    pub task_link_proposal_ref: Option<AdapterTaskLinkProposalRef>,
    pub sanitized_evidence_ref: Option<AdapterSanitizedEvidenceRef>,
    pub command_authority_request_ref: Option<AdapterCommandAuthorityRequestRef>,
    pub summary: Option<String>,
}

/// Adapter effect event kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterEffectEventKind {
    Requested,
    Accepted,
    Queued,
    Running,
    CancellationRequested,
    OutcomeReported,
    RetryScheduled,
    RecoveryRequired,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::ScmAdapterInstanceId;

    #[test]
    fn adapter_effect_event_payload_uses_symbolic_refs_without_raw_payloads() {
        let payload = AdapterEffectEventPayload {
            request_id: AdapterEffectRequestId("effect:adapter".to_owned()),
            adapter: AdapterEffectAdapter::Scm(ScmAdapterInstanceId("scm:test".to_owned())),
            kind: AdapterEffectEventKind::OutcomeReported,
            state: None,
            terminal_state: Some(AdapterEffectTerminalState::Succeeded),
            retry: Some(AdapterEffectRetry::NotRetryable),
            observation_batch_ref: Some(AdapterObservationBatchRef("observations:1".to_owned())),
            task_link_proposal_ref: Some(AdapterTaskLinkProposalRef("task-links:1".to_owned())),
            sanitized_evidence_ref: Some(AdapterSanitizedEvidenceRef("evidence:1".to_owned())),
            command_authority_request_ref: None,
            summary: Some("normalized adapter outcome".to_owned()),
        };

        assert_eq!(payload.kind, AdapterEffectEventKind::OutcomeReported);
        assert_eq!(
            payload.terminal_state,
            Some(AdapterEffectTerminalState::Succeeded)
        );
        assert!(payload.observation_batch_ref.is_some());
    }
}
