use nucleus_engine::{EngineDiffCoverageState, EngineDiffPathChangeKind, EngineDiffSummaryRecord};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TaskDiffOverviewRequest {
    pub project_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub diff_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TaskDiffFilePatchRequest {
    pub project_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub diff_id: String,
    pub file_ref: String,
}

impl TaskDiffFilePatchRequest {
    pub(super) fn overview_request(&self) -> TaskDiffOverviewRequest {
        TaskDiffOverviewRequest {
            project_id: self.project_id.clone(),
            task_id: self.task_id.clone(),
            work_item_id: self.work_item_id.clone(),
            diff_id: self.diff_id.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TaskDiffCountsDto {
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
    pub metadata_only: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TaskDiffFileDto {
    pub file_ref: String,
    pub display_path: String,
    pub change_kind: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TaskDiffOverviewResponse {
    pub diff_id: String,
    pub summary: String,
    pub counts: TaskDiffCountsDto,
    pub coverage: String,
    pub truncated: bool,
    pub attribution_notice: Option<String>,
    pub files: Vec<TaskDiffFileDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskDiffPatchState {
    Available,
    Truncated,
    Binary,
    Oversized,
    Missing,
    Expired,
    Partial,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TaskDiffFilePatchResponse {
    pub diff_id: String,
    pub file_ref: String,
    pub display_path: String,
    pub change_kind: String,
    pub state: TaskDiffPatchState,
    pub patch: Option<String>,
    pub additions: usize,
    pub deletions: usize,
    pub truncated: bool,
    pub coverage: String,
    pub attribution_notice: Option<String>,
}

pub(super) fn overview(diff: &EngineDiffSummaryRecord) -> TaskDiffOverviewResponse {
    TaskDiffOverviewResponse {
        diff_id: diff.diff_id.0.clone(),
        summary: diff.summary.clone(),
        counts: TaskDiffCountsDto {
            added: diff.counts.added,
            modified: diff.counts.modified,
            deleted: diff.counts.deleted,
            metadata_only: diff.counts.metadata_only,
        },
        coverage: coverage(&diff.coverage),
        truncated: diff.truncated,
        attribution_notice: diff.attribution_notice.clone(),
        files: diff
            .path_changes
            .iter()
            .map(|change| TaskDiffFileDto {
                file_ref: change.file_ref.clone(),
                display_path: change.display_path.clone(),
                change_kind: change_kind(&change.kind),
            })
            .collect(),
    }
}

pub(super) fn coverage(value: &EngineDiffCoverageState) -> String {
    match value {
        EngineDiffCoverageState::Complete => "complete",
        EngineDiffCoverageState::Partial => "partial",
        EngineDiffCoverageState::Unavailable => "unavailable",
    }
    .to_owned()
}

pub(super) fn change_kind(value: &EngineDiffPathChangeKind) -> String {
    match value {
        EngineDiffPathChangeKind::Added => "added",
        EngineDiffPathChangeKind::Modified => "modified",
        EngineDiffPathChangeKind::Deleted => "deleted",
        EngineDiffPathChangeKind::MetadataOnly => "metadata_only",
    }
    .to_owned()
}
