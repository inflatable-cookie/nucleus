//! Observe GitHub pull requests and merge only at the authorized head.

mod wire;

use std::time::Duration;

use nucleus_core::{Action, Forge, Observation, Observed, Task, decide};
use reqwest::{
    Client, Response, StatusCode, Url,
    header::{ACCEPT, AUTHORIZATION, HeaderMap, HeaderValue},
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::json;
use wire::{GraphReply, Pull, PullState};

const BODY_LIMIT: usize = 2 * 1024 * 1024;
const API_VERSION: &str = "2026-03-10";
const CHECKS_QUERY: &str = "query($owner:String!,$repo:String!,$number:Int!){\
  repository(owner:$owner,name:$repo){pullRequest(number:$number){\
  headRefOid baseRefName isDraft state mergeable mergeStateStatus reviewDecision\
  statusCheckRollup{state} reviewThreads(first:100){nodes{isResolved}pageInfo{hasNextPage}}\
  }}}";

#[derive(Debug, thiserror::Error)]
pub enum ForgeError {
    #[error("pull request identity does not match the configured repository and branches")]
    Identity,
    #[error("more than one open pull request matches the task branch")]
    Ambiguous,
    #[error("GitHub credential cannot be used as a bearer")]
    Credential,
    #[error("GitHub returned an incomplete or inconsistent response")]
    Incomplete,
    #[error("GitHub response exceeded the read limit")]
    Oversize,
    #[error("GitHub refused the merge with HTTP {0}")]
    Refused(StatusCode),
    #[error("GitHub request failed")]
    Http(#[from] reqwest::Error),
    #[error("GitHub response could not be decoded")]
    Decode(#[from] serde_json::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Branches {
    owner: String,
    repository: String,
    base: String,
    head: String,
}

impl Branches {
    /// Bind repository identity and both branch names before reading a PR.
    ///
    /// # Errors
    /// Returns an error for an invalid repository or empty branch names.
    pub fn new(repository: &str, base: &str, head: &str) -> Result<Self, ForgeError> {
        let (owner, name) = repository.split_once('/').ok_or(ForgeError::Identity)?;
        let component = |value: &str| {
            !value.is_empty()
                && value != "."
                && value != ".."
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        };
        if !component(owner) || !component(name) || base.is_empty() || head.is_empty() {
            return Err(ForgeError::Identity);
        }
        Ok(Self {
            owner: owner.into(),
            repository: name.into(),
            base: base.into(),
            head: head.into(),
        })
    }

    fn matches_repository(&self, value: &str) -> bool {
        value.split_once('/').is_some_and(|(owner, repository)| {
            self.owner.eq_ignore_ascii_case(owner)
                && self.repository.eq_ignore_ascii_case(repository)
        })
    }

    /// Parse a pull request URL from the configured repository.
    ///
    /// # Errors
    /// Returns an error unless the URL names a GitHub PR in this repository.
    pub fn target(&self, value: &str) -> Result<PullTarget, ForgeError> {
        let url = Url::parse(value).map_err(|_| ForgeError::Identity)?;
        if url.scheme() != "https"
            || url.host_str() != Some("github.com")
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(ForgeError::Identity);
        }
        let parts = url
            .path_segments()
            .ok_or(ForgeError::Identity)?
            .collect::<Vec<_>>();
        let [owner, repo, "pull", number] = parts.as_slice() else {
            return Err(ForgeError::Identity);
        };
        let number = number.parse::<i32>().map_err(|_| ForgeError::Identity)?;
        if number <= 0
            || !self.owner.eq_ignore_ascii_case(owner)
            || !self.repository.eq_ignore_ascii_case(repo)
        {
            return Err(ForgeError::Identity);
        }
        Ok(PullTarget {
            branches: self.clone(),
            number,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullTarget {
    branches: Branches,
    number: i32,
}

impl PullTarget {
    fn path(&self) -> String {
        format!(
            "repos/{}/{}/pulls/{}",
            self.branches.owner, self.branches.repository, self.number
        )
    }

    fn verify(&self, pull: &Pull) -> Result<(), ForgeError> {
        if pull.number != self.number
            || self.branches.target(&pull.html_url)? != *self
            || pull.base.branch != self.branches.base
            || pull.head.branch != self.branches.head
            || ![&pull.base, &pull.head].into_iter().all(|git_ref| {
                git_ref
                    .repo
                    .as_ref()
                    .is_some_and(|repo| self.branches.matches_repository(&repo.full_name))
            })
        {
            return Err(ForgeError::Identity);
        }
        Ok(())
    }
}

pub struct GitHub {
    client: Client,
    origin: String,
}

impl GitHub {
    /// Configure the GitHub client using a caller-owned bearer.
    ///
    /// # Errors
    /// Returns an error if the bearer or HTTP client cannot be configured.
    pub fn new(bearer: &str) -> Result<Self, ForgeError> {
        Self::with_origin(bearer, "https://api.github.com".into())
    }

    fn with_origin(bearer: &str, origin: String) -> Result<Self, ForgeError> {
        if bearer.is_empty() {
            return Err(ForgeError::Credential);
        }
        let mut auth = HeaderValue::from_str(&format!("Bearer {bearer}"))
            .map_err(|_| ForgeError::Credential)?;
        auth.set_sensitive(true);
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, auth);
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github+json"),
        );
        headers.insert(
            "x-github-api-version",
            HeaderValue::from_static(API_VERSION),
        );
        let client = Client::builder()
            .default_headers(headers)
            .user_agent("nucleus-engine")
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(15))
            .build()?;
        Ok(Self { origin, client })
    }

    /// Find the open PR on a task branch before a worker report is available.
    ///
    /// # Errors
    /// Returns an error for an ambiguous list or unreadable response.
    pub async fn find_open(&self, branches: &Branches) -> Result<Option<PullTarget>, ForgeError> {
        #[derive(Deserialize)]
        struct Listed {
            html_url: String,
        }
        let mut url = Url::parse(&format!(
            "{}/repos/{}/{}/pulls",
            self.origin, branches.owner, branches.repository
        ))
        .map_err(|_| ForgeError::Incomplete)?;
        let head = format!("{}:{}", branches.owner, branches.head);
        url.query_pairs_mut().extend_pairs([
            ("state", "open"),
            ("head", &head),
            ("base", &branches.base),
            ("per_page", "2"),
        ]);
        let response = self.client.get(url).send().await?;
        let listed: Vec<Listed> = decode(response).await?;
        match listed.as_slice() {
            [] => Ok(None),
            [pull] => Ok(Some(branches.target(&pull.html_url)?)),
            _ => Err(ForgeError::Ambiguous),
        }
    }

    /// Read PR identity, current head, check state and any merge commit.
    ///
    /// # Errors
    /// Returns an error when evidence is unreadable, incomplete, or bound to
    /// another branch, repository or head. The engine treats errors as unknown.
    pub async fn observe(&self, target: &PullTarget) -> Result<Forge, ForgeError> {
        let url = format!("{}/{}", self.origin, target.path());
        let pull: Pull = decode(self.client.get(url).send().await?).await?;
        target.verify(&pull)?;
        let pr = nucleus_core::PullRequest {
            url: pull.html_url,
            head: pull.head.sha,
        };
        match (pull.merged, pull.state) {
            (true, PullState::Closed) => Ok(Forge::Merged {
                pr,
                commit: pull.merge_commit_sha.ok_or(ForgeError::Incomplete)?,
            }),
            (false, PullState::Closed) => Ok(Forge::Closed(pr)),
            (false, PullState::Open) => {
                let response = self.client.post(format!("{}/graphql", self.origin)).json(&json!({
                    "query": CHECKS_QUERY,
                    "variables": { "owner": target.branches.owner, "repo": target.branches.repository, "number": target.number },
                })).send().await?;
                let graph: GraphReply = decode(response).await?;
                let checks = graph.checks(&pr.head, &target.branches.base)?;
                Ok(Forge::Open { pr, checks })
            }
            (true, PullState::Open) => Err(ForgeError::Incomplete),
        }
    }

    /// Recheck the merge decision against fresh GitHub facts, submit its exact
    /// SHA once, then read back. Any later attempt starts with a new read.
    ///
    /// # Errors
    /// Returns an error if the target is outside the task's binding, a definite
    /// refusal remains unresolved, or readback is unknown.
    pub async fn merge(&self, task: &Task, target: &PullTarget) -> Result<Forge, ForgeError> {
        if !target
            .branches
            .matches_repository(&task.identity().repository)
            || target.branches.base != task.identity().base
            || task
                .pull_request()
                .and_then(|pr| target.branches.target(&pr.url).ok())
                .as_ref()
                != Some(target)
        {
            return Err(ForgeError::Identity);
        }
        let observation = Observation {
            forge: Observed::Known(self.observe(target).await?),
            host: Observed::Unknown,
            workspace: Observed::Unknown,
        };
        let Action::Merge { head } = decide(task, &observation) else {
            let Observed::Known(forge) = observation.forge else {
                return Err(ForgeError::Incomplete);
            };
            return Ok(forge);
        };
        let url = format!("{}/{}/merge", self.origin, target.path());
        let status = self
            .client
            .put(url)
            .json(&json!({ "sha": head, "merge_method": "squash" }))
            .send()
            .await
            .map(|response| response.status());
        let confirmed = self.observe(target).await?;
        if let Ok(status) = status
            && !status.is_success()
            && status != StatusCode::CONFLICT
            && !matches!(confirmed, Forge::Merged { .. })
        {
            return Err(ForgeError::Refused(status));
        }
        Ok(confirmed)
    }
}

async fn decode<T: DeserializeOwned>(response: Response) -> Result<T, ForgeError> {
    let mut response = response.error_for_status()?;
    let mut data = Vec::new();
    while let Some(bytes) = response.chunk().await? {
        if data.len() + bytes.len() > BODY_LIMIT {
            return Err(ForgeError::Oversize);
        }
        data.extend_from_slice(&bytes);
    }
    Ok(serde_json::from_slice(&data)?)
}

#[cfg(test)]
mod tests;
