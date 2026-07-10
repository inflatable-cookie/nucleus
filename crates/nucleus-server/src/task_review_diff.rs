use std::collections::BTreeMap;

use nucleus_engine::{
    EngineCheckpointRef, EngineDiffCoverageState, EngineDiffPathChange, EngineDiffPathChangeKind,
    EngineDiffSummaryConfidence, EngineDiffSummaryCounts, EngineDiffSummaryKind,
    EngineDiffSummaryRecord, EngineDiffSummaryRecordId,
};

use crate::task_review_snapshots::{SnapshotContentState, SnapshotFileEntry, SnapshotManifest};

pub(crate) struct TaskReviewDiffInput<'a> {
    pub diff_id: String,
    pub work_item_id: &'a str,
    pub command_id: &'a str,
    pub baseline_checkpoint_id: &'a str,
    pub target_checkpoint_id: &'a str,
    pub baseline: &'a SnapshotManifest,
    pub target: &'a SnapshotManifest,
}

pub(crate) fn compose_task_review_diff(input: TaskReviewDiffInput<'_>) -> EngineDiffSummaryRecord {
    let baseline = files_by_path(&input.baseline.files);
    let target = files_by_path(&input.target.files);
    let mut paths = baseline.keys().chain(target.keys()).collect::<Vec<_>>();
    paths.sort();
    paths.dedup();

    let mut path_changes = Vec::new();
    let mut counts = EngineDiffSummaryCounts::default();
    for path in paths {
        let before = baseline.get(path).copied();
        let after = target.get(path).copied();
        if before.is_some_and(|before| after.is_some_and(|after| unchanged(before, after))) {
            continue;
        }
        let kind = change_kind(before, after);
        match kind {
            EngineDiffPathChangeKind::Added => counts.added += 1,
            EngineDiffPathChangeKind::Modified => counts.modified += 1,
            EngineDiffPathChangeKind::Deleted => counts.deleted += 1,
            EngineDiffPathChangeKind::MetadataOnly => counts.metadata_only += 1,
        }
        let current = after.or(before).expect("path comes from one manifest");
        path_changes.push(EngineDiffPathChange {
            file_ref: current.file_ref.0.clone(),
            display_path: current.display_path.clone(),
            kind,
            baseline_file_ref: before.map(|entry| entry.file_ref.0.clone()),
            target_file_ref: after.map(|entry| entry.file_ref.0.clone()),
        });
    }

    let changed_paths = path_changes
        .iter()
        .map(|change| change.display_path.clone())
        .collect::<Vec<_>>();
    let changed_count = changed_paths.len();
    EngineDiffSummaryRecord {
        diff_id: EngineDiffSummaryRecordId(input.diff_id),
        kind: EngineDiffSummaryKind::Source,
        source_boundary_ref: EngineCheckpointRef::CheckpointId(
            input.baseline_checkpoint_id.to_owned(),
        ),
        target_boundary_ref: EngineCheckpointRef::CheckpointId(
            input.target_checkpoint_id.to_owned(),
        ),
        source_ref: Some(EngineCheckpointRef::WorkItemId(input.work_item_id.to_owned())),
        adapter_ref: None,
        generated_by_ref: EngineCheckpointRef::CommandId(input.command_id.to_owned()),
        confidence: EngineDiffSummaryConfidence::Exact,
        summary: format!(
            "{changed_count} task-window paths changed ({} added, {} modified, {} deleted, {} metadata-only).",
            counts.added, counts.modified, counts.deleted, counts.metadata_only
        ),
        changed_paths,
        path_changes,
        counts,
        coverage: EngineDiffCoverageState::Complete,
        truncated: false,
        attribution_notice: Some(
            "Changes are attributed to the task execution window; concurrent local writes are included."
                .to_owned(),
        ),
        evidence_refs: vec![
            EngineCheckpointRef::SnapshotRef(input.baseline.snapshot_ref.0.clone()),
            EngineCheckpointRef::SnapshotRef(input.target.snapshot_ref.0.clone()),
        ],
        artifact_refs: Vec::new(),
    }
}

fn files_by_path(files: &[SnapshotFileEntry]) -> BTreeMap<&str, &SnapshotFileEntry> {
    files
        .iter()
        .map(|entry| (entry.display_path.as_str(), entry))
        .collect()
}

fn unchanged(before: &SnapshotFileEntry, after: &SnapshotFileEntry) -> bool {
    before.content_hash == after.content_hash
        && before.byte_size == after.byte_size
        && before.content_state == after.content_state
}

fn change_kind(
    before: Option<&SnapshotFileEntry>,
    after: Option<&SnapshotFileEntry>,
) -> EngineDiffPathChangeKind {
    if before.is_some_and(metadata_only) || after.is_some_and(metadata_only) {
        return EngineDiffPathChangeKind::MetadataOnly;
    }
    match (before, after) {
        (None, Some(_)) => EngineDiffPathChangeKind::Added,
        (Some(_), None) => EngineDiffPathChangeKind::Deleted,
        (Some(_), Some(_)) => EngineDiffPathChangeKind::Modified,
        (None, None) => unreachable!(),
    }
}

fn metadata_only(entry: &SnapshotFileEntry) -> bool {
    !matches!(entry.content_state, SnapshotContentState::StoredText { .. })
}
