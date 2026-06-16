//! Dev-only forge fake adapter surface.

use nucleus_scm_forge::{
    ForgeAdapterInstanceId, ForgeObservation, ForgeObservationId, ForgeObservationKind,
    ForgeProviderKind, ForgeProviderRef, ForgePullRequestRef, ForgeRefreshMode, ForgeRepositoryRef,
    ObservationDedupeKey, ObservationEffect,
};

use crate::scm_forge::{
    abandoned_review_workflow, credential_failure_evidence, fixture_repository_id,
    rejected_webhook_evidence,
};

/// Deterministic forge fake for contract tests.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FakeForgeAdapter {
    observations: Vec<ForgeObservation>,
}

impl FakeForgeAdapter {
    /// Generic provider-neutral forge fake surface.
    pub fn generic() -> Self {
        let review = abandoned_review_workflow();

        Self {
            observations: vec![
                ForgeObservation {
                    id: ForgeObservationId("forge-observation-pr".to_owned()),
                    adapter_instance_id: ForgeAdapterInstanceId("fake-forge".to_owned()),
                    observed_at: None,
                    refresh_mode: ForgeRefreshMode::Polling,
                    dedupe_key: Some(ObservationDedupeKey("forge-pr-fixture".to_owned())),
                    effect: ObservationEffect::Informational,
                    kind: ForgeObservationKind::PullRequestSeen(fixture_pull_request()),
                },
                ForgeObservation {
                    id: ForgeObservationId("forge-observation-review".to_owned()),
                    adapter_instance_id: ForgeAdapterInstanceId("fake-forge".to_owned()),
                    observed_at: None,
                    refresh_mode: ForgeRefreshMode::Imported,
                    dedupe_key: Some(ObservationDedupeKey(review.id.0.clone())),
                    effect: ObservationEffect::ProposesTaskHistorySummary,
                    kind: ForgeObservationKind::ReviewWorkflowChanged(review.id),
                },
                ForgeObservation {
                    id: ForgeObservationId("forge-observation-webhook-rejected".to_owned()),
                    adapter_instance_id: ForgeAdapterInstanceId("fake-forge".to_owned()),
                    observed_at: None,
                    refresh_mode: ForgeRefreshMode::Webhook,
                    dedupe_key: Some(ObservationDedupeKey("webhook-fixture-main".to_owned())),
                    effect: ObservationEffect::RequiresHumanReview,
                    kind: ForgeObservationKind::WebhookRejected(rejected_webhook_evidence()),
                },
                ForgeObservation {
                    id: ForgeObservationId("forge-observation-credential".to_owned()),
                    adapter_instance_id: ForgeAdapterInstanceId("fake-forge".to_owned()),
                    observed_at: None,
                    refresh_mode: ForgeRefreshMode::ManualRefresh,
                    dedupe_key: Some(ObservationDedupeKey(
                        "credential-fixture-missing".to_owned(),
                    )),
                    effect: ObservationEffect::RequiresHumanReview,
                    kind: ForgeObservationKind::CredentialUseFailed(credential_failure_evidence()),
                },
            ],
        }
    }

    /// Scripted forge observations.
    pub fn observations(&self) -> &[ForgeObservation] {
        &self.observations
    }
}

fn fixture_pull_request() -> ForgePullRequestRef {
    ForgePullRequestRef {
        repository: ForgeRepositoryRef {
            provider_kind: ForgeProviderKind::Custom("fixture-forge".to_owned()),
            provider_ref: ForgeProviderRef("forge-repo-fixture".to_owned()),
            repository_id: Some(fixture_repository_id()),
            web_url: None,
        },
        provider_ref: ForgeProviderRef("forge-pr-fixture".to_owned()),
        number: Some(7),
        title: Some("Fixture review request".to_owned()),
        web_url: None,
    }
}
