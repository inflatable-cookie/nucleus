//! Compile-only SCM and forge runtime effect trait skeletons.
//!
//! These traits describe request acceptance and outcome reporting only. They do
//! not schedule work, execute commands, call networks, poll, stream, persist,
//! retry, cancel, verify webhooks, or mutate Nucleus state.

use crate::effects::{AdapterEffectOutcome, AdapterEffectRequest, AdapterEffectRequestId};
use crate::traits::AdapterReadiness;

/// SCM runtime effect request acceptance surface.
pub trait ScmRuntimeEffectAcceptanceSurface {
    fn runtime_readiness(&self) -> AdapterReadiness;
    fn accept_scm_effect(&self, request: &AdapterEffectRequest) -> AdapterEffectOutcome;
}

/// SCM runtime effect outcome reporting surface.
pub trait ScmRuntimeEffectOutcomeSurface {
    fn scm_effect_outcome(
        &self,
        request_id: &AdapterEffectRequestId,
    ) -> Option<AdapterEffectOutcome>;
}

/// Forge runtime effect request acceptance surface.
pub trait ForgeRuntimeEffectAcceptanceSurface {
    fn runtime_readiness(&self) -> AdapterReadiness;
    fn accept_forge_effect(&self, request: &AdapterEffectRequest) -> AdapterEffectOutcome;
}

/// Forge runtime effect outcome reporting surface.
pub trait ForgeRuntimeEffectOutcomeSurface {
    fn forge_effect_outcome(
        &self,
        request_id: &AdapterEffectRequestId,
    ) -> Option<AdapterEffectOutcome>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::{
        AdapterEffectAdapter, AdapterEffectCancellation, AdapterEffectOutcomeKind,
        AdapterEffectRequestKind, AdapterEffectRetry,
    };
    use crate::ids::{ForgeAdapterInstanceId, ScmAdapterInstanceId};

    struct StaticScmRuntimeEffectSurface {
        outcome: AdapterEffectOutcome,
    }

    impl ScmRuntimeEffectAcceptanceSurface for StaticScmRuntimeEffectSurface {
        fn runtime_readiness(&self) -> AdapterReadiness {
            AdapterReadiness::Ready
        }

        fn accept_scm_effect(&self, request: &AdapterEffectRequest) -> AdapterEffectOutcome {
            AdapterEffectOutcome {
                request_id: request.id.clone(),
                kind: AdapterEffectOutcomeKind::Accepted,
                retry: AdapterEffectRetry::NotRetryable,
                summary: Some("accepted without execution".to_owned()),
            }
        }
    }

    impl ScmRuntimeEffectOutcomeSurface for StaticScmRuntimeEffectSurface {
        fn scm_effect_outcome(
            &self,
            request_id: &AdapterEffectRequestId,
        ) -> Option<AdapterEffectOutcome> {
            (self.outcome.request_id == *request_id).then(|| self.outcome.clone())
        }
    }

    struct StaticForgeRuntimeEffectSurface {
        outcome: AdapterEffectOutcome,
    }

    impl ForgeRuntimeEffectAcceptanceSurface for StaticForgeRuntimeEffectSurface {
        fn runtime_readiness(&self) -> AdapterReadiness {
            AdapterReadiness::NeedsConfiguration
        }

        fn accept_forge_effect(&self, request: &AdapterEffectRequest) -> AdapterEffectOutcome {
            AdapterEffectOutcome {
                request_id: request.id.clone(),
                kind: AdapterEffectOutcomeKind::CommandAuthorityRequired,
                retry: AdapterEffectRetry::BlockedByPolicy,
                summary: Some("server command authority required".to_owned()),
            }
        }
    }

    impl ForgeRuntimeEffectOutcomeSurface for StaticForgeRuntimeEffectSurface {
        fn forge_effect_outcome(
            &self,
            request_id: &AdapterEffectRequestId,
        ) -> Option<AdapterEffectOutcome> {
            (self.outcome.request_id == *request_id).then(|| self.outcome.clone())
        }
    }

    #[test]
    fn scm_runtime_effect_traits_separate_acceptance_from_outcome_reporting() {
        let request_id = AdapterEffectRequestId("effect:scm-runtime".to_owned());
        let surface = StaticScmRuntimeEffectSurface {
            outcome: AdapterEffectOutcome {
                request_id: request_id.clone(),
                kind: AdapterEffectOutcomeKind::RecoveryRequired,
                retry: AdapterEffectRetry::Retryable,
                summary: Some("recovery needed after restart".to_owned()),
            },
        };
        let request = AdapterEffectRequest {
            id: request_id.clone(),
            adapter: AdapterEffectAdapter::Scm(ScmAdapterInstanceId("scm:test".to_owned())),
            kind: AdapterEffectRequestKind::RepositoryRefresh,
            cancellation: AdapterEffectCancellation::NotRequested,
        };

        let accepted = surface.accept_scm_effect(&request);
        let reported = surface.scm_effect_outcome(&request_id);

        assert_eq!(surface.runtime_readiness(), AdapterReadiness::Ready);
        assert!(matches!(accepted.kind, AdapterEffectOutcomeKind::Accepted));
        assert!(matches!(
            reported.map(|outcome| outcome.kind),
            Some(AdapterEffectOutcomeKind::RecoveryRequired)
        ));
    }

    #[test]
    fn forge_runtime_effect_traits_keep_command_authority_explicit() {
        let request_id = AdapterEffectRequestId("effect:forge-runtime".to_owned());
        let surface = StaticForgeRuntimeEffectSurface {
            outcome: AdapterEffectOutcome {
                request_id: request_id.clone(),
                kind: AdapterEffectOutcomeKind::TimedOut,
                retry: AdapterEffectRetry::TimedOut,
                summary: Some("provider call timed out".to_owned()),
            },
        };
        let request = AdapterEffectRequest {
            id: request_id.clone(),
            adapter: AdapterEffectAdapter::Forge(ForgeAdapterInstanceId("forge:test".to_owned())),
            kind: AdapterEffectRequestKind::WebhookInputVerification,
            cancellation: AdapterEffectCancellation::CooperativeOnly,
        };

        let accepted = surface.accept_forge_effect(&request);
        let reported = surface.forge_effect_outcome(&request_id);

        assert_eq!(
            surface.runtime_readiness(),
            AdapterReadiness::NeedsConfiguration
        );
        assert!(matches!(
            accepted.kind,
            AdapterEffectOutcomeKind::CommandAuthorityRequired
        ));
        assert!(matches!(
            reported.map(|outcome| outcome.retry),
            Some(AdapterEffectRetry::TimedOut)
        ));
    }
}
