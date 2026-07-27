use std::path::Path;

use crate::editor_files::admitted_editor_file_ref_at_path;

use super::fingerprint::status_fingerprint;
use super::{
    ScmWorkingCopyChangeKind, ScmWorkingCopyFileStatus, ScmWorkingCopyInspection,
    ScmWorkingCopyInspectionRequest, ScmWorkingCopyInspectionState,
};

const MAX_CHANGED_FILES: usize = 5_000;

pub(super) fn parse_working_copy_status(
    request: &ScmWorkingCopyInspectionRequest,
    root: &Path,
    output: &[u8],
    index_fingerprint: &str,
) -> Result<ScmWorkingCopyInspection, String> {
    let records = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut branch = None;
    let mut upstream = None;
    let mut head_oid = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut files = Vec::new();
    let mut index = 0;

    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        let record = String::from_utf8_lossy(record);
        if let Some(value) = record.strip_prefix("# branch.oid ") {
            if value != "(initial)" {
                head_oid = Some(value.to_owned());
            }
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.head ") {
            if value != "(detached)" {
                branch = Some(value.to_owned());
            }
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.upstream ") {
            upstream = Some(value.to_owned());
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.ab ") {
            let mut parts = value.split_whitespace();
            ahead = parse_divergence(parts.next(), '+')?;
            behind = parse_divergence(parts.next(), '-')?;
            continue;
        }

        let (path, original_path, index_code, worktree_code) = match record.as_bytes()[0] {
            b'1' => {
                let fields = record.splitn(9, ' ').collect::<Vec<_>>();
                if fields.len() != 9 {
                    return Err("ordinary entry has the wrong field count".to_owned());
                }
                let (index_code, worktree_code) = status_pair(fields[1])?;
                (fields[8].to_owned(), None, index_code, worktree_code)
            }
            b'2' => {
                let fields = record.splitn(10, ' ').collect::<Vec<_>>();
                if fields.len() != 10 {
                    return Err("rename entry has the wrong field count".to_owned());
                }
                let Some(original) = records.get(index) else {
                    return Err("rename entry is missing its original path".to_owned());
                };
                index += 1;
                let (index_code, worktree_code) = status_pair(fields[1])?;
                (
                    fields[9].to_owned(),
                    Some(String::from_utf8_lossy(original).into_owned()),
                    index_code,
                    worktree_code,
                )
            }
            b'u' => {
                let fields = record.splitn(11, ' ').collect::<Vec<_>>();
                if fields.len() != 11 {
                    return Err("unmerged entry has the wrong field count".to_owned());
                }
                let (index_code, worktree_code) = status_pair(fields[1])?;
                (fields[10].to_owned(), None, index_code, worktree_code)
            }
            b'?' => (
                record
                    .strip_prefix("? ")
                    .ok_or_else(|| "untracked entry is malformed".to_owned())?
                    .to_owned(),
                None,
                "?".to_owned(),
                "?".to_owned(),
            ),
            b'!' => continue,
            _ => return Err("entry type is unknown".to_owned()),
        };

        let change_kind = change_kind(&index_code, &worktree_code);
        let staged = !matches!(index_code.as_str(), "." | "?");
        let unstaged = !matches!(worktree_code.as_str(), ".");
        let file_ref = if change_kind == ScmWorkingCopyChangeKind::Deleted {
            None
        } else {
            admitted_editor_file_ref_at_path(root, &path)
        };
        files.push(ScmWorkingCopyFileStatus {
            path,
            original_path,
            index_status: index_code,
            worktree_status: worktree_code,
            change_kind,
            staged,
            unstaged,
            file_ref,
        });
        if files.len() >= MAX_CHANGED_FILES {
            break;
        }
    }

    let mut inspection = ScmWorkingCopyInspection {
        project_id: request.project_id.clone(),
        resource_id: request.resource_id.clone(),
        state: ScmWorkingCopyInspectionState::Ready,
        branch,
        upstream,
        head_oid,
        ahead,
        behind,
        files,
        status_fingerprint: None,
        error: None,
    };
    inspection.status_fingerprint = Some(status_fingerprint(&inspection, root, index_fingerprint));
    Ok(inspection)
}

fn status_pair(value: &str) -> Result<(String, String), String> {
    let mut characters = value.chars();
    let index = characters
        .next()
        .ok_or_else(|| "status pair is empty".to_owned())?;
    let worktree = characters
        .next()
        .ok_or_else(|| "status pair has one character".to_owned())?;
    if characters.next().is_some() {
        return Err("status pair has more than two characters".to_owned());
    }
    Ok((index.to_string(), worktree.to_string()))
}

fn parse_divergence(value: Option<&str>, prefix: char) -> Result<u32, String> {
    value
        .and_then(|value| value.strip_prefix(prefix))
        .ok_or_else(|| "branch divergence is malformed".to_owned())?
        .parse()
        .map_err(|_| "branch divergence is not numeric".to_owned())
}

fn change_kind(index: &str, worktree: &str) -> ScmWorkingCopyChangeKind {
    if index == "?" && worktree == "?" {
        return ScmWorkingCopyChangeKind::Untracked;
    }
    if index == "U" || worktree == "U" || matches!((index, worktree), ("A", "A") | ("D", "D")) {
        return ScmWorkingCopyChangeKind::Conflicted;
    }
    for (code, kind) in [
        ("R", ScmWorkingCopyChangeKind::Renamed),
        ("C", ScmWorkingCopyChangeKind::Copied),
        ("D", ScmWorkingCopyChangeKind::Deleted),
        ("A", ScmWorkingCopyChangeKind::Added),
        ("T", ScmWorkingCopyChangeKind::TypeChanged),
        ("M", ScmWorkingCopyChangeKind::Modified),
    ] {
        if index == code || worktree == code {
            return kind;
        }
    }
    ScmWorkingCopyChangeKind::Unknown
}
