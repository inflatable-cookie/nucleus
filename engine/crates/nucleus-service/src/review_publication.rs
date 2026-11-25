use std::num::NonZeroU64;

use nucleus_core::{
    Action, Forge, Observation, Observed, Phase, PullRequest, Report, Review, Run, Verdict,
    WaitReason,
};
use nucleus_forge::{ForgeError, GitHub, PullTarget, ReviewBinding, ReviewError, ReviewWrite};
use nucleus_store::{
    DispatchMode, ReviewIntent, ReviewPublication, ReviewPublicationOutcome, TaskRow,
};
use sha2::{Digest, Sha256};

use crate::{Service, ServiceError, event, github_accounts::ReviewerCredential};

#[derive(Debug, thiserror::Error)]
pub enum PublicationError {
    #[error("Choose a reviewer account different from the pull request author.")]
    SameAuthor,
    #[error("Check the reviewer account in Settings, then hold and release the task to retry.")]
    AccountUnavailable,
    #[error(
        "GitHub refused access to publish this review. Check the reviewer account and repository access, then use Move to review."
    )]
    AccessRefused,
    #[error("GitHub refused the review. Inspect the pull request, then use Move to review.")]
    Refused,
    #[error(
        "The recorded GitHub review could not be verified. Inspect the pull request, then use Move to review if another review is needed."
    )]
    Unverified,
    #[error("Review delivery is unconfirmed. Checking GitHub for the original review.")]
    UnknownDelivery,
    #[error("The reviewed commit is no longer the open pull request head.")]
    StaleHead,
}

impl PublicationError {
    pub(super) const fn wait(&self) -> (WaitReason, &'static str) {
        match self {
            Self::SameAuthor => (
                WaitReason::ReviewPublicationBlocked,
                "Select a reviewer account different from the pull request author, then hold and release the task.",
            ),
            Self::AccountUnavailable => (
                WaitReason::ReviewPublicationBlocked,
                "Check the reviewer account in Settings, then hold and release the task.",
            ),
            Self::AccessRefused => (
                WaitReason::ReviewPublicationBlocked,
                "GitHub refused access to publish the review. Check repository access for the reviewer account, then use Move to review.",
            ),
            Self::Refused => (
                WaitReason::ReviewPublicationBlocked,
                "GitHub refused the review. Inspect the pull request, then use Move to review.",
            ),
            Self::Unverified => (
                WaitReason::ReviewPublicationBlocked,
                "The recorded review could not be verified. Inspect the pull request, then use Move to review if needed.",
            ),
            Self::UnknownDelivery => (
                WaitReason::ForgeUnknown,
                "Review delivery is unconfirmed. Checking GitHub for the original review.",
            ),
            Self::StaleHead => (
                WaitReason::ForgeUnknown,
                "Checking the current pull request head.",
            ),
        }
    }
}

impl From<ReviewError> for ServiceError {
    fn from(error: ReviewError) -> Self {
        match error {
            ReviewError::SameAuthor => PublicationError::SameAuthor.into(),
            ReviewError::StaleHead => PublicationError::StaleHead.into(),
            ReviewError::Mismatched => PublicationError::Unverified.into(),
            ReviewError::Forge(error) => error.into(),
        }
    }
}

struct ReviewBody {
    marker: String,
    text: String,
    digest: String,
}

struct ReviewInput<'a> {
    instance: &'a str,
    pull: &'a PullRequest,
    decision: Review,
    body: ReviewBody,
}

impl ReviewInput<'_> {
    fn intent(&self, author: NonZeroU64) -> ReviewIntent {
        ReviewIntent {
            instance: self.instance.into(),
            pull_url: self.pull.url.clone(),
            head: self.pull.head.clone(),
            decision: self.decision,
            author,
            body_digest: self.body.digest.clone(),
        }
    }

    fn matches(&self, intent: &ReviewIntent) -> bool {
        self.instance == intent.instance
            && self.pull.url == intent.pull_url
            && self.pull.head == intent.head
            && self.decision == intent.decision
            && self.body.digest == intent.body_digest
    }
}

impl Service {
    pub(super) async fn apply_reviewer_transition(
        &self,
        row: &TaskRow,
        target: &PullTarget,
        observation: &Observation,
        action: Action,
    ) -> Result<Action, ServiceError> {
        let task = &row.task;
        let Some(run) = task.run() else {
            return self.apply(row, observation, action).await;
        };
        let Some(Report::Review {
            head,
            decision,
            summary,
            finding_titles,
        }) = run.report()
        else {
            return self.apply(row, observation, action).await;
        };
        let Observed::Known(Forge::Open { pr, .. } | Forge::Merged { pr, .. }) = &observation.forge
        else {
            return self.apply(row, observation, action).await;
        };
        if pr.head != *head {
            return self.apply(row, observation, action).await;
        }
        let _fence = self.effect(row).await?;
        let _projects = self.project_writes.read().await;
        let id = &task.identity().id;
        let request = ReviewInput {
            instance: &run.launch().instance,
            pull: pr,
            decision: *decision,
            body: review_body(run, summary, finding_titles),
        };
        let publication = self
            .state
            .lock()
            .await
            .store
            .review_publication(id, request.instance)?;
        if publication
            .as_ref()
            .is_some_and(|record| !request.matches(&record.intent))
        {
            return Err(PublicationError::Unverified.into());
        }

        if matches!(observation.forge, Observed::Known(Forge::Merged { .. })) {
            if request.decision == Review::Approve
                && let Some(record) = publication
            {
                match self
                    .reconcile_review(id, target, &record, &request.body)
                    .await
                {
                    Ok(true) => return self.apply(row, observation, action).await,
                    Ok(false) | Err(ServiceError::ReviewPublication(_)) => {}
                    Err(error) => return Err(error),
                }
            }
            let mut updated = task.clone();
            let action = updated.reconcile_external_merge_without_pending_review(observation);
            let mut audit = event("external_merge_without_published_review");
            if updated.phase() == Phase::Closing {
                crate::presentation::note_merge(&mut audit, &observation.forge);
            }
            self.save(row, updated, &audit).await?;
            return Ok(action);
        }

        let publication = match publication {
            Some(record) => record,
            None => {
                let Some(record) = self.start_review(id, target, &request).await? else {
                    return Ok(Action::Wait(WaitReason::Stopping));
                };
                record
            }
        };
        if !self
            .reconcile_review(id, target, &publication, &request.body)
            .await?
        {
            return Err(PublicationError::UnknownDelivery.into());
        }
        self.apply(row, observation, action).await
    }

    async fn start_review(
        &self,
        task: &str,
        target: &PullTarget,
        request: &ReviewInput<'_>,
    ) -> Result<Option<ReviewPublication>, ServiceError> {
        let mut selected = self
            .github_accounts
            .reviewer_credential()
            .await
            .map_err(|_| PublicationError::AccountUnavailable)?;
        let mut reviewer_client = selected
            .as_ref()
            .map(|credential| self.reviewer_client(credential))
            .transpose()?;
        let mut user = reviewer_client
            .as_ref()
            .unwrap_or(&self.forge)
            .authenticated_user()
            .await;
        if matches!(&user, Err(ForgeError::Status(status)) if status.as_u16() == 401)
            && let Some(credential) = selected.as_ref()
        {
            let refreshed = self.refresh_reviewer(credential).await?;
            let client = self.reviewer_client(&refreshed)?;
            user = client.authenticated_user().await;
            selected = Some(refreshed);
            reviewer_client = Some(client);
        }
        let user = user.map_err(reviewer_identity_error)?;
        if selected
            .as_ref()
            .is_some_and(|credential| credential.user_id() != user.id.get())
        {
            return Err(PublicationError::AccountUnavailable.into());
        }
        let intent = request.intent(user.id);
        self.forge
            .review_preflight(target, &binding(&intent))
            .await?;
        {
            let mut state = self.state.lock().await;
            if state
                .settings
                .dispatch
                .as_ref()
                .is_some_and(|settings| settings.mode == DispatchMode::Stopped)
            {
                return Ok(None);
            }
            self.storage.database().verify()?;
            if !state.store.claim_review_publication(
                task,
                &intent,
                event("review_publication").at,
            )? {
                return Err(PublicationError::UnknownDelivery.into());
            }
        }
        let mut write = reviewer_client
            .as_ref()
            .unwrap_or(&self.forge)
            .submit_review(target, &binding(&intent), &request.body.text)
            .await;
        if matches!(write, ReviewWrite::Unauthenticated)
            && let Some(credential) = selected.as_ref()
        {
            match self
                .retry_unauthenticated_review(target, &intent, credential, &request.body.text)
                .await
            {
                Ok(Some(retried)) => write = retried,
                Ok(None) => {
                    self.record_review(task, &intent, ReviewPublicationOutcome::AccessRefused)
                        .await?;
                    return Ok(None);
                }
                Err(error) => {
                    self.record_review(task, &intent, ReviewPublicationOutcome::AccessRefused)
                        .await?;
                    return Err(error);
                }
            }
        }
        let outcome = match write {
            ReviewWrite::Verified(review) => ReviewPublicationOutcome::Submitted(review.id),
            ReviewWrite::Unauthenticated | ReviewWrite::AccessRefused => {
                ReviewPublicationOutcome::AccessRefused
            }
            ReviewWrite::Refused => ReviewPublicationOutcome::Refused,
            ReviewWrite::Unknown => return Err(PublicationError::UnknownDelivery.into()),
        };
        self.record_review(task, &intent, outcome).await?;
        Ok(Some(ReviewPublication { intent, outcome }))
    }

    // The prior 401 definitively refused the write. Unknown delivery never enters here.
    async fn retry_unauthenticated_review(
        &self,
        target: &PullTarget,
        intent: &ReviewIntent,
        credential: &ReviewerCredential,
        body: &str,
    ) -> Result<Option<ReviewWrite>, ServiceError> {
        let refreshed = self.refresh_reviewer(credential).await?;
        let client = self.reviewer_client(&refreshed)?;
        let user = client
            .authenticated_user()
            .await
            .map_err(reviewer_identity_error)?;
        if user.id != intent.author {
            return Err(PublicationError::AccountUnavailable.into());
        }
        let binding = binding(intent);
        self.forge.review_preflight(target, &binding).await?;
        if self.dispatch_mode().await == DispatchMode::Stopped {
            return Ok(None);
        }
        Ok(Some(client.submit_review(target, &binding, body).await))
    }

    fn reviewer_client(&self, credential: &ReviewerCredential) -> Result<GitHub, PublicationError> {
        if credential.host() != "github.com" {
            return Err(PublicationError::AccountUnavailable);
        }
        self.forge
            .with_review_bearer(credential.access_token())
            .map_err(|_| PublicationError::AccountUnavailable)
    }

    async fn refresh_reviewer(
        &self,
        credential: &ReviewerCredential,
    ) -> Result<ReviewerCredential, PublicationError> {
        self.github_accounts
            .refresh_rejected(credential)
            .await
            .map_err(|_| PublicationError::AccountUnavailable)
    }

    async fn reconcile_review(
        &self,
        task: &str,
        target: &PullTarget,
        publication: &ReviewPublication,
        body: &ReviewBody,
    ) -> Result<bool, ServiceError> {
        use ReviewPublicationOutcome::{AccessRefused, Pending, Refused, Submitted, Verified};

        let intent = &publication.intent;
        let binding = binding(intent);
        let review = match publication.outcome {
            Pending => {
                self.forge
                    .find_review(target, &binding, &body.marker, &body.text)
                    .await?
            }
            Submitted(id) => Some(self.forge.read_review(target, &binding, id).await?),
            Verified(id) => Some(
                self.forge
                    .read_review(target, &binding, id)
                    .await
                    .map_err(verified_review_error)?,
            ),
            Refused => return Err(PublicationError::Refused.into()),
            AccessRefused => return Err(PublicationError::AccessRefused.into()),
        };
        let Some(review) = review else {
            return Ok(false);
        };
        if review.body != body.text {
            return Err(PublicationError::Unverified.into());
        }
        if publication.outcome != Verified(review.id) {
            self.record_review(task, intent, Verified(review.id))
                .await?;
        }
        Ok(true)
    }

    pub(super) async fn require_published_approval(
        &self,
        row: &TaskRow,
        target: &PullTarget,
    ) -> Result<(), ServiceError> {
        let task = &row.task;
        let Some(Verdict::Reviewed {
            head,
            decision: Review::Approve,
            ..
        }) = task.verdict()
        else {
            return Ok(());
        };
        let Some(instance) = task.applied_review_instance() else {
            return Ok(());
        };
        let publication = self
            .state
            .lock()
            .await
            .store
            .review_publication(&task.identity().id, &instance)?;
        let Some(publication) = publication else {
            // Approvals applied before publication shipped keep their original authority.
            return Ok(());
        };
        let intent = &publication.intent;
        let ReviewPublicationOutcome::Verified(review_id) = publication.outcome else {
            return Err(PublicationError::Unverified.into());
        };
        if intent.head != *head
            || intent.decision != Review::Approve
            || task
                .pull_request()
                .is_none_or(|pr| pr.url != intent.pull_url)
        {
            return Err(PublicationError::Unverified.into());
        }
        let review = self
            .forge
            .read_review(target, &binding(intent), review_id)
            .await
            .map_err(verified_review_error)?;
        if digest(&review.body) != intent.body_digest {
            return Err(PublicationError::Unverified.into());
        }
        Ok(())
    }

    async fn record_review(
        &self,
        task: &str,
        intent: &ReviewIntent,
        outcome: ReviewPublicationOutcome,
    ) -> Result<(), ServiceError> {
        self.storage.database().verify()?;
        self.state.lock().await.store.record_review_publication(
            task,
            intent,
            outcome,
            event("review_publication").at,
        )?;
        Ok(())
    }
}

fn binding(intent: &ReviewIntent) -> ReviewBinding<'_> {
    ReviewBinding {
        author: intent.author,
        head: &intent.head,
        decision: intent.decision,
    }
}

fn review_body(run: &Run, summary: &str, findings: &[String]) -> ReviewBody {
    let marker = format!("<!-- nucleus-review:{} -->", digest(&run.launch().instance));
    let mut body = summary.trim().replace("\r\n", "\n");
    if !findings.is_empty() {
        body.push_str("\n\nFindings\n");
        for title in findings {
            body.push_str("\n- ");
            body.push_str(title.trim());
        }
    }
    body.push_str("\n\n");
    body.push_str(&marker);
    ReviewBody {
        marker,
        digest: digest(&body),
        text: body,
    }
}

fn digest(body: &str) -> String {
    format!("{:x}", Sha256::digest(body.as_bytes()))
}

fn reviewer_identity_error(error: ForgeError) -> ServiceError {
    match error {
        ForgeError::Status(status) if matches!(status.as_u16(), 401 | 403 | 404) => {
            PublicationError::AccountUnavailable.into()
        }
        error => error.into(),
    }
}

fn verified_review_error(error: ReviewError) -> ServiceError {
    match error {
        ReviewError::Forge(ForgeError::Status(status)) if status.as_u16() == 404 => {
            PublicationError::Unverified.into()
        }
        error => error.into(),
    }
}
