use std::process::Command;
use std::sync::{Mutex, MutexGuard, OnceLock};

use nucleus_local_store::LocalStoreBackend;
use serde::{Deserialize, Serialize};

use crate::project_resource_target::resolve_project_resource_target;
use crate::ServerStateService;

mod commit;
mod diff;
mod fingerprint;
mod mutation;
mod parser;
pub use commit::{
    commit_scm_working_copy, ScmWorkingCopyCommitReceipt, ScmWorkingCopyCommitRequest,
    ScmWorkingCopyCommitResult,
};
pub use diff::read_scm_working_copy_diff;
use fingerprint::git_index_fingerprint;
pub use mutation::{
    mutate_scm_working_copy, ScmWorkingCopyMutationAction, ScmWorkingCopyMutationReceipt,
    ScmWorkingCopyMutationRequest, ScmWorkingCopyMutationResult,
};
use parser::parse_working_copy_status;

const MAX_STATUS_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

static WORKING_COPY_MUTATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(super) fn working_copy_mutation_guard() -> Result<MutexGuard<'static, ()>, String> {
    WORKING_COPY_MUTATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "working-copy mutation lock is unavailable".to_owned())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmWorkingCopyInspectionRequest {
    pub project_id: String,
    pub resource_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmWorkingCopyDiffRequest {
    pub project_id: String,
    pub resource_id: String,
    pub path: String,
    #[serde(default)]
    pub scope: ScmWorkingCopyDiffScope,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmWorkingCopyDiffScope {
    #[default]
    All,
    Staged,
    Working,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmWorkingCopyInspectionState {
    Ready,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmWorkingCopyChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Conflicted,
    TypeChanged,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmWorkingCopyFileStatus {
    pub path: String,
    pub original_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub change_kind: ScmWorkingCopyChangeKind,
    pub staged: bool,
    pub unstaged: bool,
    pub file_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmWorkingCopyInspection {
    pub project_id: String,
    pub resource_id: String,
    pub state: ScmWorkingCopyInspectionState,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub head_oid: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<ScmWorkingCopyFileStatus>,
    pub status_fingerprint: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmWorkingCopyDiff {
    pub project_id: String,
    pub resource_id: String,
    pub path: String,
    pub original_path: Option<String>,
    pub change_kind: ScmWorkingCopyChangeKind,
    pub staged: bool,
    pub unstaged: bool,
    pub file_ref: Option<String>,
    pub patch: Option<String>,
    pub additions: usize,
    pub deletions: usize,
    pub notice: Option<String>,
}

impl ScmWorkingCopyInspection {
    pub fn unavailable(
        request: &ScmWorkingCopyInspectionRequest,
        error: impl Into<String>,
    ) -> Self {
        Self {
            project_id: request.project_id.clone(),
            resource_id: request.resource_id.clone(),
            state: ScmWorkingCopyInspectionState::Unavailable,
            branch: None,
            upstream: None,
            head_oid: None,
            ahead: 0,
            behind: 0,
            files: Vec::new(),
            status_fingerprint: None,
            error: Some(error.into()),
        }
    }
}

pub fn inspect_scm_working_copy<B>(
    state: &ServerStateService<B>,
    request: &ScmWorkingCopyInspectionRequest,
) -> ScmWorkingCopyInspection
where
    B: LocalStoreBackend,
{
    let target = match resolve_project_resource_target(
        state,
        &request.project_id,
        Some(&request.resource_id),
    ) {
        Ok(target) => target,
        Err(error) => return ScmWorkingCopyInspection::unavailable(request, error),
    };

    if !target.root.join(".git").exists() {
        return ScmWorkingCopyInspection::unavailable(
            request,
            "resource root is not a Git working copy",
        );
    }

    let output = match Command::new("git")
        .args([
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .current_dir(&target.root)
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            return ScmWorkingCopyInspection::unavailable(
                request,
                format!("Git status could not start: {error}"),
            )
        }
    };

    if output.stdout.len() > MAX_STATUS_OUTPUT_BYTES
        || output.stderr.len() > MAX_STATUS_OUTPUT_BYTES
    {
        return ScmWorkingCopyInspection::unavailable(
            request,
            "Git status exceeded the bounded output limit",
        );
    }
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.trim();
        return ScmWorkingCopyInspection::unavailable(
            request,
            if detail.is_empty() {
                "Git status failed".to_owned()
            } else {
                format!("Git status failed: {detail}")
            },
        );
    }

    let index_fingerprint = match git_index_fingerprint(&target.root) {
        Ok(fingerprint) => fingerprint,
        Err(error) => return ScmWorkingCopyInspection::unavailable(request, error),
    };
    parse_working_copy_status(request, &target.root, &output.stdout, &index_fingerprint)
        .unwrap_or_else(|error| {
            ScmWorkingCopyInspection::unavailable(
                request,
                format!("Git status was malformed: {error}"),
            )
        })
}

#[cfg(test)]
mod tests;
