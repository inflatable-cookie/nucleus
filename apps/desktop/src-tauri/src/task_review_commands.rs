//! Task review Tauri commands: diff overview, diff file patches, and review
//! decisions over the task review snapshot store.
//!
//! Split from the lib.rs god file; behavior unchanged.

use nucleus_server::{
    selected_task_review_decision_records::read_selected_task_review_decisions,
    ControlSelectedTaskReviewDecisionRecordDto, TaskDiffFilePatchRequest,
    TaskDiffFilePatchResponse, TaskDiffOverviewRequest, TaskDiffOverviewResponse,
};

use crate::DesktopState;

#[tauri::command]
pub(crate) async fn read_task_diff_overview(
    state: tauri::State<'_, DesktopState>,
    request: TaskDiffOverviewRequest,
) -> Result<TaskDiffOverviewResponse, String> {
    let server_state = state.server_state.clone();
    let store = state.task_review_snapshot_store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        nucleus_server::read_task_diff_overview(&server_state, store.as_ref(), &request)
    })
    .await
    .map_err(|_| "desktop diff worker failed".to_owned())?
}

#[tauri::command]
pub(crate) async fn read_task_diff_file_patch(
    state: tauri::State<'_, DesktopState>,
    request: TaskDiffFilePatchRequest,
) -> Result<TaskDiffFilePatchResponse, String> {
    let store = state
        .task_review_snapshot_store
        .clone()
        .ok_or_else(|| "task review snapshot backend is not configured".to_owned())?;
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        nucleus_server::read_task_diff_file_patch(&server_state, &store, &request)
    })
    .await
    .map_err(|_| "desktop diff worker failed".to_owned())?
}

#[tauri::command]
pub(crate) async fn read_task_review_decisions(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    task_id: String,
) -> Result<Vec<ControlSelectedTaskReviewDecisionRecordDto>, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        read_selected_task_review_decisions(&server_state)
            .map_err(|error| format!("task review decision read failed: {error:?}"))
            .map(|records| {
                records
                    .iter()
                    .filter(|record| record.project_id == project_id && record.task_id == task_id)
                    .map(ControlSelectedTaskReviewDecisionRecordDto::from)
                    .collect()
            })
    })
    .await
    .map_err(|_| "desktop review worker failed".to_owned())?
}
