use nucleus_server::provider_git_read_only_runner::{
    commit_scm_working_copy, inspect_scm_working_copy, mutate_scm_working_copy,
    read_scm_working_copy_diff, ScmWorkingCopyCommitRequest, ScmWorkingCopyCommitResult,
    ScmWorkingCopyDiff, ScmWorkingCopyDiffRequest, ScmWorkingCopyInspection,
    ScmWorkingCopyInspectionRequest, ScmWorkingCopyMutationRequest, ScmWorkingCopyMutationResult,
};

use crate::DesktopState;

const EMBEDDED_DESKTOP_HOST_REF: &str = "host:embedded-desktop";
const DESKTOP_OPERATOR_REF: &str = "operator:desktop";

#[tauri::command]
pub async fn inspect_scm_working_copies(
    state: tauri::State<'_, DesktopState>,
    requests: Vec<ScmWorkingCopyInspectionRequest>,
) -> Result<Vec<ScmWorkingCopyInspection>, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        requests
            .iter()
            .map(|request| inspect_scm_working_copy(&server_state, request))
            .collect()
    })
    .await
    .map_err(|_| "desktop SCM inspection worker failed".to_owned())
}

#[tauri::command]
pub async fn read_scm_working_copy_diff_command(
    state: tauri::State<'_, DesktopState>,
    request: ScmWorkingCopyDiffRequest,
) -> Result<ScmWorkingCopyDiff, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        read_scm_working_copy_diff(&server_state, &request)
    })
    .await
    .map_err(|_| "desktop SCM diff worker failed".to_owned())?
}

#[tauri::command]
pub async fn mutate_scm_working_copy_command(
    state: tauri::State<'_, DesktopState>,
    request: ScmWorkingCopyMutationRequest,
) -> Result<ScmWorkingCopyMutationResult, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        mutate_scm_working_copy(
            &server_state,
            EMBEDDED_DESKTOP_HOST_REF,
            DESKTOP_OPERATOR_REF,
            &request,
        )
    })
    .await
    .map_err(|_| "desktop SCM mutation worker failed".to_owned())?
}

#[tauri::command]
pub async fn commit_scm_working_copy_command(
    state: tauri::State<'_, DesktopState>,
    request: ScmWorkingCopyCommitRequest,
) -> Result<ScmWorkingCopyCommitResult, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        commit_scm_working_copy(
            &server_state,
            EMBEDDED_DESKTOP_HOST_REF,
            DESKTOP_OPERATOR_REF,
            &request,
        )
    })
    .await
    .map_err(|_| "desktop SCM commit worker failed".to_owned())?
}
