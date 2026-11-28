use std::collections::BTreeMap;

use nucleus_core::{CheckState, Forge, Head, PullRequest};
use serde::Deserialize;

use crate::{AuthenticatedGitHubUser, ForgeError};

#[derive(Deserialize)]
pub(crate) struct Pull {
    pub(crate) number: i32,
    pub(crate) html_url: String,
    pub(crate) body: Option<String>,
    pub(crate) merged: bool,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    pub(crate) user: Option<AuthenticatedGitHubUser>,
    // REST can omit this hint. A merged pull still needs a verified commit.
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
    #[serde(deserialize_with = "Deserialize::deserialize")]
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
#[serde(rename_all = "camelCase")]
pub(crate) struct Checks {
    #[serde(deserialize_with = "Deserialize::deserialize")]
    base_ref_oid: Option<Head>,
    head_ref_oid: Head,
    base_ref_name: String,
    is_draft: bool,
    state: String,
    mergeable: String,
    merge_state_status: String,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    review_decision: Option<String>,
    // GitHub may return null. Omitting a selected field is incomplete evidence.
    #[serde(deserialize_with = "Deserialize::deserialize")]
    status_check_rollup: Option<Rollup>,
}

#[derive(Deserialize)]
struct Rollup {
    state: String,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    contexts: Option<CheckContexts>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckContexts {
    page_info: CheckPage,
    nodes: Vec<Option<NamedCheck>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckPage {
    has_next_page: bool,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "__typename")]
enum NamedCheck {
    CheckRun {
        name: String,
        #[serde(deserialize_with = "Deserialize::deserialize")]
        conclusion: Option<String>,
        #[serde(rename = "isRequired")]
        required: bool,
    },
    StatusContext {
        context: String,
        state: String,
        #[serde(rename = "isRequired")]
        required: bool,
    },
}

impl NamedCheck {
    const fn is_required(&self) -> bool {
        match self {
            Self::CheckRun { required, .. } | Self::StatusContext { required, .. } => *required,
        }
    }

    fn result(&self) -> (&str, CheckResult) {
        use CheckResult::{Failed, Passed, Pending, Unknown};
        match self {
            Self::CheckRun {
                name, conclusion, ..
            } => (
                name,
                match conclusion.as_deref() {
                    Some("SUCCESS" | "NEUTRAL" | "SKIPPED") => Passed,
                    Some(
                        "ACTION_REQUIRED" | "CANCELLED" | "FAILURE" | "STALE" | "STARTUP_FAILURE"
                        | "TIMED_OUT",
                    ) => Failed,
                    None => Pending,
                    Some(_) => Unknown,
                },
            ),
            Self::StatusContext { context, state, .. } => (
                context,
                match state.as_str() {
                    "SUCCESS" => Passed,
                    "ERROR" | "FAILURE" => Failed,
                    "EXPECTED" | "PENDING" => Pending,
                    _ => Unknown,
                },
            ),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum CheckResult {
    Passed,
    Pending,
    Unknown,
    Failed,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergedPull {
    head_ref_oid: Head,
    base_ref_name: String,
    state: String,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    merge_commit: Option<MergeCommit>,
}

#[derive(Deserialize)]
struct MergeCommit {
    oid: Head,
}

impl GraphReply {
    pub(crate) fn has_open_branch_pr(self) -> Result<bool, ForgeError> {
        if !self.errors.is_empty() {
            return Err(ForgeError::Incomplete);
        }
        let data = self.data.ok_or(ForgeError::Incomplete)?;
        data.pointer("/repository/pullRequests/totalCount")
            .and_then(serde_json::Value::as_u64)
            .map(|count| count > 0)
            .ok_or(ForgeError::Incomplete)
    }

    pub(crate) fn rate_limited(&self) -> bool {
        self.errors
            .iter()
            .any(|error| error.kind.as_deref() == Some("RATE_LIMITED"))
    }

    pub(crate) fn checks(
        self,
        head: &Head,
        base: &str,
        base_oid: &Head,
        named: bool,
    ) -> Result<Checks, ForgeError> {
        let mut pull = self.pull_request()?;
        // The query omits contexts only when its @include directive is false.
        if !named
            && let Some(rollup) = pull
                .get_mut("statusCheckRollup")
                .and_then(serde_json::Value::as_object_mut)
        {
            rollup.entry("contexts").or_insert(serde_json::Value::Null);
        }
        let checks: Checks = serde_json::from_value(pull).map_err(|_| ForgeError::Incomplete)?;
        verify_graph_pull(head, base, &checks.head_ref_oid, &checks.base_ref_name)?;
        if checks.state != "OPEN" || checks.base_ref_oid.as_ref() != Some(base_oid) {
            return Err(ForgeError::Incomplete);
        }
        Ok(checks)
    }

    pub(crate) fn merge_commit(self, head: &Head, base: &str) -> Result<Head, ForgeError> {
        let merged: MergedPull =
            serde_json::from_value(self.pull_request()?).map_err(|_| ForgeError::Incomplete)?;
        verify_graph_pull(head, base, &merged.head_ref_oid, &merged.base_ref_name)?;
        if merged.state != "MERGED" {
            return Err(ForgeError::Incomplete);
        }
        merged
            .merge_commit
            .map(|commit| commit.oid)
            .ok_or(ForgeError::Incomplete)
    }

    fn pull_request(self) -> Result<serde_json::Value, ForgeError> {
        if !self.errors.is_empty() {
            return Err(ForgeError::GraphQlRejected);
        }
        self.data
            .and_then(|mut data| {
                data.pointer_mut("/repository/pullRequest")
                    .map(serde_json::Value::take)
            })
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
    pub(crate) fn next_cursor(&self) -> Option<&str> {
        let page = &self
            .status_check_rollup
            .as_ref()?
            .contexts
            .as_ref()?
            .page_info;
        page.end_cursor
            .as_deref()
            .filter(|cursor| page.has_next_page && !cursor.is_empty())
    }

    pub(crate) fn append(&mut self, next: Self) -> Result<(), ForgeError> {
        if self.is_draft != next.is_draft
            || self.mergeable != next.mergeable
            || self.merge_state_status != next.merge_state_status
            || self.review_decision != next.review_decision
        {
            return Err(ForgeError::Incomplete);
        }
        let rollup = self
            .status_check_rollup
            .as_mut()
            .ok_or(ForgeError::Incomplete)?;
        let more = next.status_check_rollup.ok_or(ForgeError::Incomplete)?;
        if rollup.state != more.state {
            return Err(ForgeError::Incomplete);
        }
        let contexts = rollup.contexts.as_mut().ok_or(ForgeError::Incomplete)?;
        let more = more.contexts.ok_or(ForgeError::Incomplete)?;
        contexts.nodes.extend(more.nodes);
        contexts.page_info = more.page_info;
        Ok(())
    }

    fn required_state(&self, named: bool) -> CheckState {
        let Some(rollup) = &self.status_check_rollup else {
            return CheckState::Ready;
        };
        let Some(contexts) = &rollup.contexts else {
            return if named {
                CheckState::Unknown
            } else {
                CheckState::Ready
            };
        };
        let incomplete =
            contexts.page_info.has_next_page || contexts.nodes.iter().any(Option::is_none);
        let any_required = contexts.nodes.iter().flatten().any(NamedCheck::is_required);
        if !any_required && incomplete {
            return CheckState::Unknown;
        }
        let mut results = BTreeMap::new();
        for (name, result) in contexts
            .nodes
            .iter()
            .flatten()
            .filter(|check| !any_required || check.is_required())
            .map(NamedCheck::result)
        {
            if name.trim().is_empty() {
                return CheckState::Unknown;
            }
            results
                .entry(name)
                .and_modify(|prior: &mut CheckResult| *prior = (*prior).max(result))
                .or_insert(result);
        }
        let failures = results
            .iter()
            .filter(|(_, result)| **result == CheckResult::Failed)
            .map(|(name, _)| (*name).to_owned())
            .collect::<Vec<_>>();
        if !failures.is_empty() {
            return CheckState::FailedRequired(failures);
        }
        if incomplete
            || results
                .values()
                .any(|result| *result == CheckResult::Unknown)
        {
            return CheckState::Unknown;
        }
        if results
            .values()
            .any(|result| *result == CheckResult::Pending)
        {
            return CheckState::Pending;
        }
        CheckState::Ready
    }

    pub(crate) fn state(&self, named: bool) -> CheckState {
        if self.is_draft {
            return CheckState::Blocked;
        }
        if self.mergeable == "CONFLICTING" || self.merge_state_status == "DIRTY" {
            return CheckState::Conflict;
        }
        if self.mergeable == "MERGEABLE" && self.merge_state_status == "BEHIND" {
            return CheckState::BaseMoved;
        }
        let required = self.required_state(named);
        if matches!(required, CheckState::FailedRequired(_)) {
            return required;
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
            (_, _, Some("CHANGES_REQUESTED" | "REVIEW_REQUIRED"), _) => CheckState::Blocked,
            _ if required != CheckState::Ready => required,
            (_, _, _, Some("PENDING" | "EXPECTED")) => CheckState::Pending,
            ("MERGEABLE", "CLEAN", None | Some("APPROVED"), None | Some("SUCCESS")) => {
                CheckState::Ready
            }
            (
                "MERGEABLE",
                "CLEAN" | "UNSTABLE",
                None | Some("APPROVED"),
                Some("ERROR" | "FAILURE"),
            ) if named => CheckState::Ready,
            (_, _, _, Some("ERROR" | "FAILURE"))
            | (_, "BEHIND" | "BLOCKED" | "DRAFT" | "UNSTABLE", _, _) => CheckState::Blocked,
            _ => CheckState::Unknown,
        }
    }
}
