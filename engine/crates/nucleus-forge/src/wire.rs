use nucleus_core::{CheckState, Forge, Head, PullRequest};
use serde::{Deserialize, de::DeserializeOwned};

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
    data: Option<serde_json::Value>,
    #[serde(default)]
    errors: Vec<GraphError>,
}

#[derive(Deserialize)]
struct GraphError {
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize)]
struct Data<T> {
    repository: Option<Repository<T>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Repository<T> {
    pull_request: Option<T>,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergedPull {
    head_ref_oid: Head,
    base_ref_name: String,
    state: String,
    merge_commit: Option<MergeCommit>,
}

#[derive(Deserialize)]
struct MergeCommit {
    oid: Head,
}

impl GraphReply {
    pub(crate) fn rate_limited(&self) -> bool {
        self.errors
            .iter()
            .any(|error| error.kind.as_deref() == Some("RATE_LIMITED"))
    }

    pub(crate) fn checks(self, head: &Head, base: &str) -> Result<CheckState, ForgeError> {
        let checks: Checks = self.pull_request()?;
        verify_graph_pull(head, base, &checks.head_ref_oid, &checks.base_ref_name)?;
        if checks.state != "OPEN" {
            return Err(ForgeError::Incomplete);
        }
        Ok(checks.state())
    }

    pub(crate) fn merge_commit(self, head: &Head, base: &str) -> Result<Head, ForgeError> {
        let merged: MergedPull = self.pull_request()?;
        verify_graph_pull(head, base, &merged.head_ref_oid, &merged.base_ref_name)?;
        if merged.state != "MERGED" {
            return Err(ForgeError::Incomplete);
        }
        merged
            .merge_commit
            .map(|commit| commit.oid)
            .ok_or(ForgeError::Incomplete)
    }

    fn pull_request<T: DeserializeOwned>(self) -> Result<T, ForgeError> {
        if !self.errors.is_empty() {
            return Err(ForgeError::GraphQlRejected);
        }
        let data = self.data.ok_or(ForgeError::Incomplete)?;
        let data: Data<T> = serde_json::from_value(data).map_err(|_| ForgeError::Incomplete)?;
        data.repository
            .and_then(|repository| repository.pull_request)
            .ok_or(ForgeError::Incomplete)
    }
}

fn verify_graph_pull(
    head: &Head,
    base: &str,
    actual_head: &Head,
    actual_base: &str,
) -> Result<(), ForgeError> {
    if actual_base != base {
        return Err(ForgeError::BaseChanged);
    }
    if actual_head != head {
        return Err(ForgeError::Incomplete);
    }
    Ok(())
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
