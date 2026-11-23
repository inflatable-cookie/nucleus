use nucleus_core::{CheckState, Forge, Head, PullRequest};
use serde::Deserialize;

use crate::ForgeError;

#[derive(Deserialize)]
pub(crate) struct Pull {
    pub(crate) number: i32,
    pub(crate) html_url: String,
    pub(crate) merged: bool,
    pub(crate) merge_commit_sha: Option<Head>,
    pub(crate) state: PullState,
    pub(crate) base: GitRef,
    pub(crate) head: GitRef,
}

impl Pull {
    pub(crate) fn forge(self, checks: CheckState) -> Result<Forge, ForgeError> {
        let pr = PullRequest {
            url: self.html_url,
            head: self.head.sha,
        };
        match (self.merged, self.state) {
            (true, PullState::Closed) => Ok(Forge::Merged {
                pr,
                commit: self.merge_commit_sha.ok_or(ForgeError::Incomplete)?,
            }),
            (false, PullState::Closed) => Ok(Forge::Closed(pr)),
            (false, PullState::Open) => Ok(Forge::Open { pr, checks }),
            (true, PullState::Open) => Err(ForgeError::Incomplete),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PullState {
    Open,
    Closed,
}

#[derive(Deserialize)]
pub(crate) struct GitRef {
    #[serde(rename = "ref")]
    pub(crate) branch: String,
    pub(crate) sha: Head,
    pub(crate) repo: Option<RepoName>,
}

#[derive(Deserialize)]
pub(crate) struct RepoName {
    pub(crate) full_name: String,
}

#[derive(Deserialize)]
pub(crate) struct GraphReply {
    data: Option<Data>,
    #[serde(default)]
    errors: Vec<serde::de::IgnoredAny>,
}

#[derive(Deserialize)]
struct Data {
    repository: Option<Repository>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Repository {
    pull_request: Option<Checks>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Checks {
    head_ref_oid: Head,
    base_ref_name: String,
    is_draft: bool,
    state: String,
    mergeable: String,
    merge_state_status: String,
    review_decision: Option<String>,
    status_check_rollup: Option<Rollup>,
}

#[derive(Deserialize)]
struct Rollup {
    state: String,
}

impl GraphReply {
    pub(crate) fn checks(self, head: &Head, base: &str) -> Result<CheckState, ForgeError> {
        if !self.errors.is_empty() {
            return Err(ForgeError::Incomplete);
        }
        let checks = self
            .data
            .and_then(|data| data.repository)
            .and_then(|repository| repository.pull_request)
            .ok_or(ForgeError::Incomplete)?;
        if checks.base_ref_name != base {
            return Err(ForgeError::BaseChanged);
        }
        if checks.head_ref_oid != *head || checks.state != "OPEN" {
            return Err(ForgeError::Incomplete);
        }
        Ok(checks.state())
    }
}

impl Checks {
    fn state(&self) -> CheckState {
        if self.is_draft || self.mergeable == "CONFLICTING" {
            return CheckState::Blocked;
        }
        let review = self.review_decision.as_deref();
        let rollup = self
            .status_check_rollup
            .as_ref()
            .map(|rollup| rollup.state.as_str());
        match (
            self.mergeable.as_str(),
            self.merge_state_status.as_str(),
            review,
            rollup,
        ) {
            (_, _, Some("CHANGES_REQUESTED" | "REVIEW_REQUIRED"), _)
            | (_, _, _, Some("ERROR" | "FAILURE")) => CheckState::Blocked,
            (_, _, _, Some("PENDING" | "EXPECTED")) => CheckState::Pending,
            ("MERGEABLE", "CLEAN", None | Some("APPROVED"), None | Some("SUCCESS")) => {
                CheckState::Ready
            }
            (_, "BEHIND" | "BLOCKED" | "DIRTY" | "DRAFT" | "UNSTABLE", _, _) => CheckState::Blocked,
            _ => CheckState::Unknown,
        }
    }
}
