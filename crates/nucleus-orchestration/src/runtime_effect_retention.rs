//! Compile-only runtime effect replay and retention policy vocabulary.
//!
//! These records describe replay durability, retention posture, compaction, and
//! deployment variance only. They do not implement storage, replay APIs, event
//! transport, subscriptions, artifact stores, scheduling, or runtime execution.

use nucleus_command_policy::{CommandArtifactRef, CommandEvidenceRef, CommandPolicyDecisionRef};
use nucleus_scm_forge::{
    AdapterCommandAuthorityRequestRef, AdapterObservationBatchRef, AdapterSanitizedEvidenceRef,
    AdapterTaskLinkProposalRef,
};

/// Replay durability for a runtime effect event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectReplayDurability {
    DurableReplay,
    TransientReconciliation,
}

/// Runtime effect event retention posture.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeEffectRetentionPolicy {
    pub durability: RuntimeEffectReplayDurability,
    pub ref_retention: Vec<RuntimeEffectRetainedRef>,
    pub compaction: RuntimeEffectCompactionPosture,
    pub deployment_profile: RuntimeEffectReplayDeploymentProfile,
    pub summary_retention: RuntimeEffectSummaryRetention,
}

/// Symbolic refs that must remain resolvable while retained events point to
/// them.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectRetainedRef {
    CommandEvidence(CommandEvidenceRef),
    CommandArtifact(CommandArtifactRef),
    CommandPolicyDecision(CommandPolicyDecisionRef),
    AdapterObservationBatch(AdapterObservationBatchRef),
    AdapterTaskLinkProposal(AdapterTaskLinkProposalRef),
    AdapterSanitizedEvidence(AdapterSanitizedEvidenceRef),
    AdapterCommandAuthorityRequest(AdapterCommandAuthorityRequestRef),
    PriorEffectRequest(String),
    NewEffectRequest(String),
    Custom(String),
}

/// Compaction posture for runtime effect events.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectCompactionPosture {
    NotCompactable,
    CompactAfterTerminalState,
    CompactAfterRecoveryState,
    CompactAfterDurableSuccessor,
}

/// Deployment profile that may influence replay retention windows later.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectReplayDeploymentProfile {
    LocalOnly,
    LocalNetwork,
    InternetReachable,
    ManagedRemote,
    Custom(String),
}

/// Summary retention posture.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectSummaryRetention {
    Discard,
    RetainSanitizedSummary,
    RetainSanitizedSummaryAfterRefsExpire,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durable_replay_policy_keeps_refs_without_storage_behavior() {
        let policy = RuntimeEffectRetentionPolicy {
            durability: RuntimeEffectReplayDurability::DurableReplay,
            ref_retention: vec![
                RuntimeEffectRetainedRef::CommandEvidence(CommandEvidenceRef(
                    "evidence:1".to_owned(),
                )),
                RuntimeEffectRetainedRef::AdapterObservationBatch(AdapterObservationBatchRef(
                    "observations:1".to_owned(),
                )),
            ],
            compaction: RuntimeEffectCompactionPosture::NotCompactable,
            deployment_profile: RuntimeEffectReplayDeploymentProfile::ManagedRemote,
            summary_retention: RuntimeEffectSummaryRetention::RetainSanitizedSummary,
        };

        assert_eq!(
            policy.durability,
            RuntimeEffectReplayDurability::DurableReplay
        );
        assert_eq!(policy.ref_retention.len(), 2);
        assert_eq!(
            policy.compaction,
            RuntimeEffectCompactionPosture::NotCompactable
        );
    }

    #[test]
    fn transient_reconciliation_policy_allows_compaction_without_raw_payloads() {
        let policy = RuntimeEffectRetentionPolicy {
            durability: RuntimeEffectReplayDurability::TransientReconciliation,
            ref_retention: vec![RuntimeEffectRetainedRef::PriorEffectRequest(
                "effect:prior".to_owned(),
            )],
            compaction: RuntimeEffectCompactionPosture::CompactAfterDurableSuccessor,
            deployment_profile: RuntimeEffectReplayDeploymentProfile::LocalOnly,
            summary_retention: RuntimeEffectSummaryRetention::RetainSanitizedSummaryAfterRefsExpire,
        };

        assert_eq!(
            policy.durability,
            RuntimeEffectReplayDurability::TransientReconciliation
        );
        assert_eq!(
            policy.compaction,
            RuntimeEffectCompactionPosture::CompactAfterDurableSuccessor
        );
    }
}
