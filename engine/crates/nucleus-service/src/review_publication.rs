use std::{num::NonZeroU64, time::SystemTime};

use nucleus_core::{
    Action, Forge, Observation, Observed, Phase, PullRequest, Report, Review, Run, Verdict,
    WaitReason,
};
use nucleus_forge::{ForgeError, GitHub, PullTarget, ReviewBinding, ReviewError, ReviewWrite};
use nucleus_store::{
    DispatchMode, GITHUB_HOST, ReviewIntent, ReviewPublication, ReviewPublicationOutcome, TaskRow,
};
use sha2::{Digest, Sha256};

use crate::{Service, ServiceError, event, github_accounts::ReviewerCredential};

// Give GitHub time to expose a review whose POST reply was lost.
const REVIEW_GRACE_MS: i64 = 30_000;
const FINAL_RETRY_DELAY_MS: i64 = 10 * 60_000;

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
    #[error("GitHub has not confirmed the review after three attempts. Use Move to review.")]
    AttemptsExhausted,
    #[error("{0}")]
    Blocked(String),
    #[error("The reviewed commit is no longer the open pull request head.")]
    StaleHead,
}

impl PublicationError {
    pub(super) fn wait(&self) -> (WaitReason, &str) {
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
            Self::Blocked(cause) => (WaitReason::ReviewPublicationBlocked, cause),
            Self::Refused => (
                WaitReason::ReviewPublicationBlocked,
                "GitHub refused the review. Inspect the pull request, then use Move to review.",
            ),
            Self::Unverified => (
                WaitReason::ReviewPublicationBlocked,
                "The recorded review could not be verified. Inspect the pull request, then use Move to review if needed.",
            ),
            Self::AttemptsExhausted => (
                WaitReason::ReviewPublicationBlocked,
                "GitHub has not confirmed the review after three attempts. Inspect the pull request, then use Move to review.",
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
    fn intent(&self, author: NonZeroU64, pull_author: NonZeroU64) -> ReviewIntent {
        ReviewIntent {
            instance: self.instance.into(),
            pull_url: self.pull.url.clone(),
            head: self.pull.head.clone(),
            decision: self.decision,
            author,
            pull_author,
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
            let mut audit = if updated.phase() == Phase::Closing {
                let mut audit = event("phase_reconciled");
                crate::presentation::note_merge(&mut audit, &observation.forge);
                audit
            } else {
                event("question_asked")
            };
            if audit.detail.is_empty() {
                audit.detail = serde_json::json!({"reason": "The pending review has no verified GitHub publication."}).to_string();
            }
            self.save(row, updated, &audit).await?;
            return Ok(action);
        }

        if let Some(record) = &publication
            && self
                .reconcile_before_retry(id, target, record, &request.body)
                .await?
        {
            return self.apply(row, observation, action).await;
        }
        let Some(publication) = self
            .start_review(id, target, &request, publication.as_ref())
            .await?
        else {
            return Ok(Action::Wait(WaitReason::Stopping));
        };
        if !self
            .reconcile_review(id, target, &publication, &request.body)
            .await?
        {
            return Err(PublicationError::UnknownDelivery.into());
        }
        self.apply(row, observation, action).await
    }

    async fn reconcile_before_retry(
        &self,
        task: &str,
        target: &PullTarget,
        record: &ReviewPublication,
        body: &ReviewBody,
    ) -> Result<bool, ServiceError> {
        use ReviewPublicationOutcome::{
            Deferred, FinalAttemptDeferred, Pending, ResubmissionDeferred, Resubmitted,
        };

        if let Deferred(until) | ResubmissionDeferred(until) | FinalAttemptDeferred(until) =
            record.outcome
            && SystemTime::now() < until
        {
            return Err(ForgeError::Deferred { until }.into());
        }
        let age = event("review_publication")
            .at
            .saturating_sub(record.recorded_at);
        if self.reconcile_review(task, target, record, body).await? {
            return Ok(true);
        }
        match record.outcome {
            Deferred(_) | ResubmissionDeferred(_) | FinalAttemptDeferred(_) => Ok(false),
            Resubmitted if age >= FINAL_RETRY_DELAY_MS => Ok(false),
            Pending if age >= REVIEW_GRACE_MS => Ok(false),
            _ => Err(PublicationError::UnknownDelivery.into()),
        }
    }

    async fn start_review(
        &self,
        task: &str,
        target: &PullTarget,
        request: &ReviewInput<'_>,
        previous: Option<&ReviewPublication>,
    ) -> Result<Option<ReviewPublication>, ServiceError> {
        let (author, selected, reviewer_client) = self.authenticated_reviewer().await?;
        if previous.is_some_and(|record| record.intent.author != author) {
            return Err(PublicationError::AccountUnavailable.into());
        }
        let pull_author = self
            .forge
            .review_preflight(target, &request.pull.head, author, request.decision)
            .await?;
        let intent = request.intent(author, pull_author);
        if previous.is_some_and(|record| record.intent != intent) {
            return Err(PublicationError::Unverified.into());
        }
        let Some(publication) = self
            .claim_publication(task, target, intent, &request.body, previous)
            .await?
        else {
            return Ok(None);
        };
        if matches!(publication.outcome, ReviewPublicationOutcome::Verified(_)) {
            return Ok(Some(publication));
        }
        let intent = &publication.intent;
        let claim = publication.outcome;
        let mut write = reviewer_client
            .as_ref()
            .unwrap_or(&self.forge)
            .submit_review(target, &binding(intent), &request.body.text)
            .await;
        if matches!(write, ReviewWrite::Http { status: 401, .. })
            && let Some(credential) = selected.as_ref()
        {
            match self
                .retry_unauthenticated_review(target, intent, credential, &request.body.text)
                .await
            {
                Ok(Some(retried)) => write = retried,
                Ok(None) => {
                    return self.defer_refused_review(task, intent, claim).await;
                }
                Err(_) if self.dispatch_mode().await == DispatchMode::Stopped => {
                    return self.defer_refused_review(task, intent, claim).await;
                }
                Err(ServiceError::Forge(ForgeError::Deferred { until })) => {
                    write = ReviewWrite::Deferred { until };
                }
                Err(error) => {
                    self.record_review_response(
                        task,
                        intent,
                        ReviewPublicationOutcome::AccessRefused,
                        write_cause(&write).as_deref(),
                    )
                    .await?;
                    return Err(error);
                }
            }
        }
        if matches!(write, ReviewWrite::Http { status: 401, .. })
            && self.dispatch_mode().await == DispatchMode::Stopped
        {
            return self.defer_refused_review(task, intent, claim).await;
        }
        self.settle_review_write(task, publication, write)
            .await
            .map(Some)
    }

    async fn settle_review_write(
        &self,
        task: &str,
        publication: ReviewPublication,
        write: ReviewWrite,
    ) -> Result<ReviewPublication, ServiceError> {
        let claim = publication.outcome;
        let resubmission = claim != ReviewPublicationOutcome::Pending;
        let intent = &publication.intent;
        let response = write_cause(&write);
        let acknowledged = matches!(&write, ReviewWrite::Verified(_));
        let outcome = match write {
            ReviewWrite::Verified(_) if resubmission => claim,
            ReviewWrite::Verified(review) => ReviewPublicationOutcome::Submitted(review.id),
            ReviewWrite::Http {
                status: 401 | 403 | 404,
                ..
            } => ReviewPublicationOutcome::AccessRefused,
            ReviewWrite::Http { status: 422, .. } => ReviewPublicationOutcome::Refused,
            ReviewWrite::Deferred { until } => {
                let deferred = if claim == ReviewPublicationOutcome::FinalAttempt {
                    ReviewPublicationOutcome::FinalAttemptDeferred(until)
                } else if resubmission {
                    ReviewPublicationOutcome::ResubmissionDeferred(until)
                } else {
                    ReviewPublicationOutcome::Deferred(until)
                };
                self.record_review(task, intent, deferred).await?;
                return Err(ForgeError::Deferred { until }.into());
            }
            ReviewWrite::Http { .. } | ReviewWrite::Unknown(_) => claim,
        };
        self.record_review_response(task, intent, outcome, response.as_deref())
            .await?;
        if !acknowledged && outcome == claim && claim != ReviewPublicationOutcome::FinalAttempt {
            return Err(PublicationError::UnknownDelivery.into());
        }
        Ok(ReviewPublication {
            outcome,
            response,
            ..publication
        })
    }

    async fn claim_publication(
        &self,
        task: &str,
        target: &PullTarget,
        intent: ReviewIntent,
        body: &ReviewBody,
        previous: Option<&ReviewPublication>,
    ) -> Result<Option<ReviewPublication>, ServiceError> {
        let existing = self
            .forge
            .find_review(target, &binding(&intent), &body.marker, &body.text)
            .await?;
        if let (Some(record), Some(review)) = (previous, &existing) {
            let outcome = ReviewPublicationOutcome::Verified(review.id);
            self.record_review(task, &intent, outcome).await?;
            return Ok(Some(ReviewPublication {
                outcome,
                ..record.clone()
            }));
        }
        let at = event("review_publication").at;
        let claim = {
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
            state
                .store
                .claim_review_publication(task, &intent, previous, at)?
                .ok_or(PublicationError::UnknownDelivery)?
        };
        let outcome = if let Some(review) = existing {
            let verified = ReviewPublicationOutcome::Verified(review.id);
            self.record_review(task, &intent, verified).await?;
            verified
        } else {
            claim
        };
        Ok(Some(ReviewPublication {
            intent,
            outcome,
            response: None,
            recorded_at: at,
        }))
    }

    async fn defer_refused_review(
        &self,
        task: &str,
        intent: &ReviewIntent,
        claim: ReviewPublicationOutcome,
    ) -> Result<Option<ReviewPublication>, ServiceError> {
        let outcome = match claim {
            ReviewPublicationOutcome::Resubmitted => ReviewPublicationOutcome::Pending,
            ReviewPublicationOutcome::FinalAttempt => {
                ReviewPublicationOutcome::FinalAttemptDeferred(SystemTime::now())
            }
            _ => return Ok(None),
        };
        self.record_review(task, intent, outcome).await?;
        Ok(None)
    }

    async fn authenticated_reviewer(
        &self,
    ) -> Result<(NonZeroU64, Option<ReviewerCredential>, Option<GitHub>), ServiceError> {
        let mut selected = self
            .github_accounts
            .reviewer_credential()
            .await
            .map_err(|_| PublicationError::AccountUnavailable)?;
        let mut reviewer_client = match &selected {
            Some(credential) => Some(self.reviewer_client(credential).await?),
            None => None,
        };
        let mut user = reviewer_client
            .as_ref()
            .unwrap_or(&self.forge)
            .authenticated_user()
            .await;
        if matches!(&user, Err(ForgeError::Status(status)) if status.as_u16() == 401)
            && let Some(credential) = selected.as_ref()
        {
            let refreshed = self.refresh_reviewer(credential).await?;
            let client = self.reviewer_client(&refreshed).await?;
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
        Ok((user.id, selected, reviewer_client))
    }

    // The prior 401 definitively refused the write. Unknown delivery never enters here.
    async fn retry_unauthenticated_review(
        &self,
        target: &PullTarget,
        intent: &ReviewIntent,
        credential: &ReviewerCredential,
        body: &str,
    ) -> Result<Option<ReviewWrite>, ServiceError> {
        if self.dispatch_mode().await == DispatchMode::Stopped {
            return Ok(None);
        }
        let refreshed = self.refresh_reviewer(credential).await?;
        let client = self.reviewer_client(&refreshed).await?;
        let user = client
            .authenticated_user()
            .await
            .map_err(reviewer_identity_error)?;
        if user.id != intent.author {
            return Err(PublicationError::AccountUnavailable.into());
        }
        let binding = binding(intent);
        if self
            .forge
            .review_preflight(target, &intent.head, intent.author, intent.decision)
            .await?
            != intent.pull_author
        {
            return Err(PublicationError::Unverified.into());
        }
        if self.dispatch_mode().await == DispatchMode::Stopped {
            return Ok(None);
        }
        Ok(Some(client.submit_review(target, &binding, body).await))
    }

    async fn reviewer_client(
        &self,
        credential: &ReviewerCredential,
    ) -> Result<GitHub, ServiceError> {
        if credential.host() != GITHUB_HOST {
            return Err(PublicationError::AccountUnavailable.into());
        }
        self.forge
            .with_review_bearer(
                credential.access_token(),
                NonZeroU64::new(credential.user_id())
                    .ok_or(PublicationError::AccountUnavailable)?,
            )
            .await
            .map_err(reviewer_identity_error)
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
        use ReviewPublicationOutcome::{
            AccessRefused, Deferred, FinalAttempt, FinalAttemptDeferred, Pending, Refused,
            ResubmissionDeferred, Resubmitted, Submitted, Verified,
        };

        let intent = &publication.intent;
        let binding = binding(intent);
        let review = match publication.outcome {
            Pending
            | Resubmitted
            | FinalAttempt
            | Deferred(_)
            | ResubmissionDeferred(_)
            | FinalAttemptDeferred(_) => {
                self.forge
                    .find_review(target, &binding, &body.marker, &body.text)
                    .await?
            }
            Submitted(id) | Verified(id) => Some(
                self.forge
                    .read_review(target, &binding, id)
                    .await
                    .map_err(verified_review_error)?,
            ),
            Refused => return Err(blocked_response(publication, PublicationError::Refused).into()),
            AccessRefused => {
                return Err(blocked_response(publication, PublicationError::AccessRefused).into());
            }
        };
        let Some(review) = review else {
            if publication.outcome == FinalAttempt {
                return Err(
                    blocked_response(publication, PublicationError::AttemptsExhausted).into(),
                );
            }
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
        self.record_review_response(task, intent, outcome, None)
            .await
    }

    async fn record_review_response(
        &self,
        task: &str,
        intent: &ReviewIntent,
        outcome: ReviewPublicationOutcome,
        response: Option<&str>,
    ) -> Result<(), ServiceError> {
        self.storage.database().verify()?;
        self.state.lock().await.store.record_review_publication(
            task,
            intent,
            outcome,
            response,
            event("review_publication").at,
        )?;
        Ok(())
    }
}

fn write_cause(write: &ReviewWrite) -> Option<String> {
    match write {
        ReviewWrite::Http { status, message } if message.is_empty() => {
            Some(format!("GitHub HTTP {status}"))
        }
        ReviewWrite::Http { status, message } => Some(format!("GitHub HTTP {status}: {message}")),
        ReviewWrite::Unknown(cause) => Some(cause.clone()),
        _ => None,
    }
}

fn blocked_response(record: &ReviewPublication, fallback: PublicationError) -> PublicationError {
    let Some(response) = &record.response else {
        return fallback;
    };
    PublicationError::Blocked(format!(
        "{} Last review POST to {}: {response}",
        fallback.wait().1,
        record.intent.pull_url
    ))
}

fn binding(intent: &ReviewIntent) -> ReviewBinding<'_> {
    ReviewBinding {
        author: intent.author,
        pull_author: intent.pull_author,
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
        ForgeError::Credential => PublicationError::AccountUnavailable.into(),
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

#[cfg(test)]
mod tests;
