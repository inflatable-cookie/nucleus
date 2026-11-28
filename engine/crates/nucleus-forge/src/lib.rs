//! Observe GitHub pull requests and merge only at the authorized head.

mod review;
mod wire;

pub use review::{
    AuthenticatedGitHubUser, ReviewBinding, ReviewError, ReviewWrite, VerifiedReview,
};

use std::{
    collections::{BTreeMap, VecDeque},
    num::NonZeroU64,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use nucleus_core::{Action, CheckState, Forge, Head, Observation, Observed, Task, decide};
use reqwest::{
    Client, IntoUrl, RequestBuilder, Response, StatusCode, Url,
    header::{ACCEPT, AUTHORIZATION, ETAG, HeaderMap, HeaderValue, IF_NONE_MATCH, RETRY_AFTER},
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::json;
use tokio::sync::Mutex;
use wire::{GraphReply, Pull, PullState};

const BODY_LIMIT: usize = 2 * 1024 * 1024;
const API_VERSION: &str = "2026-03-10";
const MAX_CHECK_PAGES: usize = 10;
const CHECKS_QUERY: &str = "
  query($owner:String!,$repo:String!,$number:Int!,$namedChecks:Boolean!,$after:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        headRefOid baseRefName baseRefOid isDraft state mergeable mergeStateStatus reviewDecision
        statusCheckRollup{
          state
          contexts(first:100,after:$after) @include(if:$namedChecks){
            pageInfo{hasNextPage endCursor}
            nodes{
              __typename
              ... on CheckRun{name conclusion isRequired(pullRequestNumber:$number)}
              ... on StatusContext{context state isRequired(pullRequestNumber:$number)}
            }
          }
        }
      }
    }
  }
";
const MERGE_COMMIT_QUERY: &str = "
  query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        headRefOid baseRefName state mergeCommit{oid}
      }
    }
  }
";

#[derive(Debug, thiserror::Error)]
pub enum ForgeError {
    #[error("pull request identity does not match the configured repository and branches")]
    Identity,
    #[error("the external merge commit is no longer on the task’s base branch")]
    UnpublishedMerge,
    #[error(
        "the merged pull request source could not be verified against the task’s recorded head"
    )]
    UnverifiedSource,
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
    #[error("GitHub rejected the GraphQL checks query")]
    GraphQlRejected,
    #[error("GitHub response exceeded the read limit")]
    Oversize,
    #[error("GitHub deferred requests until {until:?}")]
    Deferred { until: SystemTime },
    #[error("GitHub request failed ({kind})", kind = http_failure(.0))]
    Http(#[from] reqwest::Error),
    #[error("GitHub returned HTTP {0}")]
    Status(StatusCode),
    #[error("GitHub response could not be decoded ({category:?} at {line}:{column})")]
    Decode {
        category: serde_json::error::Category,
        line: usize,
        column: usize,
    },
}

fn http_failure(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connection"
    } else {
        "transport"
    }
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
    head: Option<String>,
}

impl Branches {
    /// Bind repository identity and both branch names before reading a PR.
    ///
    /// # Errors
    /// Returns an error for an invalid repository or empty branch names.
    pub fn new(repository: &str, base: &str, head: &str) -> Result<Self, ForgeError> {
        if head.is_empty() {
            return Err(ForgeError::Identity);
        }
        Self::scoped(repository, base, Some(head.into()))
    }

    /// Bind an existing PR by number within the repository and base. Its source
    /// branch was created outside the engine.
    /// # Errors
    /// Returns an error for an invalid repository or empty base branch.
    pub fn for_review_entry(repository: &str, base: &str) -> Result<Self, ForgeError> {
        Self::scoped(repository, base, None)
    }

    fn scoped(repository: &str, base: &str, head: Option<String>) -> Result<Self, ForgeError> {
        let (owner, name) = repository.split_once('/').ok_or(ForgeError::Identity)?;
        let component = |value: &str| {
            !value.is_empty()
                && value != "."
                && value != ".."
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        };
        if !component(owner) || !component(name) || base.is_empty() {
            return Err(ForgeError::Identity);
        }
        Ok(Self {
            owner: owner.into(),
            repository: name.into(),
            base: base.into(),
            head,
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
    #[must_use]
    pub const fn number(&self) -> i32 {
        self.number
    }

    fn path(&self) -> String {
        format!(
            "repos/{}/{}/pulls/{}",
            self.branches.owner, self.branches.repository, self.number
        )
    }

    fn verify(&self, pull: &Pull) -> Result<(), ForgeError> {
        let matches_repository = |reference: &wire::GitRef| {
            reference
                .repo
                .as_ref()
                .is_some_and(|repo| self.branches.matches_repository(&repo.full_name))
        };
        if pull.number != self.number
            || self.branches.target(&pull.html_url)? != *self
            || !matches_repository(&pull.base)
            || self
                .branches
                .head
                .as_ref()
                .is_some_and(|head| *head != pull.head.branch || !matches_repository(&pull.head))
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
    auth: HeaderValue,
    account: SharedAccount,
    accounts: Arc<Mutex<BTreeMap<NonZeroU64, SharedAccount>>>,
    ancestors: Mutex<VecDeque<Url>>,
    client: Client,
    origin: String,
}

#[derive(Deserialize)]
struct PublishedBranch {
    name: String,
    commit: PublishedCommit,
}

#[derive(Deserialize)]
struct PublishedCommit {
    sha: Head,
}

impl GitHub {
    /// Configure the GitHub client using a caller-owned bearer.
    ///
    /// # Errors
    /// Returns an error if the bearer or HTTP client cannot be configured.
    pub fn new(bearer: &str) -> Result<Self, ForgeError> {
        Self::with_origin(bearer, "https://api.github.com".into())
    }

    /// Build a fixture client with a synthetic credential and local endpoint.
    ///
    /// # Errors
    /// Returns an error unless the endpoint is loopback.
    #[cfg(feature = "loopback-fixture")]
    pub fn loopback_fixture(address: std::net::SocketAddr) -> Result<Self, ForgeError> {
        if !address.ip().is_loopback() {
            return Err(ForgeError::Identity);
        }
        Self::with_origin("fixture-token", format!("http://{address}"))
    }

    fn with_origin(bearer: &str, origin: String) -> Result<Self, ForgeError> {
        let auth = Self::authorization(bearer)?;
        let mut headers = HeaderMap::new();
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
        Ok(Self {
            client,
            auth,
            account: Arc::default(),
            accounts: Arc::default(),
            origin,
            ancestors: Mutex::default(),
        })
    }

    fn authorization(bearer: &str) -> Result<HeaderValue, ForgeError> {
        if bearer.is_empty() {
            return Err(ForgeError::Credential);
        }
        let mut auth = HeaderValue::from_str(&format!("Bearer {bearer}"))
            .map_err(|_| ForgeError::Credential)?;
        auth.set_sensitive(true);
        Ok(auth)
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
        let head = branches.head.as_ref().ok_or(ForgeError::Identity)?;
        let head = format!("{}:{head}", branches.owner);
        url.query_pairs_mut().extend_pairs([
            ("state", "open"),
            ("head", &head),
            ("base", &branches.base),
            ("per_page", "2"),
        ]);
        let listed: Vec<Listed> = self.get(url).await?;
        match listed.as_slice() {
            [] => Ok(None),
            [pull] => Ok(Some(branches.target(&pull.html_url)?)),
            _ => Err(ForgeError::Ambiguous),
        }
    }

    /// Check for any open PR from the task branch, including drafts and other bases.
    ///
    /// # Errors
    /// Returns an error if the forge cannot verify the lookup.
    pub async fn has_open_branch_pr(&self, branches: &Branches) -> Result<bool, ForgeError> {
        let head = branches.head.as_ref().ok_or(ForgeError::Identity)?;
        // Unlike the REST head filter, headRefName also detects a same-named
        // branch from a fork, and the query deliberately leaves the base unconstrained.
        let query = "query($owner:String!,$repo:String!,$head:String!){
          repository(owner:$owner,name:$repo){
            pullRequests(headRefName:$head,states:OPEN,first:1){totalCount}
          }
        }";
        let graph = self
            .graph(
                query,
                json!({
                    "owner": branches.owner, "repo": branches.repository, "head": head
                }),
            )
            .await?;
        graph.has_open_branch_pr()
    }

    /// Verify that the merge commit belongs to the current base of this exact pull request.
    ///
    /// # Errors
    /// Returns an error if publication cannot be confirmed.
    pub async fn verify_merge_base(
        &self,
        target: &PullTarget,
        commit: &Head,
    ) -> Result<(), ForgeError> {
        let branches = &target.branches;
        let tip = self.branch_head(branches, &branches.base).await?;
        if &tip != commit && !self.contains(branches, commit, &tip).await? {
            return Err(ForgeError::UnpublishedMerge);
        }
        Ok(())
    }

    /// Confirm the advertised PR ref before using an immutable ancestry proof.
    ///
    /// # Errors
    /// Returns an error when GitHub cannot verify the ref or comparison.
    pub async fn pull_descends_from(
        &self,
        target: &PullTarget,
        recorded: &Head,
        merged: &Head,
    ) -> Result<bool, ForgeError> {
        #[derive(Deserialize)]
        struct Reference {
            #[serde(rename = "ref")]
            name: String,
            object: Object,
        }
        #[derive(Deserialize)]
        struct Object {
            #[serde(rename = "type")]
            kind: String,
            sha: Head,
        }
        let name = format!("pull/{}/head", target.number);
        let url = self.repository_url(&target.branches, &format!("git/ref/{name}"))?;
        let reference: Reference = self.get(url).await?;
        if reference.name != format!("refs/{name}") || reference.object.kind != "commit" {
            return Err(ForgeError::Identity);
        }
        if reference.object.sha != *merged {
            return Ok(false);
        }
        self.contains(&target.branches, recorded, merged).await
    }

    /// Read a branch head through the authenticated canonical repository.
    ///
    /// # Errors
    /// Returns an error if the branch or its advertised head is unavailable.
    pub async fn branch_head(&self, branches: &Branches, name: &str) -> Result<Head, ForgeError> {
        let mut url = self.repository_url(branches, "branches")?;
        url.path_segments_mut()
            .map_err(|()| ForgeError::Incomplete)?
            .push(name);
        let branch: PublishedBranch = self.get(url).await?;
        if branch.name != name {
            return Err(ForgeError::Identity);
        }
        Ok(branch.commit.sha)
    }

    /// Enumerate origin branches to find a published source after the task branch moved.
    ///
    /// # Errors
    /// Returns an error if the complete branch list cannot be read.
    pub async fn published_branches(
        &self,
        branches: &Branches,
    ) -> Result<Vec<(String, Head)>, ForgeError> {
        let mut heads = Vec::new();
        for page in 1..=100 {
            let mut url = self.repository_url(branches, "branches")?;
            url.query_pairs_mut()
                .append_pair("per_page", "100")
                .append_pair("page", &page.to_string());
            let batch: Vec<PublishedBranch> = self.get(url).await?;
            let last = batch.len() < 100;
            heads.extend(
                batch
                    .into_iter()
                    .map(|branch| (branch.name, branch.commit.sha)),
            );
            if last {
                return Ok(heads);
            }
        }
        Err(ForgeError::Incomplete)
    }

    /// Verify ancestry when the remote tip is absent from the local object store.
    ///
    /// # Errors
    /// Returns an error if the forge cannot compare the commits.
    pub async fn contains(
        &self,
        branches: &Branches,
        ancestor: &Head,
        tip: &Head,
    ) -> Result<bool, ForgeError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case")]
        enum Relation {
            Ahead,
            Behind,
            Diverged,
            Identical,
        }
        #[derive(Deserialize)]
        struct Comparison {
            status: Relation,
        }
        let url = self.repository_url(branches, &format!("compare/{ancestor}...{tip}"))?;
        let mut facts = self.ancestors.lock().await;
        if facts.contains(&url) {
            return Ok(true);
        }
        let comparison: Comparison = self.get(url.clone()).await?;
        let contains = matches!(comparison.status, Relation::Ahead | Relation::Identical);
        if contains {
            if facts.len() == 256 {
                facts.pop_front();
            }
            facts.push_back(url);
        }
        Ok(contains)
    }

    fn repository_url(&self, branches: &Branches, path: &str) -> Result<Url, ForgeError> {
        Url::parse(&format!(
            "{}/repos/{}/{}/{path}",
            self.origin, branches.owner, branches.repository
        ))
        .map_err(|_| ForgeError::Incomplete)
    }

    /// Read PR identity, current head, check state and any merge commit.
    ///
    /// # Errors
    /// Returns an error when evidence is unreadable, incomplete, or bound to
    /// another branch, repository or head. The engine treats errors as unknown.
    pub async fn observe(&self, target: &PullTarget) -> Result<Forge, ForgeError> {
        self.observe_with_checks(target, false).await
    }

    /// Read the check rollup for a task due to merge (required checks, or all
    /// reported checks when none are marked required).
    ///
    /// # Errors
    /// Returns the same evidence and transport errors as [`Self::observe`].
    pub async fn observe_for_merge(&self, target: &PullTarget) -> Result<Forge, ForgeError> {
        self.observe_with_checks(target, true).await
    }

    async fn observe_with_checks(
        &self,
        target: &PullTarget,
        merge: bool,
    ) -> Result<Forge, ForgeError> {
        self.observe_pull(target, self.pull(target).await?, merge)
            .await
    }

    async fn observe_pull(
        &self,
        target: &PullTarget,
        pull: Pull,
        merge: bool,
    ) -> Result<Forge, ForgeError> {
        let pull = self.confirm_merge_commit(target, pull).await?;
        let checks = if !pull.merged && pull.state == PullState::Open {
            let page = self.query_pull(target, CHECKS_QUERY, merge, None).await?;
            let mut checks =
                page.checks(&pull.head.sha, &target.branches.base, &pull.base.sha, merge)?;
            let mut cursors = std::collections::BTreeSet::new();
            while let Some(cursor) = checks.next_cursor() {
                if cursors.len() + 1 >= MAX_CHECK_PAGES || !cursors.insert(cursor.to_owned()) {
                    return pull.forge(CheckState::Unknown);
                }
                let page = self
                    .query_pull(target, CHECKS_QUERY, true, Some(cursor))
                    .await?;
                checks.append(page.checks(
                    &pull.head.sha,
                    &target.branches.base,
                    &pull.base.sha,
                    true,
                )?)?;
            }
            checks.state(merge)
        } else {
            CheckState::Unknown
        };
        pull.forge(checks)
    }

    async fn confirm_merge_commit(
        &self,
        target: &PullTarget,
        mut pull: Pull,
    ) -> Result<Pull, ForgeError> {
        if pull.merged && pull.state == PullState::Closed && pull.merge_commit_sha.is_none() {
            pull.merge_commit_sha = Some(
                self.query_pull(target, MERGE_COMMIT_QUERY, false, None)
                    .await?
                    .merge_commit(&pull.head.sha, &target.branches.base)?,
            );
        }
        Ok(pull)
    }

    async fn query_pull(
        &self,
        target: &PullTarget,
        query: &str,
        named_checks: bool,
        after: Option<&str>,
    ) -> Result<GraphReply, ForgeError> {
        let mut variables = json!({
            "owner": target.branches.owner,
            "repo": target.branches.repository,
            "number": target.number,
        });
        if query == CHECKS_QUERY {
            variables["namedChecks"] = json!(named_checks);
            variables["after"] = json!(after);
        }
        self.graph(query, variables).await
    }

    async fn graph(
        &self,
        query: &str,
        variables: serde_json::Value,
    ) -> Result<GraphReply, ForgeError> {
        let request = self
            .client
            .post(format!("{}/graphql", self.origin))
            .json(&json!({"query":query, "variables":variables}));
        self.request(request, false, |status, bytes, deadline| {
            require_success(status)?;
            let graph: GraphReply = decode_json(bytes)?;
            if secondary_limit(bytes) {
                return Err(ForgeError::Deferred {
                    until: deadline.max(SystemTime::now() + Duration::from_mins(1)),
                });
            }
            if graph.rate_limited() {
                return Err(ForgeError::Deferred { until: deadline });
            }
            Ok(graph)
        })
        .await
    }

    /// Verify the declared GitHub author against the exact open PR head.
    ///
    /// # Errors
    /// Returns an error if GitHub cannot verify the pull request identity.
    pub async fn matches_review_author(
        &self,
        target: &PullTarget,
        head: &Head,
        login: &str,
    ) -> Result<bool, ForgeError> {
        let pull = self.pull(target).await?;
        Ok(pull.state == PullState::Open
            && !pull.merged
            && pull.head.sha == *head
            && pull
                .head
                .repo
                .as_ref()
                .is_some_and(|repo| target.branches.matches_repository(&repo.full_name))
            && pull
                .user
                .is_some_and(|user| user.login.eq_ignore_ascii_case(login)))
    }

    async fn pull(&self, target: &PullTarget) -> Result<Pull, ForgeError> {
        let url = format!("{}/{}", self.origin, target.path());
        let pull: Pull = self.get(url).await?;
        target.verify(&pull)?;
        Ok(pull)
    }

    /// Read the current description when the verified PR is open at this head.
    ///
    /// # Errors
    /// Returns an error when GitHub cannot verify the pull request identity.
    pub async fn open_description(
        &self,
        target: &PullTarget,
        head: &Head,
    ) -> Result<Option<String>, ForgeError> {
        let pull = self.pull(target).await?;
        Ok(
            (pull.state == PullState::Open && !pull.merged && pull.head.sha == *head)
                .then_some(pull.body)
                .flatten(),
        )
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
        require_up_to_date_base: bool,
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
        let pull = self.pull(target).await?;
        let base = pull.base.sha.clone();
        let observation = Observation {
            forge: Observed::Known(self.observe_pull(target, pull, true).await?),
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
                observed: self
                    .confirm_merge_commit(target, latest)
                    .await
                    .and_then(|pull| pull.forge(CheckState::Unknown)),
            });
        }
        if latest.base.sha != base
            || (require_up_to_date_base
                && !self
                    .contains(&target.branches, &latest.base.sha, &head)
                    .await?)
        {
            return Ok(MergeAttempt {
                write: MergeWrite::Skipped,
                observed: latest.forge(CheckState::BaseMoved),
            });
        }
        let url = format!("{}/{}/merge", self.origin, target.path());
        let request = self
            .client
            .put(url)
            .json(&json!({ "sha": head, "merge_method": "merge" }));
        let write = classify_write(self.write(request).await);
        if let MergeWrite::Deferred { until } = write {
            return Ok(MergeAttempt {
                write,
                observed: Err(ForgeError::Deferred { until }),
            });
        }
        let observed = self.merge_readback(target, &head, &base, &write).await;
        Ok(MergeAttempt { write, observed })
    }

    async fn merge_readback(
        &self,
        target: &PullTarget,
        head: &Head,
        base: &Head,
        write: &MergeWrite,
    ) -> Result<Forge, ForgeError> {
        let pull = self.pull(target).await?;
        let base_moved = pull.base.sha != *base;
        let mut observed = self.observe_pull(target, pull, true).await?;
        if let Forge::Open { pr, checks } = &mut observed
            && pr.head == *head
        {
            if matches!(write, MergeWrite::Refused { .. } | MergeWrite::HeadMismatch)
                && base_moved
                && *checks != CheckState::Conflict
            {
                *checks = CheckState::BaseMoved;
            }
            if *write == MergeWrite::HeadMismatch
                && !matches!(checks, CheckState::Conflict | CheckState::BaseMoved)
            {
                return Err(ForgeError::HeadNotRefreshed);
            }
        }
        Ok(observed)
    }
}

fn classify_write(reply: Result<(StatusCode, Vec<u8>), ForgeError>) -> MergeWrite {
    #[derive(Deserialize)]
    struct Receipt {
        merged: bool,
        #[serde(deserialize_with = "Deserialize::deserialize")]
        sha: Option<Head>,
    }

    match reply {
        Ok((StatusCode::OK, bytes)) => match decode_json::<Receipt>(&bytes) {
            Ok(Receipt {
                merged: true,
                sha: Some(commit),
            }) => MergeWrite::Merged { commit },
            _ => MergeWrite::Unknown,
        },
        Err(ForgeError::Deferred { until }) => MergeWrite::Deferred { until },
        Err(ForgeError::Status(StatusCode::CONFLICT)) => MergeWrite::HeadMismatch,
        Err(ForgeError::Status(status))
            if !status.is_server_error() && status != StatusCode::REQUEST_TIMEOUT =>
        {
            MergeWrite::Refused { status }
        }
        _ => MergeWrite::Unknown,
    }
}

fn deadline_hint(headers: &HeaderMap, now: SystemTime) -> Option<SystemTime> {
    let after = headers
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .parse::<u64>()
                .ok()
                .and_then(|seconds| now.checked_add(Duration::from_secs(seconds)))
                .or_else(|| httpdate::parse_http_date(value).ok())
        });
    let reset = headers
        .get("x-ratelimit-reset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .and_then(|seconds| UNIX_EPOCH.checked_add(Duration::from_secs(seconds)));
    after
        .into_iter()
        .chain(reset)
        .max()
        .filter(|time| *time >= now)
}

type SharedAccount = Arc<Mutex<Account>>;

#[derive(Default)]
struct Account {
    until: Option<SystemTime>,
    next_write: Option<tokio::time::Instant>,
    reads: VecDeque<Representation>,
}

struct Representation {
    url: Url,
    auth: HeaderValue,
    tag: HeaderValue,
    bytes: Vec<u8>,
}

impl GitHub {
    async fn get<T: DeserializeOwned>(&self, url: impl IntoUrl) -> Result<T, ForgeError> {
        self.request(self.client.get(url), false, |status, bytes, _| {
            require_success(status)?;
            decode_json(bytes)
        })
        .await
    }

    async fn write(&self, request: RequestBuilder) -> Result<(StatusCode, Vec<u8>), ForgeError> {
        self.request(request, true, |status, bytes, _| {
            require_success(status)?;
            Ok((status, bytes.to_vec()))
        })
        .await
    }

    async fn request<T>(
        &self,
        request: RequestBuilder,
        write: bool,
        parse: impl FnOnce(StatusCode, &[u8], SystemTime) -> Result<T, ForgeError>,
    ) -> Result<T, ForgeError> {
        let mut request = request.header(AUTHORIZATION, self.auth.clone()).build()?;
        let mut state = self.account.lock().await;
        if let Some(until) = state.until
            && until > SystemTime::now()
        {
            return Err(ForgeError::Deferred { until });
        }
        if write {
            if let Some(next) = state.next_write {
                tokio::time::sleep_until(next).await;
            }
            state.next_write = Some(tokio::time::Instant::now() + Duration::from_secs(1));
        }
        let url = request.url().clone();
        let get = request.method() == reqwest::Method::GET;
        let cached = if get {
            state
                .reads
                .iter()
                .position(|entry| entry.url == url && entry.auth == self.auth)
        } else {
            None
        };
        if let Some(index) = cached {
            request
                .headers_mut()
                .insert(IF_NONE_MATCH, state.reads[index].tag.clone());
        }
        let response = self.client.execute(request).await?;
        let reply = state.receive(response).await;
        if write {
            state.next_write = Some(tokio::time::Instant::now() + Duration::from_secs(1));
        }
        let Reply {
            status,
            tag,
            bytes,
            deadline,
        } = reply?;
        if status == StatusCode::NOT_MODIFIED {
            let index = cached.ok_or(ForgeError::Incomplete)?;
            return parse(StatusCode::OK, &state.reads[index].bytes, deadline);
        }
        if let Some(index) = cached {
            state.reads.remove(index);
        }
        let result = parse(status, &bytes, deadline);
        if let Err(ForgeError::Deferred { until }) = &result {
            state.until = Some(*until);
        }
        if result.is_ok()
            && get
            && let Some(tag) = tag
        {
            // At most 16 bounded bodies per account, shared across tasks and pages.
            if state.reads.len() == 16 {
                state.reads.pop_front();
            }
            state.reads.push_back(Representation {
                url,
                auth: self.auth.clone(),
                tag,
                bytes,
            });
        }
        result
    }
}

struct Reply {
    status: StatusCode,
    tag: Option<HeaderValue>,
    bytes: Vec<u8>,
    deadline: SystemTime,
}

impl Account {
    async fn receive(&mut self, response: Response) -> Result<Reply, ForgeError> {
        let status = response.status();
        let headers = response.headers();
        let now = SystemTime::now();
        let minute = now + Duration::from_mins(1);
        let hint = deadline_hint(headers, now).unwrap_or(minute);
        let exhausted = headers
            .get("x-ratelimit-remaining")
            .is_some_and(|value| value == "0");
        let retry = headers.contains_key(RETRY_AFTER);
        let quota_status = matches!(
            status,
            StatusCode::TOO_MANY_REQUESTS | StatusCode::FORBIDDEN
        );
        let limited =
            status == StatusCode::TOO_MANY_REQUESTS || (quota_status && (exhausted || retry));
        let deadline = if exhausted { hint } else { hint.max(minute) };
        if exhausted || retry || limited {
            self.until = Some(if limited { deadline } else { hint });
        }
        let tag = headers.get(ETAG).cloned();
        let received = response_bytes(response).await;
        if quota_status && received.as_ref().is_ok_and(|bytes| secondary_limit(bytes)) {
            let until = hint.max(minute);
            self.until = Some(until);
            return Err(ForgeError::Deferred { until });
        }
        if limited {
            return Err(ForgeError::Deferred { until: deadline });
        }
        // A rejected request still has an HTTP status if its body is unreadable.
        let bytes = if status.is_client_error() || status.is_server_error() {
            received.unwrap_or_default()
        } else {
            received?
        };
        Ok(Reply {
            status,
            tag,
            bytes,
            deadline: hint,
        })
    }
}

fn require_success(status: StatusCode) -> Result<(), ForgeError> {
    if status.is_success() {
        Ok(())
    } else {
        Err(ForgeError::Status(status))
    }
}

fn secondary_limit(bytes: &[u8]) -> bool {
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Message {
        message: String,
    }
    #[derive(Deserialize)]
    struct Errors {
        #[serde(default)]
        message: String,
        #[serde(default)]
        errors: Vec<Message>,
    }
    serde_json::from_slice::<Errors>(bytes).is_ok_and(|body| {
        std::iter::once(body.message)
            .chain(body.errors.into_iter().map(|error| error.message))
            .any(|message| {
                message
                    .to_ascii_lowercase()
                    .contains("secondary rate limit")
            })
    })
}

async fn response_bytes(mut response: Response) -> Result<Vec<u8>, ForgeError> {
    let mut data = Vec::new();
    while let Some(bytes) = response.chunk().await? {
        if data.len() + bytes.len() > BODY_LIMIT {
            return Err(ForgeError::Oversize);
        }
        data.extend_from_slice(&bytes);
    }
    Ok(data)
}

fn decode_json<T: DeserializeOwned>(data: &[u8]) -> Result<T, ForgeError> {
    serde_json::from_slice(data).map_err(|error| {
        if error.is_data() {
            ForgeError::Incomplete
        } else {
            ForgeError::Decode {
                category: error.classify(),
                line: error.line(),
                column: error.column(),
            }
        }
    })
}

#[cfg(test)]
mod tests;
