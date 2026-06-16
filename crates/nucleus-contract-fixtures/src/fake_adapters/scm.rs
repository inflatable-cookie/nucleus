//! Dev-only SCM fake adapter surface.

use nucleus_scm_forge::{
    ObservationDedupeKey, ObservationEffect, ScmAdapterInstanceId, ScmObservation,
    ScmObservationId, ScmObservationKind, ScmTaskLink, ScmWorkflowSemantics,
};

use crate::scm_forge::{
    abandoned_review_workflow, convergence_like_workflow, credential_failure_evidence,
    fixture_repository_id, git_like_workflow, publication_task_link, scm_file_conflict,
    task_semantic_conflict,
};

/// Deterministic SCM fake for contract tests.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FakeScmAdapter {
    workflow: ScmWorkflowSemantics,
    observations: Vec<ScmObservation>,
    task_links: Vec<ScmTaskLink>,
}

impl FakeScmAdapter {
    /// Git-like fake surface.
    pub fn git_like() -> Self {
        Self::new(git_like_workflow())
    }

    /// Convergence-like fake surface.
    pub fn convergence_like() -> Self {
        Self::new(convergence_like_workflow())
    }

    /// Declared provider workflow semantics.
    pub fn workflow(&self) -> &ScmWorkflowSemantics {
        &self.workflow
    }

    /// Scripted SCM observations.
    pub fn observations(&self) -> &[ScmObservation] {
        &self.observations
    }

    /// Scripted provider-neutral task links.
    pub fn task_links(&self) -> &[ScmTaskLink] {
        &self.task_links
    }

    fn new(workflow: ScmWorkflowSemantics) -> Self {
        let file_conflict = scm_file_conflict();
        let task_conflict = task_semantic_conflict();
        let review = abandoned_review_workflow();

        Self {
            workflow,
            observations: vec![
                ScmObservation {
                    id: ScmObservationId("scm-observation-repository".to_owned()),
                    adapter_instance_id: ScmAdapterInstanceId("fake-scm".to_owned()),
                    observed_at: None,
                    dedupe_key: Some(ObservationDedupeKey("repo-fixture-main".to_owned())),
                    effect: ObservationEffect::Informational,
                    kind: ScmObservationKind::RepositorySeen(fixture_repository_id()),
                },
                ScmObservation {
                    id: ScmObservationId("scm-observation-credential".to_owned()),
                    adapter_instance_id: ScmAdapterInstanceId("fake-scm".to_owned()),
                    observed_at: None,
                    dedupe_key: Some(ObservationDedupeKey(
                        "credential-fixture-missing".to_owned(),
                    )),
                    effect: ObservationEffect::RequiresHumanReview,
                    kind: ScmObservationKind::CredentialUseFailed(credential_failure_evidence()),
                },
                ScmObservation {
                    id: ScmObservationId("scm-observation-file-conflict".to_owned()),
                    adapter_instance_id: ScmAdapterInstanceId("fake-scm".to_owned()),
                    observed_at: None,
                    dedupe_key: Some(ObservationDedupeKey(file_conflict.id.0.clone())),
                    effect: ObservationEffect::RequiresHumanReview,
                    kind: ScmObservationKind::ConflictDetected(file_conflict.id),
                },
                ScmObservation {
                    id: ScmObservationId("scm-observation-task-conflict".to_owned()),
                    adapter_instance_id: ScmAdapterInstanceId("fake-scm".to_owned()),
                    observed_at: None,
                    dedupe_key: Some(ObservationDedupeKey(task_conflict.id.0.clone())),
                    effect: ObservationEffect::RequiresHumanReview,
                    kind: ScmObservationKind::ConflictDetected(task_conflict.id),
                },
                ScmObservation {
                    id: ScmObservationId("scm-observation-review".to_owned()),
                    adapter_instance_id: ScmAdapterInstanceId("fake-scm".to_owned()),
                    observed_at: None,
                    dedupe_key: Some(ObservationDedupeKey(review.id.0.clone())),
                    effect: ObservationEffect::ProposesTaskHistorySummary,
                    kind: ScmObservationKind::ReviewWorkflowChanged(review.id),
                },
            ],
            task_links: vec![publication_task_link()],
        }
    }
}
