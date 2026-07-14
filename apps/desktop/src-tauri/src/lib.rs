use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::Manager;

use nucleus_command_policy::{
    CommandEvidence, CommandEvidenceId, CommandExecutionStatus, CommandOutputRetention,
    CommandRequestId,
};
use nucleus_core::RevisionId;
use nucleus_local_store::{RevisionExpectation, SqliteBackend};
use nucleus_server::control_envelope_dto::ControlSelectedTaskReviewDecisionRecordDto;
use nucleus_server::{
    forge_credential_status_refresh, forge_pull_request_refresh, forge_repository_metadata_refresh,
    forge_status_check_refresh, persist_forge_credential_status_refreshes,
    persist_forge_pull_request_refreshes, persist_forge_repository_metadata_refreshes,
    persist_forge_status_check_refreshes, read_forge_credential_status_refreshes,
    read_forge_pull_request_refreshes, read_forge_repository_metadata_refreshes,
    read_forge_status_check_refreshes, seed_local_memory_proposal, seed_local_planning_session,
    seed_local_project, seed_local_research_run_brief, seed_local_task, write_command_evidence,
    ControlApiCodecError, ControlRequestEnvelopeDto, ControlResponseBodyDto,
    ControlResponseEnvelopeDto, EditorFileEntry, EditorFileSaveRequest, EditorFileSnapshot,
    ForgeCredentialStatusRefreshInput, ForgeCredentialStatusRefreshPersistenceInput,
    ForgeNetworkCredentialKind, ForgeNetworkCredentialResolutionBoundary,
    ForgeNetworkCredentialStatus, ForgeNetworkExecutionCredentialRef,
    ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider, ForgePullRequestRefreshInput,
    ForgePullRequestRefreshPersistenceInput, ForgePullRequestRefreshScope,
    ForgeRepositoryMetadataRefreshInput, ForgeRepositoryMetadataRefreshPersistenceInput,
    ForgeStatusCheckRefreshInput, ForgeStatusCheckRefreshPersistenceInput,
    ForgeStatusCheckRefreshScope, LocalCodexChatHistory, LocalCodexChatModelOption,
    LocalCodexChatReply, LocalCodexChatRequest, LocalCodexChatService, LocalControlRequestHandler,
    LocalMemoryProposalSeed, LocalPlanningSessionSeed, LocalProjectSeed, LocalResearchRunBriefSeed,
    LocalTaskSeed, ServerStateService, TaskDiffFilePatchRequest, TaskDiffFilePatchResponse,
    TaskDiffOverviewRequest, TaskDiffOverviewResponse, TaskReviewSnapshotStore,
    TauriIpcControlCommandAdapter,
};

mod window_geometry;
mod workspace_ui;

struct DesktopState {
    adapter: Arc<Mutex<TauriIpcControlCommandAdapter<SqliteBackend>>>,
    chat: Arc<Mutex<LocalCodexChatService>>,
    server_state: ServerStateService<SqliteBackend>,
    task_review_snapshot_store: Option<TaskReviewSnapshotStore>,
}

#[tauri::command]
fn list_editor_files(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
) -> Result<Vec<EditorFileEntry>, String> {
    nucleus_server::list_editor_files(&state.server_state, &project_id)
}

#[tauri::command]
fn read_editor_file(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    file_ref: String,
) -> Result<EditorFileSnapshot, String> {
    nucleus_server::read_editor_file(&state.server_state, &project_id, &file_ref)
}

#[tauri::command]
fn save_editor_file(
    state: tauri::State<'_, DesktopState>,
    request: EditorFileSaveRequest,
) -> Result<EditorFileSnapshot, String> {
    nucleus_server::save_editor_file(&state.server_state, &request)
}

impl DesktopState {
    #[cfg(test)]
    fn new(backend: SqliteBackend) -> Self {
        Self::with_chat(backend, LocalCodexChatService::default(), None)
    }

    fn new_with_snapshot_store(backend: SqliteBackend, snapshot_root: PathBuf) -> Self {
        let snapshot_store = TaskReviewSnapshotStore::new(snapshot_root)
            .expect("local task review snapshot store should be writable");
        Self::with_chat(
            backend,
            LocalCodexChatService::with_task_review_snapshot_store(snapshot_store.clone()),
            Some(snapshot_store),
        )
    }

    fn with_chat(
        backend: SqliteBackend,
        chat: LocalCodexChatService,
        task_review_snapshot_store: Option<TaskReviewSnapshotStore>,
    ) -> Self {
        let server_state = ServerStateService::new(backend.clone());
        let handler = LocalControlRequestHandler::new(backend, None);
        seed_local_project(handler.state(), LocalProjectSeed::nucleus_local())
            .expect("local desktop project seed should be writable");
        seed_local_task(handler.state(), LocalTaskSeed::nucleus_local_bootstrap())
            .expect("local desktop task seed should be writable");
        seed_local_command_evidence(handler.state())
            .expect("local desktop command evidence seed should be writable");
        seed_local_provider_readiness_evidence(handler.state())
            .expect("local desktop provider readiness evidence seed should be writable");
        seed_local_planning_session(
            handler.state(),
            LocalPlanningSessionSeed::nucleus_local_bootstrap(),
        )
        .expect("local desktop planning session seed should be writable");
        seed_local_memory_proposal(
            handler.state(),
            LocalMemoryProposalSeed::nucleus_local_bootstrap(),
        )
        .expect("local desktop memory proposal seed should be writable");
        seed_local_research_run_brief(
            handler.state(),
            LocalResearchRunBriefSeed::nucleus_local_bootstrap(),
        )
        .expect("local desktop research run seed should be writable");
        let adapter = TauriIpcControlCommandAdapter::fixture_backed(handler);

        Self {
            adapter: Arc::new(Mutex::new(adapter)),
            chat: Arc::new(Mutex::new(chat)),
            server_state,
            task_review_snapshot_store,
        }
    }

    fn submit_control_envelope(
        &self,
        request: ControlRequestEnvelopeDto,
    ) -> Result<ControlResponseEnvelopeDto, ControlApiCodecError> {
        let mut adapter = self.adapter.lock().map_err(|_| ControlApiCodecError {
            failure: nucleus_server::ControlApiCodecFailure::ServerErrorPayload,
            reason: "desktop command adapter lock is poisoned".to_owned(),
        })?;

        adapter.submit_control_envelope(request)
    }
}

#[tauri::command]
fn read_task_diff_overview(
    state: tauri::State<'_, DesktopState>,
    request: TaskDiffOverviewRequest,
) -> Result<TaskDiffOverviewResponse, String> {
    nucleus_server::read_task_diff_overview(&state.server_state, &request)
}

#[tauri::command]
fn read_task_diff_file_patch(
    state: tauri::State<'_, DesktopState>,
    request: TaskDiffFilePatchRequest,
) -> Result<TaskDiffFilePatchResponse, String> {
    let store = state
        .task_review_snapshot_store
        .as_ref()
        .ok_or_else(|| "task review snapshot backend is not configured".to_owned())?;
    nucleus_server::read_task_diff_file_patch(&state.server_state, store, &request)
}

#[tauri::command]
fn read_task_review_decisions(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    task_id: String,
) -> Result<Vec<ControlSelectedTaskReviewDecisionRecordDto>, String> {
    nucleus_server::selected_task_review_decision_records::read_selected_task_review_decisions(
        &state.server_state,
    )
    .map_err(|error| format!("task review decision read failed: {error:?}"))
    .map(|records| {
        records
            .iter()
            .filter(|record| record.project_id == project_id && record.task_id == task_id)
            .map(ControlSelectedTaskReviewDecisionRecordDto::from)
            .collect()
    })
}

#[tauri::command]
async fn send_agent_chat_message(
    state: tauri::State<'_, DesktopState>,
    request: LocalCodexChatRequest,
) -> Result<LocalCodexChatReply, String> {
    let chat = Arc::clone(&state.chat);
    let adapter = Arc::clone(&state.adapter);
    let server_state = state.server_state.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let mut chat = chat
            .lock()
            .map_err(|_| "agent chat runtime lock is poisoned".to_owned())?;
        chat.send_message_with_task_authoring(&server_state, request, &mut |control_request| {
            let envelope = ControlRequestEnvelopeDto::try_from(&control_request)
                .map_err(|error| error.reason)?;
            let response = adapter
                .lock()
                .map_err(|_| "desktop command adapter lock is poisoned".to_owned())?
                .submit_control_envelope(envelope)
                .map_err(|error| error.reason)?;
            match response.body {
                ControlResponseBodyDto::CommandReceipt { status, .. }
                    if status == "accepted_for_state_mutation" =>
                {
                    Ok(())
                }
                ControlResponseBodyDto::CommandReceipt { status, .. } => {
                    Err(format!("task ledger command was not accepted: {status}"))
                }
                ControlResponseBodyDto::Error { reason, .. } => Err(reason),
                _ => Err("task ledger command returned an unexpected response".to_owned()),
            }
        })
    })
    .await
    .map_err(|error| format!("agent chat worker failed: {error}"))?
}

#[tauri::command]
async fn load_agent_chat_history(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    conversation_id: String,
) -> Result<LocalCodexChatHistory, String> {
    let chat = Arc::clone(&state.chat);
    let server_state = state.server_state.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let chat = chat
            .lock()
            .map_err(|_| "agent chat runtime lock is poisoned".to_owned())?;
        chat.history(&server_state, &project_id, &conversation_id)
    })
    .await
    .map_err(|error| format!("agent chat history worker failed: {error}"))?
}

#[tauri::command]
async fn list_agent_chat_models() -> Result<Vec<LocalCodexChatModelOption>, String> {
    tauri::async_runtime::spawn_blocking(LocalCodexChatService::available_models)
        .await
        .map_err(|error| format!("agent chat model worker failed: {error}"))?
}

fn seed_local_command_evidence(
    state: &nucleus_server::ServerStateService<SqliteBackend>,
) -> nucleus_local_store::LocalStoreResult<nucleus_local_store::LocalStoreRecord> {
    write_command_evidence(
        state,
        &CommandEvidence {
            id: CommandEvidenceId("command:evidence:nucleus-local:bootstrap".to_owned()),
            request_id: CommandRequestId("command:request:nucleus-local:bootstrap".to_owned()),
            status: CommandExecutionStatus::Succeeded,
            exit_status: Some(0),
            retention: CommandOutputRetention::SummaryOnly,
            summary: Some("desktop bootstrap command evidence seed".to_owned()),
            stdout_artifact_ref: None,
            stderr_artifact_ref: None,
        },
        RevisionId("rev:command-evidence:nucleus-local:bootstrap".to_owned()),
        RevisionExpectation::Any,
    )
}

fn seed_local_provider_readiness_evidence(
    state: &nucleus_server::ServerStateService<SqliteBackend>,
) -> nucleus_local_store::LocalStoreResult<()> {
    let existing_credential_refresh_ids = read_forge_credential_status_refreshes(state)?
        .into_iter()
        .map(|record| record.persisted_refresh_id)
        .collect::<Vec<_>>();
    let existing_repository_refresh_ids = read_forge_repository_metadata_refreshes(state)?
        .into_iter()
        .map(|record| record.persisted_refresh_id)
        .collect::<Vec<_>>();
    let existing_pull_request_refresh_ids = read_forge_pull_request_refreshes(state)?
        .into_iter()
        .map(|record| record.persisted_refresh_id)
        .collect::<Vec<_>>();
    let existing_status_check_refresh_ids = read_forge_status_check_refreshes(state)?
        .into_iter()
        .map(|record| record.persisted_refresh_id)
        .collect::<Vec<_>>();

    let credential_refresh_set =
        forge_credential_status_refresh(ForgeCredentialStatusRefreshInput {
            credential_refs: vec![ForgeNetworkExecutionCredentialRef {
                credential_ref_id: "credential:nucleus-local:github".to_owned(),
                credential_kind: ForgeNetworkCredentialKind::HostCredentialProvider,
                resolution_boundary:
                    ForgeNetworkCredentialResolutionBoundary::HostCredentialProvider,
                status: ForgeNetworkCredentialStatus::Ready,
                allowed_operation_families: vec![
                    ForgeNetworkExecutionOperationFamily::ProviderAuthStatusRefresh,
                ],
            }],
            provider_context_ref: Some("provider-context:nucleus-local:github".to_owned()),
            status_refresh_evidence_ref: Some(
                "evidence:nucleus-local:credential-status".to_owned(),
            ),
            sanitization_policy_ref: Some("sanitize:nucleus-local:provider-readiness".to_owned()),
            credential_material_present: false,
            provider_payload_present: false,
            raw_provider_payload_retention_requested: false,
            real_credential_resolution_requested: false,
            provider_network_call_requested: false,
            callback_execution_requested: false,
            interruption_execution_requested: false,
            recovery_execution_requested: false,
            task_mutation_requested: false,
        });
    persist_forge_credential_status_refreshes(
        state,
        ForgeCredentialStatusRefreshPersistenceInput {
            refresh_set: credential_refresh_set,
            evidence_refs: vec!["evidence:nucleus-local:credential-status".to_owned()],
            existing_persisted_refresh_ids: existing_credential_refresh_ids,
            credential_material_present: false,
            provider_payload_present: false,
            raw_provider_payload_retention_requested: false,
            real_credential_resolution_requested: false,
            provider_network_call_requested: false,
            callback_execution_requested: false,
            interruption_execution_requested: false,
            recovery_execution_requested: false,
            task_mutation_requested: false,
        },
    )?;

    let repository_refresh_set =
        forge_repository_metadata_refresh(ForgeRepositoryMetadataRefreshInput {
            provider_context_refs: vec!["provider-context:nucleus-local:github".to_owned()],
            provider_instance_ref: Some("provider-instance:nucleus-local:github".to_owned()),
            forge_provider: Some(ForgePullRequestProvider::GitHub),
            remote_repo_ref: Some("remote-repo:nucleus-local:github".to_owned()),
            credential_status_evidence_ref: Some(
                "evidence:nucleus-local:credential-status".to_owned(),
            ),
            repository_metadata_evidence_ref: Some(
                "evidence:nucleus-local:repository-metadata".to_owned(),
            ),
            sanitization_policy_ref: Some("sanitize:nucleus-local:provider-readiness".to_owned()),
            credential_material_present: false,
            provider_payload_present: false,
            raw_provider_payload_retention_requested: false,
            real_credential_resolution_requested: false,
            provider_network_call_requested: false,
            callback_execution_requested: false,
            interruption_execution_requested: false,
            recovery_execution_requested: false,
            task_mutation_requested: false,
        });
    persist_forge_repository_metadata_refreshes(
        state,
        ForgeRepositoryMetadataRefreshPersistenceInput {
            refresh_set: repository_refresh_set,
            evidence_refs: vec!["evidence:nucleus-local:repository-metadata".to_owned()],
            existing_persisted_refresh_ids: existing_repository_refresh_ids,
            credential_material_present: false,
            provider_payload_present: false,
            raw_provider_payload_retention_requested: false,
            real_credential_resolution_requested: false,
            provider_network_call_requested: false,
            callback_execution_requested: false,
            interruption_execution_requested: false,
            recovery_execution_requested: false,
            task_mutation_requested: false,
        },
    )?;

    let pull_request_refresh_set = forge_pull_request_refresh(ForgePullRequestRefreshInput {
        provider_context_refs: vec!["provider-context:nucleus-local:github".to_owned()],
        provider_instance_ref: Some("provider-instance:nucleus-local:github".to_owned()),
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        remote_repo_ref: Some("remote-repo:nucleus-local:github".to_owned()),
        refresh_scope: Some(ForgePullRequestRefreshScope::AllOpen),
        credential_status_evidence_ref: Some("evidence:nucleus-local:credential-status".to_owned()),
        repository_metadata_evidence_ref: Some(
            "evidence:nucleus-local:repository-metadata".to_owned(),
        ),
        pull_request_refresh_evidence_ref: Some(
            "evidence:nucleus-local:pull-request-refresh".to_owned(),
        ),
        sanitization_policy_ref: Some("sanitize:nucleus-local:provider-readiness".to_owned()),
        credential_material_present: false,
        provider_payload_present: false,
        raw_provider_payload_retention_requested: false,
        real_credential_resolution_requested: false,
        provider_network_call_requested: false,
        callback_execution_requested: false,
        interruption_execution_requested: false,
        recovery_execution_requested: false,
        task_mutation_requested: false,
    });
    persist_forge_pull_request_refreshes(
        state,
        ForgePullRequestRefreshPersistenceInput {
            refresh_set: pull_request_refresh_set,
            evidence_refs: vec!["evidence:nucleus-local:pull-request-refresh".to_owned()],
            existing_persisted_refresh_ids: existing_pull_request_refresh_ids,
            credential_material_present: false,
            provider_payload_present: false,
            raw_provider_payload_retention_requested: false,
            real_credential_resolution_requested: false,
            provider_network_call_requested: false,
            callback_execution_requested: false,
            interruption_execution_requested: false,
            recovery_execution_requested: false,
            task_mutation_requested: false,
        },
    )?;

    let status_check_refresh_set = forge_status_check_refresh(ForgeStatusCheckRefreshInput {
        provider_context_refs: vec!["provider-context:nucleus-local:github".to_owned()],
        provider_instance_ref: Some("provider-instance:nucleus-local:github".to_owned()),
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        remote_repo_ref: Some("remote-repo:nucleus-local:github".to_owned()),
        refresh_scope: Some(ForgeStatusCheckRefreshScope::ChangeRequestRef(
            "change-request:nucleus-local:github:bootstrap".to_owned(),
        )),
        credential_status_evidence_ref: Some("evidence:nucleus-local:credential-status".to_owned()),
        repository_metadata_evidence_ref: Some(
            "evidence:nucleus-local:repository-metadata".to_owned(),
        ),
        status_check_refresh_evidence_ref: Some(
            "evidence:nucleus-local:status-check-refresh".to_owned(),
        ),
        sanitization_policy_ref: Some("sanitize:nucleus-local:provider-readiness".to_owned()),
        credential_material_present: false,
        provider_payload_present: false,
        raw_provider_payload_retention_requested: false,
        real_credential_resolution_requested: false,
        provider_network_call_requested: false,
        callback_execution_requested: false,
        interruption_execution_requested: false,
        recovery_execution_requested: false,
        task_mutation_requested: false,
    });
    persist_forge_status_check_refreshes(
        state,
        ForgeStatusCheckRefreshPersistenceInput {
            refresh_set: status_check_refresh_set,
            evidence_refs: vec!["evidence:nucleus-local:status-check-refresh".to_owned()],
            existing_persisted_refresh_ids: existing_status_check_refresh_ids,
            credential_material_present: false,
            provider_payload_present: false,
            raw_provider_payload_retention_requested: false,
            real_credential_resolution_requested: false,
            provider_network_call_requested: false,
            callback_execution_requested: false,
            interruption_execution_requested: false,
            recovery_execution_requested: false,
            task_mutation_requested: false,
        },
    )?;

    Ok(())
}

#[tauri::command]
fn submit_control_envelope(
    state: tauri::State<'_, DesktopState>,
    request: ControlRequestEnvelopeDto,
) -> Result<ControlResponseEnvelopeDto, ControlApiCodecError> {
    state.submit_control_envelope(request)
}

#[tauri::command]
fn load_workspace_ui_config() -> Result<workspace_ui::WorkspaceUiConfigDto, String> {
    workspace_ui::load_workspace_ui_config()
}

#[tauri::command]
fn save_workspace_ui_config(
    config: workspace_ui::WorkspaceUiConfigDto,
) -> Result<workspace_ui::WorkspaceUiConfigDto, String> {
    workspace_ui::save_workspace_ui_config(config)
}

pub fn run() {
    tauri::Builder::default()
        .manage(DesktopState::new_with_snapshot_store(
            SqliteBackend::new(desktop_database_path()),
            desktop_snapshot_path(),
        ))
        .setup(|app| {
            app.set_theme(Some(tauri::Theme::Dark));
            if let Some(window) = app.get_webview_window("main") {
                window.set_theme(Some(tauri::Theme::Dark))?;
                if let Err(error) = window_geometry::restore_and_track(&window) {
                    eprintln!("restore native window placement failed: {error}");
                }
                window.show()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            submit_control_envelope,
            send_agent_chat_message,
            load_agent_chat_history,
            list_agent_chat_models,
            load_workspace_ui_config,
            save_workspace_ui_config,
            list_editor_files,
            read_editor_file,
            save_editor_file,
            read_task_diff_overview,
            read_task_diff_file_patch,
            read_task_review_decisions
        ])
        .run(tauri::generate_context!())
        .expect("failed to run nucleus desktop");
}

fn desktop_database_path() -> PathBuf {
    let data_dir = std::env::var_os("HOME")
        .map(PathBuf::from)
        .expect("HOME is required for local desktop state")
        .join(".nucleus")
        .join("state");
    std::fs::create_dir_all(&data_dir).expect("local desktop state directory should be writable");
    data_dir.join("nucleus.sqlite")
}

fn desktop_snapshot_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .expect("HOME is required for local desktop state")
        .join(".nucleus")
        .join("state")
        .join("task-review-snapshots")
}

#[cfg(test)]
mod tests;
