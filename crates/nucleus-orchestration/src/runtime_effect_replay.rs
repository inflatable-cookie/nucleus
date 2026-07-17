//! Compile-only runtime effect replay query vocabulary.
//!
//! These records describe client reconciliation queries and server response
//! shapes only. They do not implement transport, subscriptions, persistence,
//! replay execution, artifact storage, client caching, scheduling, or runtime
//! execution.

use crate::runtime_effect_events::ServerEventSequence;
use crate::runtime_effect_retention::RuntimeEffectReplayDeploymentProfile;
use crate::runtime_effect_storage::{
    RuntimeEffectLatestStateLookup, RuntimeEffectRecoveryLookup, RuntimeEffectReplayCheckpoint,
    RuntimeEffectRetryLineageRef, RuntimeEffectStorageQuery, RuntimeEffectStorageRef,
    RuntimeEffectStoredEffectState, RuntimeEffectStoredEventRecord,
};

/// Client-held ordering token for replay reconciliation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeEffectClientOrderingToken {
    pub sequence: ServerEventSequence,
    pub storage_generation: RuntimeEffectReplayStorageGeneration,
}

/// Storage generation posture for replay tokens and responses.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectReplayStorageGeneration {
    Current(String),
    Compacted(String),
    Expired(String),
    Migrated { from: String, to: String },
    Unsupported(String),
    Unknown,
}

/// Replay query request. This is transport-neutral.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeEffectReplayQueryRequest {
    pub query: RuntimeEffectStorageQuery,
    pub client_token: Option<RuntimeEffectClientOrderingToken>,
    pub deployment_profile: RuntimeEffectReplayDeploymentProfile,
}

/// Replay query response. Results may be partial and must say so.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeEffectReplayQueryResponse {
    pub status: RuntimeEffectReplayQueryStatus,
    pub storage_generation: RuntimeEffectReplayStorageGeneration,
    pub results: Vec<RuntimeEffectReplayQueryResult>,
}

/// Replay query status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectReplayQueryStatus {
    Complete,
    Partial { reason: String },
    Unsupported(RuntimeEffectReplayUnsupportedReason),
}

/// Unsupported replay query reason.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectReplayUnsupportedReason {
    UnsupportedQuery,
    UnsupportedStorageGeneration,
    TokenTooOld,
    RefUnsupported,
    Custom(String),
}

/// Replay query result item.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectReplayQueryResult {
    StoredEvent(RuntimeEffectStoredEventRecord),
    Checkpoint(RuntimeEffectReplayCheckpoint),
    LatestState {
        lookup: RuntimeEffectLatestStateLookup,
        state: RuntimeEffectStoredEffectState,
    },
    RetryLineage(RuntimeEffectRetryLineageRef),
    RecoveryRequired(RuntimeEffectRecoveryLookup),
    RefResolution(RuntimeEffectReplayRefResolution),
}

/// Retained-ref resolution result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectReplayRefResolution {
    Resolved(RuntimeEffectStorageRef),
    Missing(RuntimeEffectStorageRef),
    Expired(RuntimeEffectStorageRef),
    Unsupported(RuntimeEffectStorageRef),
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_command_policy::CommandEffectRequestId;

    #[test]
    fn replay_query_token_is_client_hint_not_transport() {
        let request = RuntimeEffectReplayQueryRequest {
            query: RuntimeEffectStorageQuery::EventsAfterSequence(ServerEventSequence(41)),
            client_token: Some(RuntimeEffectClientOrderingToken {
                sequence: ServerEventSequence(40),
                storage_generation: RuntimeEffectReplayStorageGeneration::Current(
                    "generation:1".to_owned(),
                ),
            }),
            deployment_profile: RuntimeEffectReplayDeploymentProfile::LocalNetwork,
        };

        assert!(matches!(
            request.query,
            RuntimeEffectStorageQuery::EventsAfterSequence(ServerEventSequence(41))
        ));
        assert!(request.client_token.is_some());
    }

    #[test]
    fn replay_response_can_report_partial_results_and_missing_refs() {
        let missing_ref = RuntimeEffectStorageRef::CommandEffectRequest(CommandEffectRequestId(
            "effect:missing".to_owned(),
        ));

        let response = RuntimeEffectReplayQueryResponse {
            status: RuntimeEffectReplayQueryStatus::Partial {
                reason: "storage generation compacted".to_owned(),
            },
            storage_generation: RuntimeEffectReplayStorageGeneration::Compacted(
                "generation:old".to_owned(),
            ),
            results: vec![RuntimeEffectReplayQueryResult::RefResolution(
                RuntimeEffectReplayRefResolution::Missing(missing_ref),
            )],
        };

        assert!(matches!(
            response.status,
            RuntimeEffectReplayQueryStatus::Partial { .. }
        ));
        assert_eq!(response.results.len(), 1);
    }
}
