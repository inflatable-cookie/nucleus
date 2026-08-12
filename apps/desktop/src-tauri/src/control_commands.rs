//! Control envelope Tauri command: submission through the IPC control
//! adapter with project command refusal notifications.
//!
//! Split from the lib.rs god file; behavior unchanged.

use nucleus_server::{
    ControlApiCodecError, ControlApiCodecFailure, ControlCommandDto, ControlRequestBodyDto,
    ControlRequestEnvelopeDto, ControlResponseBodyDto, ControlResponseEnvelopeDto,
};

use crate::{notifications, DesktopState};

struct ProjectCommandRefusalContext {
    command_id: String,
    project_id: Option<String>,
    label: &'static str,
}

fn project_command_refusal_context(
    request: &ControlRequestEnvelopeDto,
) -> Option<ProjectCommandRefusalContext> {
    let ControlRequestBodyDto::Command { command } = &request.body else {
        return None;
    };
    match command {
        ControlCommandDto::ProjectCreate { command_id, .. } => Some(ProjectCommandRefusalContext {
            command_id: command_id.clone(),
            project_id: None,
            label: "Project creation",
        }),
        ControlCommandDto::ProjectLifecycle {
            command_id,
            project_id,
            ..
        } => Some(ProjectCommandRefusalContext {
            command_id: command_id.clone(),
            project_id: Some(project_id.clone()),
            label: "Project change",
        }),
        ControlCommandDto::ProjectResource {
            command_id,
            project_id,
            ..
        } => Some(ProjectCommandRefusalContext {
            command_id: command_id.clone(),
            project_id: Some(project_id.clone()),
            label: "Project resource change",
        }),
        _ => None,
    }
}

#[tauri::command]
pub(crate) async fn submit_control_envelope(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    request: ControlRequestEnvelopeDto,
) -> Result<ControlResponseEnvelopeDto, ControlApiCodecError> {
    let refusal_context = project_command_refusal_context(&request);
    // Storage IO runs off the main thread; the adapter mutex no longer
    // serializes panel queries through the UI thread.
    let adapter = state.adapter.clone();
    let response = tauri::async_runtime::spawn_blocking(move || {
        let mut adapter = adapter.lock().map_err(|_| ControlApiCodecError {
            failure: ControlApiCodecFailure::ServerErrorPayload,
            reason: "desktop command adapter lock is poisoned".to_owned(),
        })?;
        adapter.submit_control_envelope(request)
    })
    .await
    .map_err(|_| ControlApiCodecError {
        failure: ControlApiCodecFailure::ServerErrorPayload,
        reason: "desktop command worker failed".to_owned(),
    })??;

    if let Some(context) = refusal_context {
        if let ControlResponseBodyDto::CommandReceipt {
            status,
            error_reason,
            ..
        } = &response.body
        {
            if status == "rejected" {
                notifications::publish_command_refusal(
                    &app,
                    &context.command_id,
                    context.project_id.as_deref(),
                    context.label,
                    error_reason
                        .as_deref()
                        .unwrap_or("Project command was refused."),
                );
            }
        }
    }
    Ok(response)
}
