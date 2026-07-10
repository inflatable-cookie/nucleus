use std::io::{self, Write};

use nucleus_engine::{EngineDiffCoverageState, EngineDiffPathChange};
use similar::{ChangeTag, TextDiff};

use crate::task_review_snapshots::{
    SnapshotContentState, SnapshotFileEntry, SnapshotFileRef, SnapshotManifest,
    SnapshotResolutionState, SnapshotTextResolutionState,
};
use crate::TaskReviewSnapshotStore;

use super::lineage::{snapshot_ref, ResolvedTaskDiff};
use super::types::{change_kind, coverage, TaskDiffFilePatchResponse, TaskDiffPatchState};

const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
// JSON control-character escaping can expand one UTF-8 byte to six bytes.
const MAX_PATCH_BYTES: usize = (MAX_RESPONSE_BYTES - 4 * 1024) / 6;

pub(super) fn render(
    store: &TaskReviewSnapshotStore,
    lineage: &ResolvedTaskDiff,
    change: &EngineDiffPathChange,
) -> Result<TaskDiffFilePatchResponse, String> {
    if lineage.diff.coverage != EngineDiffCoverageState::Complete {
        return Ok(response(lineage, change, TaskDiffPatchState::Partial));
    }
    let baseline_ref = crate::task_review_snapshots::SnapshotRef(snapshot_ref(&lineage.baseline)?);
    let target_ref = crate::task_review_snapshots::SnapshotRef(snapshot_ref(&lineage.target)?);
    let (baseline, target) = match (
        resolve_manifest(store, &baseline_ref)?,
        resolve_manifest(store, &target_ref)?,
    ) {
        (ManifestSide::Available(baseline), ManifestSide::Available(target)) => (baseline, target),
        (ManifestSide::Expired, _) | (_, ManifestSide::Expired) => {
            return Ok(response(lineage, change, TaskDiffPatchState::Expired));
        }
        _ => return Ok(response(lineage, change, TaskDiffPatchState::Missing)),
    };
    let before_entry = find_entry(&baseline, change.baseline_file_ref.as_deref());
    let after_entry = find_entry(&target, change.target_file_ref.as_deref());
    if before_entry.is_some_and(oversized) || after_entry.is_some_and(oversized) {
        return Ok(response(lineage, change, TaskDiffPatchState::Oversized));
    }
    if before_entry.is_some_and(binary) || after_entry.is_some_and(binary) {
        return Ok(response(lineage, change, TaskDiffPatchState::Binary));
    }
    let before = resolve_side(store, &baseline_ref, before_entry)?;
    let after = resolve_side(store, &target_ref, after_entry)?;
    let (before, after) = match (before, after) {
        (Side::Text(before), Side::Text(after)) => (before, after),
        (Side::Expired, _) | (_, Side::Expired) => {
            return Ok(response(lineage, change, TaskDiffPatchState::Expired));
        }
        _ => return Ok(response(lineage, change, TaskDiffPatchState::Missing)),
    };
    if before.len() > MAX_TEXT_BYTES || after.len() > MAX_TEXT_BYTES {
        return Ok(response(lineage, change, TaskDiffPatchState::Oversized));
    }

    let diff = TextDiff::from_lines(&before, &after);
    let additions = diff
        .iter_all_changes()
        .filter(|change| change.tag() == ChangeTag::Insert)
        .count();
    let deletions = diff
        .iter_all_changes()
        .filter(|change| change.tag() == ChangeTag::Delete)
        .count();
    let safe_path = change.display_path.replace(['\n', '\r'], "�");
    let mut writer = BoundedWriter::new(MAX_PATCH_BYTES);
    let write_result = diff
        .unified_diff()
        .header(&format!("a/{safe_path}"), &format!("b/{safe_path}"))
        .to_writer(&mut writer);
    if let Err(error) = write_result {
        if !writer.truncated {
            return Err(format!("task patch generation failed: {error}"));
        }
    }
    let truncated = writer.truncated;
    let patch = writer.finish();
    Ok(TaskDiffFilePatchResponse {
        diff_id: lineage.diff.diff_id.0.clone(),
        file_ref: change.file_ref.clone(),
        display_path: change.display_path.clone(),
        change_kind: change_kind(&change.kind),
        state: if truncated {
            TaskDiffPatchState::Truncated
        } else {
            TaskDiffPatchState::Available
        },
        patch: Some(patch),
        additions,
        deletions,
        truncated,
        coverage: coverage(&lineage.diff.coverage),
        attribution_notice: lineage.diff.attribution_notice.clone(),
    })
}

fn response(
    lineage: &ResolvedTaskDiff,
    change: &EngineDiffPathChange,
    state: TaskDiffPatchState,
) -> TaskDiffFilePatchResponse {
    TaskDiffFilePatchResponse {
        diff_id: lineage.diff.diff_id.0.clone(),
        file_ref: change.file_ref.clone(),
        display_path: change.display_path.clone(),
        change_kind: change_kind(&change.kind),
        state,
        patch: None,
        additions: 0,
        deletions: 0,
        truncated: false,
        coverage: coverage(&lineage.diff.coverage),
        attribution_notice: lineage.diff.attribution_notice.clone(),
    }
}

fn resolve_manifest(
    store: &TaskReviewSnapshotStore,
    snapshot_ref: &crate::task_review_snapshots::SnapshotRef,
) -> Result<ManifestSide, String> {
    let resolution = store
        .resolve_manifest(snapshot_ref)
        .map_err(|error| format!("task snapshot resolution failed: {error}"))?;
    match resolution.state {
        SnapshotResolutionState::Available | SnapshotResolutionState::CleanupPending => resolution
            .manifest
            .map(ManifestSide::Available)
            .ok_or_else(|| "available task snapshot has no manifest".to_owned()),
        SnapshotResolutionState::Missing => Ok(ManifestSide::Missing),
        SnapshotResolutionState::Expired => Ok(ManifestSide::Expired),
    }
}

enum ManifestSide {
    Available(SnapshotManifest),
    Missing,
    Expired,
}

fn find_entry<'a>(
    manifest: &'a SnapshotManifest,
    file_ref: Option<&str>,
) -> Option<&'a SnapshotFileEntry> {
    file_ref.and_then(|file_ref| {
        manifest
            .files
            .iter()
            .find(|entry| entry.file_ref.0 == file_ref)
    })
}

fn oversized(entry: &SnapshotFileEntry) -> bool {
    matches!(
        entry.content_state,
        SnapshotContentState::OversizedMetadataOnly
    )
}

fn binary(entry: &SnapshotFileEntry) -> bool {
    matches!(
        entry.content_state,
        SnapshotContentState::BinaryMetadataOnly
    )
}

enum Side {
    Text(String),
    Missing,
    Expired,
}

fn resolve_side(
    store: &TaskReviewSnapshotStore,
    snapshot_ref: &crate::task_review_snapshots::SnapshotRef,
    entry: Option<&SnapshotFileEntry>,
) -> Result<Side, String> {
    let Some(entry) = entry else {
        return Ok(Side::Text(String::new()));
    };
    let resolution = store
        .resolve_text(snapshot_ref, &SnapshotFileRef(entry.file_ref.0.clone()))
        .map_err(|error| format!("task snapshot text resolution failed: {error}"))?;
    Ok(match resolution.state {
        SnapshotTextResolutionState::Available | SnapshotTextResolutionState::CleanupPending => {
            Side::Text(resolution.content.unwrap_or_default())
        }
        SnapshotTextResolutionState::SnapshotExpired => Side::Expired,
        _ => Side::Missing,
    })
}

struct BoundedWriter {
    bytes: Vec<u8>,
    limit: usize,
    truncated: bool,
}

impl BoundedWriter {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(limit.min(64 * 1024)),
            limit,
            truncated: false,
        }
    }

    fn finish(mut self) -> String {
        while std::str::from_utf8(&self.bytes).is_err() {
            self.bytes.pop();
        }
        String::from_utf8(self.bytes).expect("bounded writer retains UTF-8 prefix")
    }
}

impl Write for BoundedWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let remaining = self.limit.saturating_sub(self.bytes.len());
        if buffer.len() > remaining {
            self.bytes.extend_from_slice(&buffer[..remaining]);
            self.truncated = true;
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "patch limit reached",
            ));
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
