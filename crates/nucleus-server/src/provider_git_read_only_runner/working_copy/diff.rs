use std::process::Command;

use nucleus_local_store::LocalStoreBackend;

use crate::project_resource_target::resolve_project_resource_target;
use crate::ServerStateService;

use super::{
    inspect_scm_working_copy, ScmWorkingCopyChangeKind, ScmWorkingCopyDiff,
    ScmWorkingCopyDiffRequest, ScmWorkingCopyDiffScope, ScmWorkingCopyInspectionRequest,
    ScmWorkingCopyInspectionState,
};

const MAX_DIFF_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const EMPTY_TREE_OID: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

pub fn read_scm_working_copy_diff<B>(
    state: &ServerStateService<B>,
    request: &ScmWorkingCopyDiffRequest,
) -> Result<ScmWorkingCopyDiff, String>
where
    B: LocalStoreBackend,
{
    let inspection_request = ScmWorkingCopyInspectionRequest {
        project_id: request.project_id.clone(),
        resource_id: request.resource_id.clone(),
    };
    let inspection = inspect_scm_working_copy(state, &inspection_request);
    if inspection.state != ScmWorkingCopyInspectionState::Ready {
        return Err(inspection
            .error
            .unwrap_or_else(|| "working-copy status is unavailable".to_owned()));
    }
    let file = inspection
        .files
        .iter()
        .find(|file| file.path == request.path)
        .ok_or_else(|| "requested path is not a current working-copy change".to_owned())?;
    match request.scope {
        ScmWorkingCopyDiffScope::Staged if !file.staged => {
            return Err("requested path has no staged change".to_owned())
        }
        ScmWorkingCopyDiffScope::Working if !file.unstaged => {
            return Err("requested path has no working-tree change".to_owned())
        }
        _ => {}
    }
    let target =
        resolve_project_resource_target(state, &request.project_id, Some(&request.resource_id))?;

    let mut command = Command::new("git");
    command
        .arg("--no-optional-locks")
        .arg("diff")
        .arg("--no-ext-diff")
        .arg("--no-color");
    let untracked = file.change_kind == ScmWorkingCopyChangeKind::Untracked;
    if untracked {
        command
            .arg("--no-index")
            .arg("--")
            .arg("/dev/null")
            .arg(&file.path);
    } else {
        command.arg("--find-renames");
        match request.scope {
            ScmWorkingCopyDiffScope::All => {
                command.arg(inspection.head_oid.as_deref().unwrap_or(EMPTY_TREE_OID));
            }
            ScmWorkingCopyDiffScope::Staged => {
                command
                    .arg("--cached")
                    .arg(inspection.head_oid.as_deref().unwrap_or(EMPTY_TREE_OID));
            }
            ScmWorkingCopyDiffScope::Working => {}
        }
        command.arg("--").arg(&file.path);
        if let Some(original_path) = file.original_path.as_ref() {
            command.arg(original_path);
        }
    }
    let output = command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .current_dir(&target.root)
        .output()
        .map_err(|error| format!("Git diff could not start: {error}"))?;
    let accepted_exit = output.status.success() || (untracked && output.status.code() == Some(1));
    if !accepted_exit {
        return Err("Git diff failed".to_owned());
    }
    if output.stdout.len() > MAX_DIFF_OUTPUT_BYTES {
        return Ok(ScmWorkingCopyDiff {
            project_id: request.project_id.clone(),
            resource_id: request.resource_id.clone(),
            path: file.path.clone(),
            original_path: file.original_path.clone(),
            change_kind: file.change_kind.clone(),
            staged: file.staged,
            unstaged: file.unstaged,
            file_ref: file.file_ref.clone(),
            patch: None,
            additions: 0,
            deletions: 0,
            notice: Some("Text patch exceeds the 2 MiB display limit.".to_owned()),
        });
    }
    let patch = String::from_utf8(output.stdout)
        .map_err(|_| "Git diff output is not valid UTF-8 text".to_owned())?;
    let (additions, deletions) = patch_counts(&patch);
    let patch = (!patch.is_empty()).then_some(patch);
    Ok(ScmWorkingCopyDiff {
        project_id: request.project_id.clone(),
        resource_id: request.resource_id.clone(),
        path: file.path.clone(),
        original_path: file.original_path.clone(),
        change_kind: file.change_kind.clone(),
        staged: file.staged,
        unstaged: file.unstaged,
        file_ref: file.file_ref.clone(),
        patch,
        additions,
        deletions,
        notice: None,
    })
}

fn patch_counts(patch: &str) -> (usize, usize) {
    patch.lines().fold((0, 0), |(additions, deletions), line| {
        if line.starts_with('+') && !line.starts_with("+++") {
            (additions + 1, deletions)
        } else if line.starts_with('-') && !line.starts_with("---") {
            (additions, deletions + 1)
        } else {
            (additions, deletions)
        }
    })
}
