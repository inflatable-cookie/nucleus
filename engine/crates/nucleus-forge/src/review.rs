use std::{num::NonZeroU64, time::SystemTime};

use nucleus_core::{Head, Review};
use serde::Deserialize;
use serde_json::json;

use crate::{ForgeError, GitHub, PullTarget, wire::PullState};

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
    Http { status: u16, message: String },
    Unknown(String),
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
    /// Pace a saved reviewer by its numeric account ID, including after token refresh.
    /// Callers verify the bearer identity before operating on its behalf.
    ///
    /// # Errors
    /// Returns an error if the bearer or client is invalid.
    pub async fn with_review_bearer(
        &self,
        bearer: &str,
        id: NonZeroU64,
    ) -> Result<Self, ForgeError> {
        let auth = Self::authorization(bearer)?;
        let mut accounts = self.accounts.lock().await;
        if accounts.is_empty() {
            let operator = self.authenticated_user().await?;
            accounts.insert(operator.id, self.account.clone());
        }
        let account = accounts.entry(id).or_default().clone();
        Ok(Self {
            client: self.client.clone(),
            origin: self.origin.clone(),
            auth,
            account,
            accounts: self.accounts.clone(),
            ancestors: tokio::sync::Mutex::default(),
        })
    }

    /// Bind a credential to its numeric GitHub identity before claiming a write.
    ///
    /// # Errors
    /// Returns an error when GitHub refuses the credential or returns unusable evidence.
    pub async fn authenticated_user(&self) -> Result<AuthenticatedGitHubUser, ForgeError> {
        let user: AuthenticatedGitHubUser = self.get(format!("{}/user", self.origin)).await?;
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
        let request = self
            .client
            .post(format!("{}/{}/reviews", self.origin, target.path()))
            .json(&json!({"commit_id": binding.head, "event": binding.event(), "body": body}));
        let response = self
            .request(request, true, |status, bytes, _| {
                if !status.is_success() {
                    #[derive(Deserialize)]
                    struct ErrorBody {
                        message: String,
                    }
                    let mut message = serde_json::from_slice::<ErrorBody>(bytes)
                        .map(|error| error.message)
                        .unwrap_or_default();
                    if let Some(token) = self
                        .auth
                        .to_str()
                        .ok()
                        .and_then(|auth| auth.strip_prefix("Bearer "))
                    {
                        message = message.replace(token, "[redacted]");
                    }
                    return Ok(ReviewWrite::Http {
                        status: status.as_u16(),
                        message: message
                            .chars()
                            .map(|ch| if ch.is_control() { ' ' } else { ch })
                            .take(300)
                            .collect(),
                    });
                }
                let receipt = crate::decode_json::<WireReview>(bytes);
                let message = match receipt {
                    Ok(review) => match binding.verify(review) {
                        Ok(verified) if verified.body == body => {
                            return Ok(ReviewWrite::Verified(verified));
                        }
                        _ => "Mismatched review receipt".to_owned(),
                    },
                    Err(error) => error.to_string(),
                };
                Ok(ReviewWrite::Http {
                    status: status.as_u16(),
                    message,
                })
            })
            .await;
        match response {
            Ok(write) => write,
            Err(ForgeError::Deferred { until }) => ReviewWrite::Deferred { until },
            Err(error) => ReviewWrite::Unknown(error.to_string()),
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
        let review: WireReview = self.get(url).await?;
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
            let reviews: Vec<WireReview> = self
                .get(format!("{url}?per_page={PAGE_SIZE}&page={page}"))
                .await?;
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
