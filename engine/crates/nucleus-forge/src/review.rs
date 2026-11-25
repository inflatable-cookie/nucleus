use std::{num::NonZeroU64, time::SystemTime};

use nucleus_core::{Head, Review};
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::json;

use crate::{ForgeError, GitHub, PullTarget, decode, wire::PullState};

const PAGE_SIZE: usize = 30;
const MAX_PAGES: usize = 100;

#[derive(Debug, Deserialize)]
pub struct AuthenticatedGitHubUser {
    pub id: NonZeroU64,
    pub login: String,
}

/// The authenticated reviewer and exact verdict this request may operate on.
pub struct ReviewBinding<'a> {
    pub author: NonZeroU64,
    pub pull_author: NonZeroU64,
    pub head: &'a Head,
    pub decision: Review,
}

#[derive(Debug)]
pub struct VerifiedReview {
    pub id: NonZeroU64,
    pub body: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ReviewError {
    #[error("Choose a reviewer account different from the pull request author.")]
    SameAuthor,
    #[error("The reviewed commit is no longer the open pull request head.")]
    StaleHead,
    #[error("The GitHub review does not match the recorded author, commit, verdict, and body.")]
    Mismatched,
    #[error(transparent)]
    Forge(#[from] ForgeError),
}

#[derive(Debug)]
pub enum ReviewWrite {
    Verified(VerifiedReview),
    Deferred { until: SystemTime },
    Unauthenticated,
    AccessRefused,
    Refused,
    Unknown,
}

#[derive(Deserialize)]
struct WireReview {
    id: NonZeroU64,
    user: Option<AuthenticatedGitHubUser>,
    commit_id: Option<Head>,
    state: String,
    body: Option<String>,
}

impl ReviewBinding<'_> {
    fn event(&self) -> &'static str {
        match self.decision {
            Review::Approve => "APPROVE",
            Review::Changes if self.author == self.pull_author => "COMMENT",
            Review::Changes => "REQUEST_CHANGES",
        }
    }

    fn state(&self) -> &'static str {
        match self.decision {
            Review::Approve => "APPROVED",
            Review::Changes if self.author == self.pull_author => "COMMENTED",
            Review::Changes => "CHANGES_REQUESTED",
        }
    }

    fn verify(&self, review: WireReview) -> Result<VerifiedReview, ReviewError> {
        if review.user.as_ref().map(|user| user.id) != Some(self.author)
            || review.commit_id.as_ref() != Some(self.head)
            || review.state != self.state()
        {
            return Err(ReviewError::Mismatched);
        }
        let body = review.body.ok_or(ReviewError::Mismatched)?;
        Ok(VerifiedReview {
            id: review.id,
            body,
        })
    }
}

impl GitHub {
    /// Use a reviewer bearer on the same forge origin, without modifying this client.
    ///
    /// # Errors
    /// Returns an error if the bearer or client is invalid.
    pub fn with_review_bearer(&self, bearer: &str) -> Result<Self, ForgeError> {
        Self::with_origin(bearer, self.origin.clone())
    }

    /// Bind a credential to its numeric GitHub identity before claiming a write.
    ///
    /// # Errors
    /// Returns an error when GitHub refuses the credential or returns unusable evidence.
    pub async fn authenticated_user(&self) -> Result<AuthenticatedGitHubUser, ForgeError> {
        let response = self
            .client
            .get(format!("{}/user", self.origin))
            .send()
            .await?;
        let user: AuthenticatedGitHubUser = decode(response).await?;
        if user.login.trim().is_empty() {
            return Err(ForgeError::Incomplete);
        }
        Ok(user)
    }

    /// Verify the PR's current head and enforce distinct approval authors.
    ///
    /// # Errors
    /// Returns an error if GitHub cannot verify the PR or its approval author.
    pub async fn review_preflight(
        &self,
        target: &PullTarget,
        head: &Head,
        reviewer: NonZeroU64,
        decision: Review,
    ) -> Result<NonZeroU64, ReviewError> {
        let pull = self.pull(target).await?;
        if pull.state != PullState::Open || pull.merged || pull.head.sha != *head {
            return Err(ReviewError::StaleHead);
        }
        let author = pull.user.ok_or(ForgeError::Incomplete)?.id;
        if decision == Review::Approve && reviewer == author {
            return Err(ReviewError::SameAuthor);
        }
        Ok(author)
    }

    /// Submit one review after the caller has durably claimed this exact intent.
    /// The client disables HTTP retries. Callers must reconcile unknown delivery.
    pub async fn submit_review(
        &self,
        target: &PullTarget,
        binding: &ReviewBinding<'_>,
        body: &str,
    ) -> ReviewWrite {
        let Ok(response) = self
            .client
            .post(format!("{}/{}/reviews", self.origin, target.path()))
            .json(&json!({"commit_id": binding.head, "event": binding.event(), "body": body}))
            .send()
            .await
        else {
            return ReviewWrite::Unknown;
        };
        let status = response.status();
        match decode::<WireReview>(response).await {
            // Quota headers can also accompany a successful or ambiguous POST.
            Err(ForgeError::Deferred { until })
                if matches!(
                    status,
                    StatusCode::TOO_MANY_REQUESTS | StatusCode::FORBIDDEN
                ) =>
            {
                ReviewWrite::Deferred { until }
            }
            Ok(review) => match binding.verify(review) {
                Ok(verified) if verified.body == body => ReviewWrite::Verified(verified),
                _ => ReviewWrite::Unknown,
            },
            Err(ForgeError::Status(StatusCode::UNAUTHORIZED)) => ReviewWrite::Unauthenticated,
            Err(ForgeError::Status(StatusCode::FORBIDDEN | StatusCode::NOT_FOUND)) => {
                ReviewWrite::AccessRefused
            }
            Err(ForgeError::Status(StatusCode::UNPROCESSABLE_ENTITY)) => ReviewWrite::Refused,
            Err(_) => ReviewWrite::Unknown,
        }
    }

    /// Verify the known review ID under the exact author, head and verdict.
    ///
    /// # Errors
    /// Returns an error for missing, unreadable or inconsistent remote evidence.
    pub async fn read_review(
        &self,
        target: &PullTarget,
        binding: &ReviewBinding<'_>,
        id: NonZeroU64,
    ) -> Result<VerifiedReview, ReviewError> {
        let url = format!("{}/{}/reviews/{id}", self.origin, target.path());
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(ForgeError::from)?;
        let review: WireReview = decode(response).await?;
        if review.id != id {
            return Err(ReviewError::Mismatched);
        }
        binding.verify(review)
    }

    /// Reconcile an existing intent using its exact marker and body.
    ///
    /// # Errors
    /// Returns an error for a mismatched marker or an incomplete inventory.
    pub async fn find_review(
        &self,
        target: &PullTarget,
        binding: &ReviewBinding<'_>,
        marker: &str,
        body: &str,
    ) -> Result<Option<VerifiedReview>, ReviewError> {
        let url = format!("{}/{}/reviews", self.origin, target.path());
        let mut foreign_marker = false;
        for page in 1..=MAX_PAGES {
            let response = self
                .client
                .get(format!("{url}?per_page={PAGE_SIZE}&page={page}"))
                .send()
                .await
                .map_err(ForgeError::from)?;
            let reviews: Vec<WireReview> = decode(response).await?;
            let last_page = reviews.len() < PAGE_SIZE;
            // GitHub lists reviews in chronological order. Retain the earliest
            // exact review if a duplicate is present.
            for review in reviews {
                if !review
                    .body
                    .as_deref()
                    .is_some_and(|body| body.lines().any(|line| line == marker))
                {
                    continue;
                }
                foreign_marker = true;
                if review.user.as_ref().map(|user| user.id) == Some(binding.author) {
                    let verified = binding.verify(review)?;
                    if verified.body != body {
                        return Err(ReviewError::Mismatched);
                    }
                    return Ok(Some(verified));
                }
            }
            if last_page {
                return if foreign_marker {
                    Err(ReviewError::Mismatched)
                } else {
                    Ok(None)
                };
            }
        }
        Err(ForgeError::Incomplete.into())
    }
}
