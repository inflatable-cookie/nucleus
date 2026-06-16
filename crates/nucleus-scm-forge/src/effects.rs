//! Type-only SCM and forge runtime effect vocabulary.
//!
//! These records describe effect requests and outcomes. They do not execute,
//! schedule, poll, stream, persist, retry, cancel, or call providers.

use crate::ids::{ForgeAdapterInstanceId, ScmAdapterInstanceId};
use crate::links::{ForgeTaskLink, ScmTaskLink};
use crate::observations::{ForgeObservation, ScmObservation};

/// Stable adapter effect request id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AdapterEffectRequestId(pub String);

/// SCM or forge runtime effect request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterEffectRequest {
    pub id: AdapterEffectRequestId,
    pub adapter: AdapterEffectAdapter,
    pub kind: AdapterEffectRequestKind,
    pub cancellation: AdapterEffectCancellation,
}

/// Adapter surface that owns an effect request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterEffectAdapter {
    Scm(ScmAdapterInstanceId),
    Forge(ForgeAdapterInstanceId),
}

/// Effect request category.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterEffectRequestKind {
    RepositoryRefresh,
    WorktreeRefresh,
    BranchLikeRefRefresh,
    ProviderNeutralChangeRefresh,
    DirtyStateRefresh,
    ConflictDetection,
    WorkSessionLifecycle,
    ManagementStateCaptureCommandRequest,
    ReviewWorkflowPreparation,
    PullRequestRefresh,
    IssueRefresh,
    CommentRefresh,
    ReviewWorkflowRefresh,
    PollingRefresh,
    WebhookInputVerification,
    CredentialUseCheck,
    EventSubscription,
    Recovery,
    Custom(String),
}

/// Cancellation posture for an effect request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterEffectCancellation {
    NotRequested,
    Requested,
    CooperativeOnly,
    Unsupported,
}

/// Retry classification for an effect outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterEffectRetry {
    Retryable,
    NotRetryable,
    BlockedByPolicy,
    MissingCredential,
    ProviderRejected,
    TimedOut,
    Cancelled,
    Unsupported,
    Unknown,
}

/// Normalized SCM observation batch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmObservationBatch {
    pub request_id: AdapterEffectRequestId,
    pub observations: Vec<ScmObservation>,
    pub task_links: Vec<ScmTaskLink>,
}

/// Normalized forge observation batch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgeObservationBatch {
    pub request_id: AdapterEffectRequestId,
    pub observations: Vec<ForgeObservation>,
    pub task_links: Vec<ForgeTaskLink>,
}

/// Runtime effect outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterEffectOutcome {
    pub request_id: AdapterEffectRequestId,
    pub kind: AdapterEffectOutcomeKind,
    pub retry: AdapterEffectRetry,
    pub summary: Option<String>,
}

/// Runtime effect outcome payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterEffectOutcomeKind {
    Accepted,
    Rejected,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
    ScmObservations(ScmObservationBatch),
    ForgeObservations(ForgeObservationBatch),
    CommandAuthorityRequired,
    RecoveryRequired,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observations::{
        ForgeObservationId, ForgeObservationKind, ForgeRefreshMode, ObservationDedupeKey,
        ObservationEffect, ScmObservationId, ScmObservationKind,
    };

    #[test]
    fn scm_effect_request_composes_with_observation_batch() {
        let request_id = AdapterEffectRequestId("effect:scm-refresh".to_owned());
        let adapter_id = ScmAdapterInstanceId("scm:local-git".to_owned());

        let request = AdapterEffectRequest {
            id: request_id.clone(),
            adapter: AdapterEffectAdapter::Scm(adapter_id.clone()),
            kind: AdapterEffectRequestKind::RepositoryRefresh,
            cancellation: AdapterEffectCancellation::NotRequested,
        };

        let batch = ScmObservationBatch {
            request_id: request_id.clone(),
            observations: vec![ScmObservation {
                id: ScmObservationId("scm-observation:repo-seen".to_owned()),
                adapter_instance_id: adapter_id,
                observed_at: None,
                dedupe_key: Some(ObservationDedupeKey("repo:primary".to_owned())),
                effect: ObservationEffect::Informational,
                kind: ScmObservationKind::ManagementStateChanged,
            }],
            task_links: Vec::new(),
        };

        let outcome = AdapterEffectOutcome {
            request_id: request_id.clone(),
            kind: AdapterEffectOutcomeKind::ScmObservations(batch),
            retry: AdapterEffectRetry::NotRetryable,
            summary: Some("repository refresh produced normalized observations".to_owned()),
        };

        assert_eq!(request.id, request_id);
        assert_eq!(
            request.cancellation,
            AdapterEffectCancellation::NotRequested
        );
        assert!(matches!(request.adapter, AdapterEffectAdapter::Scm(_)));
        assert_eq!(outcome.request_id, request.id);
        assert_eq!(outcome.retry, AdapterEffectRetry::NotRetryable);
        assert!(matches!(
            outcome.kind,
            AdapterEffectOutcomeKind::ScmObservations(_)
        ));
    }

    #[test]
    fn forge_effect_request_composes_without_runtime_behavior() {
        let request_id = AdapterEffectRequestId("effect:forge-webhook".to_owned());
        let adapter_id = ForgeAdapterInstanceId("forge:github".to_owned());

        let request = AdapterEffectRequest {
            id: request_id.clone(),
            adapter: AdapterEffectAdapter::Forge(adapter_id.clone()),
            kind: AdapterEffectRequestKind::WebhookInputVerification,
            cancellation: AdapterEffectCancellation::CooperativeOnly,
        };

        let batch = ForgeObservationBatch {
            request_id: request_id.clone(),
            observations: vec![ForgeObservation {
                id: ForgeObservationId("forge-observation:webhook".to_owned()),
                adapter_instance_id: adapter_id,
                observed_at: None,
                refresh_mode: ForgeRefreshMode::Webhook,
                dedupe_key: Some(ObservationDedupeKey("webhook:delivery".to_owned())),
                effect: ObservationEffect::RequiresHumanReview,
                kind: ForgeObservationKind::WebhookReceived,
            }],
            task_links: Vec::new(),
        };

        let observation_outcome = AdapterEffectOutcome {
            request_id: request_id.clone(),
            kind: AdapterEffectOutcomeKind::ForgeObservations(batch),
            retry: AdapterEffectRetry::Retryable,
            summary: None,
        };
        let command_outcome = AdapterEffectOutcome {
            request_id: request_id.clone(),
            kind: AdapterEffectOutcomeKind::CommandAuthorityRequired,
            retry: AdapterEffectRetry::BlockedByPolicy,
            summary: Some(
                "webhook verification requires server-owned command authority".to_owned(),
            ),
        };

        assert_eq!(
            request.cancellation,
            AdapterEffectCancellation::CooperativeOnly
        );
        assert!(matches!(request.adapter, AdapterEffectAdapter::Forge(_)));
        assert_eq!(observation_outcome.request_id, request.id);
        assert_eq!(observation_outcome.retry, AdapterEffectRetry::Retryable);
        assert_eq!(command_outcome.retry, AdapterEffectRetry::BlockedByPolicy);
        assert!(matches!(
            command_outcome.kind,
            AdapterEffectOutcomeKind::CommandAuthorityRequired
        ));
    }
}
