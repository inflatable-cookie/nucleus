//! Compile-only runtime effect storage boundary vocabulary.
//!
//! These records describe retained runtime effect event storage, replay
//! checkpoints, symbolic refs, and query posture only. They do not implement a
//! database, serialization, migrations, replay APIs, event transport,
//! subscriptions, artifact stores, scheduling, or runtime execution.

use nucleus_command_policy::{
    CommandArtifactRef, CommandEffectRequestId, CommandEvidenceRef, CommandPolicyDecisionRef,
};
use nucleus_scm_forge::{
    AdapterCommandAuthorityRequestRef, AdapterEffectRequestId, AdapterObservationBatchRef,
    AdapterSanitizedEvidenceRef, AdapterTaskLinkProposalRef,
};

use crate::host_identity::ServerEventId;
use crate::runtime_effect_events::ServerEventSequence;
use crate::runtime_effect_retention::{
    RuntimeEffectReplayDeploymentProfile, RuntimeEffectReplayDurability,
};

/// Stable id for a retained runtime effect storage record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RuntimeEffectStorageRecordId(pub String);

/// Stable id for a replay checkpoint.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RuntimeEffectReplayCheckpointId(pub String);

/// Retained runtime effect event record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeEffectStoredEventRecord {
    pub id: RuntimeEffectStorageRecordId,
    pub server_event_id: ServerEventId,
    pub sequence: ServerEventSequence,
    pub effect_request_ref: RuntimeEffectStorageRef,
    pub kind: RuntimeEffectStoredEventKind,
    pub durability: RuntimeEffectReplayDurability,
    pub deployment_profile: RuntimeEffectReplayDeploymentProfile,
    pub retained_refs: Vec<RuntimeEffectStorageRef>,
    pub summary: Option<String>,
}

/// Stored event category. Payload details remain behind retained refs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectStoredEventKind {
    Adapter,
    Command,
    Checkpoint,
    Custom(String),
}

/// Storage-backed or still-symbolic refs used by retained effect records.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectStorageRef {
    CommandEffectRequest(CommandEffectRequestId),
    AdapterEffectRequest(AdapterEffectRequestId),
    CommandEvidence(CommandEvidenceRef),
    CommandArtifact(CommandArtifactRef),
    CommandPolicyDecision(CommandPolicyDecisionRef),
    AdapterObservationBatch(AdapterObservationBatchRef),
    AdapterTaskLinkProposal(AdapterTaskLinkProposalRef),
    AdapterSanitizedEvidence(AdapterSanitizedEvidenceRef),
    AdapterCommandAuthorityRequest(AdapterCommandAuthorityRequestRef),
    ReplayCheckpoint(RuntimeEffectReplayCheckpointId),
    Custom(String),
}

/// Compacted replay checkpoint for an effect request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeEffectReplayCheckpoint {
    pub id: RuntimeEffectReplayCheckpointId,
    pub effect_request_ref: RuntimeEffectStorageRef,
    pub sequence: ServerEventSequence,
    pub latest_state: RuntimeEffectStoredEffectState,
    pub retained_refs: Vec<RuntimeEffectStorageRef>,
    pub summary: Option<String>,
}

/// Provider-neutral stored effect state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectStoredEffectState {
    Requested,
    Accepted,
    Queued,
    Running,
    ApprovalRequired,
    CancellationRequested,
    RecoveryRequired,
    Rejected,
    BlockedByPolicy,
    Unsupported,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
    Custom(String),
}

/// Query shapes storage must support before replay is implemented.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectStorageQuery {
    EventsByEffectRequest(RuntimeEffectStorageRef),
    EventsAfterSequence(ServerEventSequence),
    ResolveRetainedRef(RuntimeEffectStorageRef),
    LatestEffectState(RuntimeEffectLatestStateLookup),
    RetryLineage(RuntimeEffectRetryLineageRef),
    RecoveryRequiredEffects(RuntimeEffectRecoveryLookup),
}

/// Latest-state lookup request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeEffectLatestStateLookup {
    pub effect_request_ref: RuntimeEffectStorageRef,
}

/// Retry lineage refs. A retry is a new request, not mutation of the prior
/// outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeEffectRetryLineageRef {
    pub prior_effect_request_ref: RuntimeEffectStorageRef,
    pub new_effect_request_ref: RuntimeEffectStorageRef,
}

/// Recovery-required effect lookup posture.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeEffectRecoveryLookup {
    pub deployment_profile: RuntimeEffectReplayDeploymentProfile,
    pub include_transient_reconciliation: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_event_keeps_payloads_behind_refs() {
        let record = RuntimeEffectStoredEventRecord {
            id: RuntimeEffectStorageRecordId("stored:event:1".to_owned()),
            server_event_id: ServerEventId("event:1".to_owned()),
            sequence: ServerEventSequence(7),
            effect_request_ref: RuntimeEffectStorageRef::CommandEffectRequest(
                CommandEffectRequestId("effect:command:1".to_owned()),
            ),
            kind: RuntimeEffectStoredEventKind::Command,
            durability: RuntimeEffectReplayDurability::DurableReplay,
            deployment_profile: RuntimeEffectReplayDeploymentProfile::ManagedRemote,
            retained_refs: vec![
                RuntimeEffectStorageRef::CommandEvidence(CommandEvidenceRef(
                    "evidence:1".to_owned(),
                )),
                RuntimeEffectStorageRef::CommandArtifact(CommandArtifactRef(
                    "artifact:1".to_owned(),
                )),
            ],
            summary: Some("command evidence retained by ref".to_owned()),
        };

        assert_eq!(record.sequence, ServerEventSequence(7));
        assert_eq!(record.retained_refs.len(), 2);
        assert!(matches!(record.kind, RuntimeEffectStoredEventKind::Command));
    }

    #[test]
    fn checkpoint_preserves_terminal_state_and_retry_lineage_queries() {
        let prior = RuntimeEffectStorageRef::AdapterEffectRequest(AdapterEffectRequestId(
            "effect:adapter:old".to_owned(),
        ));
        let next = RuntimeEffectStorageRef::AdapterEffectRequest(AdapterEffectRequestId(
            "effect:adapter:new".to_owned(),
        ));

        let checkpoint = RuntimeEffectReplayCheckpoint {
            id: RuntimeEffectReplayCheckpointId("checkpoint:1".to_owned()),
            effect_request_ref: prior.clone(),
            sequence: ServerEventSequence(13),
            latest_state: RuntimeEffectStoredEffectState::RecoveryRequired,
            retained_refs: vec![RuntimeEffectStorageRef::AdapterObservationBatch(
                AdapterObservationBatchRef("observations:1".to_owned()),
            )],
            summary: Some("adapter effect needs recovery".to_owned()),
        };

        let query = RuntimeEffectStorageQuery::RetryLineage(RuntimeEffectRetryLineageRef {
            prior_effect_request_ref: prior,
            new_effect_request_ref: next,
        });

        assert_eq!(
            checkpoint.latest_state,
            RuntimeEffectStoredEffectState::RecoveryRequired
        );
        assert!(matches!(query, RuntimeEffectStorageQuery::RetryLineage(_)));
    }
}
