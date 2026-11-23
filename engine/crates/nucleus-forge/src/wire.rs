use nucleus_core::{CheckState, Head};
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

#[derive(Deserialize)]
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
    review_threads: ReviewThreads,
}

#[derive(Deserialize)]
struct Rollup {
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewThreads {
    nodes: Vec<ReviewThread>,
    page_info: PageInfo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewThread {
    is_resolved: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
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
        if checks.head_ref_oid != *head || checks.base_ref_name != base || checks.state != "OPEN" {
            return Err(ForgeError::Incomplete);
        }
        Ok(checks.state())
    }
}

impl Checks {
    fn state(&self) -> CheckState {
        if self.is_draft
            || self.mergeable == "CONFLICTING"
            || self
                .review_threads
                .nodes
                .iter()
                .any(|thread| !thread.is_resolved)
        {
            return CheckState::Blocked;
        }
        if self.review_threads.page_info.has_next_page {
            return CheckState::Unknown;
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
