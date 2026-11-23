//! Observe GitHub pull requests and merge only at the authorized head.

mod wire;

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nucleus_core::{Action, CheckState, Forge, Head, Observation, Observed, Task, decide};
use reqwest::{
    Client, Response, StatusCode, Url,
    header::{ACCEPT, AUTHORIZATION, HeaderMap, HeaderValue, RETRY_AFTER},
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::json;
use wire::{GraphReply, Pull, PullState};

const BODY_LIMIT: usize = 2 * 1024 * 1024;
const API_VERSION: &str = "2026-03-10";
const CHECKS_QUERY: &str = "query($owner:String!,$repo:String!,$number:Int!){\
  repository(owner:$owner,name:$repo){pullRequest(number:$number){\
  headRefOid baseRefName isDraft state mergeable mergeStateStatus reviewDecision\
  statusCheckRollup{state}\
  }}}";

#[derive(Debug, thiserror::Error)]
pub enum ForgeError {
    #[error("pull request identity does not match the configured repository and branches")]
    Identity,
    #[error("GitHub reported a different pull request base")]
    BaseChanged,
    #[error("GitHub refused the original head and the readback still shows it")]
    HeadNotRefreshed,
    #[error("more than one open pull request matches the task branch")]
    Ambiguous,
    #[error("GitHub credential cannot be used as a bearer")]
    Credential,
    #[error("GitHub returned an incomplete or inconsistent response")]
    Incomplete,
    #[error("GitHub response exceeded the read limit")]
    Oversize,
    #[error("GitHub deferred requests until {until:?}")]
    Deferred { until: SystemTime },
    #[error("GitHub request failed")]
    Http(#[from] reqwest::Error),
    #[error("GitHub response could not be decoded ({category:?} at {line}:{column})")]
    Decode {
        category: serde_json::error::Category,
        line: usize,
        column: usize,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeWrite {
    Skipped,
    Merged { commit: Head },
    HeadMismatch,
    Refused { status: StatusCode },
    Unknown,
    Deferred { until: SystemTime },
}

#[derive(Debug)]
pub struct MergeAttempt {
    pub write: MergeWrite,
    pub observed: Result<Forge, ForgeError>,
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
        if pull.base.branch != self.branches.base {
            return Err(ForgeError::BaseChanged);
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
        Ok(Self { client, origin })
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
        let pull = self.pull(target).await?;
        let checks = if !pull.merged && pull.state == PullState::Open {
            let response = self.client.post(format!("{}/graphql", self.origin)).json(&json!({
                "query": CHECKS_QUERY,
                "variables": { "owner": target.branches.owner, "repo": target.branches.repository, "number": target.number },
            })).send().await?;
            let graph: GraphReply = decode(response).await?;
            graph.checks(&pull.head.sha, &target.branches.base)?
        } else {
            CheckState::Unknown
        };
        pull.forge(checks)
    }

    async fn pull(&self, target: &PullTarget) -> Result<Pull, ForgeError> {
        let url = format!("{}/{}", self.origin, target.path());
        let pull: Pull = decode(self.client.get(url).send().await?).await?;
        target.verify(&pull)?;
        Ok(pull)
    }

    /// Recheck the merge decision against fresh GitHub facts, submit its exact
    /// SHA once, then read back. Any later attempt starts with a new read.
    ///
    /// # Errors
    /// Returns an error if the preflight cannot verify the target. After a PUT,
    /// the write outcome and subsequent observation are returned separately.
    pub async fn merge(
        &self,
        task: &Task,
        target: &PullTarget,
    ) -> Result<MergeAttempt, ForgeError> {
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
            return Ok(MergeAttempt {
                write: MergeWrite::Skipped,
                observed: Ok(forge),
            });
        };
        // GitHub's PUT compares the supplied head SHA only. Recheck the base
        // immediately before sending, and verify it again in the readback.
        let latest = self.pull(target).await?;
        if latest.head.sha != head || latest.merged || latest.state != PullState::Open {
            return Ok(MergeAttempt {
                write: MergeWrite::Skipped,
                observed: latest.forge(CheckState::Unknown),
            });
        }
        let url = format!("{}/{}/merge", self.origin, target.path());
        let reply = self
            .client
            .put(url)
            .json(&json!({ "sha": head, "merge_method": "squash" }))
            .send()
            .await;
        let write = match reply {
            Ok(reply) => classify_write(reply).await,
            Err(_) => MergeWrite::Unknown,
        };
        if let MergeWrite::Deferred { until } = write {
            return Ok(MergeAttempt {
                write,
                observed: Err(ForgeError::Deferred { until }),
            });
        }
        let mut observed = self.observe(target).await;
        if write == MergeWrite::HeadMismatch
            && matches!(&observed, Ok(Forge::Open { pr, .. }) if pr.head == head)
        {
            observed = Err(ForgeError::HeadNotRefreshed);
        }
        Ok(MergeAttempt { write, observed })
    }
}

async fn classify_write(response: Response) -> MergeWrite {
    #[derive(Deserialize)]
    struct Receipt {
        merged: bool,
        sha: Option<Head>,
    }

    if let Some(until) = deferred(&response) {
        return MergeWrite::Deferred { until };
    }
    match response.status() {
        StatusCode::OK => match decode::<Receipt>(response).await {
            Ok(Receipt {
                merged: true,
                sha: Some(commit),
            }) => MergeWrite::Merged { commit },
            _ => MergeWrite::Unknown,
        },
        StatusCode::CONFLICT => MergeWrite::HeadMismatch,
        status if status.is_server_error() || status == StatusCode::REQUEST_TIMEOUT => {
            MergeWrite::Unknown
        }
        status => MergeWrite::Refused { status },
    }
}

fn deferred(response: &Response) -> Option<SystemTime> {
    let headers = response.headers();
    let retry = headers.get(RETRY_AFTER);
    let exhausted = headers
        .get("x-ratelimit-remaining")
        .is_some_and(|value| value == "0");
    if response.status() != StatusCode::TOO_MANY_REQUESTS
        && !(response.status() == StatusCode::FORBIDDEN && (exhausted || retry.is_some()))
    {
        return None;
    }
    let now = SystemTime::now();
    let after = retry
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .parse::<u64>()
                .ok()
                .and_then(|seconds| now.checked_add(Duration::from_secs(seconds)))
                .or_else(|| httpdate::parse_http_date(value).ok())
        });
    let reset = (exhausted || response.status() == StatusCode::TOO_MANY_REQUESTS)
        .then(|| {
            headers
                .get("x-ratelimit-reset")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .and_then(|seconds| UNIX_EPOCH.checked_add(Duration::from_secs(seconds)))
        })
        .flatten();
    Some(
        after
            .into_iter()
            .chain(reset)
            .max()
            .filter(|time| *time >= now)
            .unwrap_or(now + Duration::from_mins(1)),
    )
}

async fn decode<T: DeserializeOwned>(response: Response) -> Result<T, ForgeError> {
    if let Some(until) = deferred(&response) {
        return Err(ForgeError::Deferred { until });
    }
    let mut response = response.error_for_status()?;
    let mut data = Vec::new();
    while let Some(bytes) = response.chunk().await? {
        if data.len() + bytes.len() > BODY_LIMIT {
            return Err(ForgeError::Oversize);
        }
        data.extend_from_slice(&bytes);
    }
    serde_json::from_slice(&data).map_err(|error| ForgeError::Decode {
        category: error.classify(),
        line: error.line(),
        column: error.column(),
    })
}

#[cfg(test)]
mod tests;
