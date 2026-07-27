use std::path::{Path, PathBuf};
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
    seed_local_project_with_resource_root, seed_local_research_run_brief, seed_local_task,
    write_command_evidence, ControlApiCodecError, ControlRequestEnvelopeDto,
    ControlResponseBodyDto, ControlResponseEnvelopeDto, EditorDirectoryEntry,
    EditorFileCreateRequest, EditorFileDeleteReceipt, EditorFileDeleteRequest, EditorFileEntry,
    EditorFileRenameRequest, EditorFileSaveRequest, EditorFileSnapshot, EditorFileWatchRuntime,
    ForgeCredentialStatusRefreshInput, ForgeCredentialStatusRefreshPersistenceInput,
    ForgeNetworkCredentialKind, ForgeNetworkCredentialResolutionBoundary,
    ForgeNetworkCredentialStatus, ForgeNetworkExecutionCredentialRef,
    ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider, ForgePullRequestRefreshInput,
    ForgePullRequestRefreshPersistenceInput, ForgePullRequestRefreshScope,
    ForgeRepositoryMetadataRefreshInput, ForgeRepositoryMetadataRefreshPersistenceInput,
    ForgeStatusCheckRefreshInput, ForgeStatusCheckRefreshPersistenceInput,
    ForgeStatusCheckRefreshScope, LocalCodexChatCancellationRegistry, LocalCodexChatHistory,
    LocalCodexChatModelOption, LocalCodexChatReply, LocalCodexChatRequest, LocalCodexChatService,
    LocalCodexChatThreadSummary, LocalControlRequestHandler, LocalMemoryProposalSeed,
    LocalPlanningSessionSeed, LocalProjectSeed, LocalResearchRunBriefSeed, LocalTaskSeed,
    ServerStateService, TaskDiffFilePatchRequest, TaskDiffFilePatchResponse,
    TaskDiffOverviewRequest, TaskDiffOverviewResponse, TaskReviewSnapshotStore,
    TauriIpcControlCommandAdapter, TerminalHostRuntime,
};

mod browser_panel;
mod desktop_profile;
mod editor_directories;
mod editor_drafts;
mod editor_file_watch;
mod scm_working_copy;
mod terminal_panel;
mod window_geometry;
mod workspace_ui;

struct DesktopState {
    adapter: Arc<Mutex<TauriIpcControlCommandAdapter<SqliteBackend>>>,
    chat: Arc<Mutex<LocalCodexChatService>>,
    chat_cancellation: LocalCodexChatCancellationRegistry,
    editor_drafts_path: PathBuf,
    editor_file_watch: EditorFileWatchRuntime,
    server_state: ServerStateService<SqliteBackend>,
    startup_error: Option<String>,
    task_review_snapshot_store: Option<TaskReviewSnapshotStore>,
    terminal: TerminalHostRuntime,
    workspace_ui_config_path: PathBuf,
}

/// Startup posture reported to the UI: storage posture, seeding outcome.
#[derive(Clone, serde::Serialize)]
struct DesktopStartupStatus {
    fixture_backed: bool,
    startup_error: Option<String>,
}

#[tauri::command]
fn desktop_startup_status(state: tauri::State<'_, DesktopState>) -> DesktopStartupStatus {
    DesktopStartupStatus {
        fixture_backed: true,
        startup_error: state.startup_error.clone(),
    }
}

/// Seed local fixture state once while still applying bounded migrations to
/// an existing local project record.
fn seed_fixture_state(
    handler: &LocalControlRequestHandler<SqliteBackend>,
    proof_fixture_root: Option<&Path>,
) -> Result<(), String> {
    let seed = LocalProjectSeed::nucleus_local();
    let project_exists = handler
        .state()
        .projects()
        .get(&nucleus_core::PersistenceRecordId(seed.project_id.clone()))
        .map_err(|error| format!("startup storage probe failed: {error}"))?
        .is_some();
    seed_local_project_with_resource_root(
        handler.state(),
        seed,
        proof_fixture_root.map(Path::to_path_buf),
    )
    .map_err(|error| format!("startup seed failed at project: {error:?}"))?;
    if project_exists {
        return Ok(());
    }
    seed_local_task(handler.state(), LocalTaskSeed::nucleus_local_bootstrap())
        .map_err(|error| format!("startup seed failed at task: {error:?}"))?;
    seed_local_command_evidence(handler.state())
        .map_err(|error| format!("startup seed failed at command evidence: {error:?}"))?;
    seed_local_provider_readiness_evidence(handler.state()).map_err(|error| {
        format!("startup seed failed at provider readiness evidence: {error:?}")
    })?;
    seed_local_planning_session(
        handler.state(),
        LocalPlanningSessionSeed::nucleus_local_bootstrap(),
    )
    .map_err(|error| format!("startup seed failed at planning session: {error:?}"))?;
    seed_local_memory_proposal(
        handler.state(),
        LocalMemoryProposalSeed::nucleus_local_bootstrap(),
    )
    .map_err(|error| format!("startup seed failed at memory proposal: {error:?}"))?;
    seed_local_research_run_brief(
        handler.state(),
        LocalResearchRunBriefSeed::nucleus_local_bootstrap(),
    )
    .map_err(|error| format!("startup seed failed at research run brief: {error:?}"))?;
    Ok(())
}

#[tauri::command]
async fn list_editor_files(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    resource_id: Option<String>,
) -> Result<Vec<EditorFileEntry>, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        nucleus_server::list_editor_files(&server_state, &project_id, resource_id.as_deref())
    })
    .await
    .map_err(|_| "desktop editor worker failed".to_owned())?
}

#[tauri::command]
async fn search_editor_files(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    resource_id: Option<String>,
    query: String,
    limit: usize,
) -> Result<Vec<EditorFileEntry>, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        nucleus_server::search_editor_files(
            &server_state,
            &project_id,
            resource_id.as_deref(),
            &query,
            limit,
        )
    })
    .await
    .map_err(|_| "desktop editor search worker failed".to_owned())?
}

#[tauri::command]
async fn list_editor_directory(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    resource_id: Option<String>,
    directory_path: Option<String>,
) -> Result<Vec<EditorDirectoryEntry>, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        nucleus_server::list_editor_directory(
            &server_state,
            &project_id,
            resource_id.as_deref(),
            directory_path.as_deref(),
        )
    })
    .await
    .map_err(|_| "desktop editor directory worker failed".to_owned())?
}

#[tauri::command]
async fn read_editor_file(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    resource_id: Option<String>,
    file_ref: String,
    display_path: Option<String>,
) -> Result<EditorFileSnapshot, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || match display_path {
        Some(display_path) => nucleus_server::read_editor_file_at_path(
            &server_state,
            &project_id,
            resource_id.as_deref(),
            &file_ref,
            &display_path,
        ),
        None => nucleus_server::read_editor_file(
            &server_state,
            &project_id,
            resource_id.as_deref(),
            &file_ref,
        ),
    })
    .await
    .map_err(|_| "desktop editor worker failed".to_owned())?
}

#[tauri::command]
async fn save_editor_file(
    state: tauri::State<'_, DesktopState>,
    request: EditorFileSaveRequest,
) -> Result<EditorFileSnapshot, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        nucleus_server::save_editor_file(&server_state, &request)
    })
    .await
    .map_err(|_| "desktop editor worker failed".to_owned())?
}

#[tauri::command]
async fn create_editor_file(
    state: tauri::State<'_, DesktopState>,
    request: EditorFileCreateRequest,
) -> Result<EditorFileSnapshot, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        nucleus_server::create_editor_file(&server_state, &request)
    })
    .await
    .map_err(|_| "desktop editor create worker failed".to_owned())?
}

#[tauri::command]
async fn rename_editor_file(
    state: tauri::State<'_, DesktopState>,
    request: EditorFileRenameRequest,
) -> Result<EditorFileSnapshot, String> {
    let server_state = state.server_state.clone();
    let drafts_path = state.editor_drafts_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let renamed = nucleus_server::rename_editor_file(&server_state, &request)?;
        if let Err(error) = editor_drafts::move_file_draft(
            &drafts_path,
            &request.project_id,
            request
                .resource_id
                .as_deref()
                .unwrap_or(&renamed.resource_id),
            &request.file_ref,
            &renamed,
        ) {
            eprintln!("move editor recovery draft after rename failed: {error}");
        }
        Ok(renamed)
    })
    .await
    .map_err(|_| "desktop editor rename worker failed".to_owned())?
}

#[tauri::command]
async fn delete_editor_file(
    state: tauri::State<'_, DesktopState>,
    request: EditorFileDeleteRequest,
) -> Result<EditorFileDeleteReceipt, String> {
    let server_state = state.server_state.clone();
    let drafts_path = state.editor_drafts_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let deleted = nucleus_server::delete_editor_file(&server_state, &request)?;
        if let Err(error) = editor_drafts::delete_file_draft(
            &drafts_path,
            &deleted.project_id,
            &deleted.resource_id,
            &deleted.file_ref,
        ) {
            eprintln!("delete editor recovery draft after file removal failed: {error}");
        }
        Ok(deleted)
    })
    .await
    .map_err(|_| "desktop editor delete worker failed".to_owned())?
}

impl DesktopState {
    #[cfg(test)]
    fn new(backend: SqliteBackend) -> Self {
        Self::with_chat(
            backend,
            LocalCodexChatService::default(),
            None,
            PathBuf::from("target/nucleus-desktop-test/editor-drafts"),
            PathBuf::from("target/nucleus-desktop-test/ui.json"),
            None,
        )
    }

    #[cfg(test)]
    fn new_with_proof_fixture(backend: SqliteBackend, proof_fixture_root: PathBuf) -> Self {
        Self::with_chat(
            backend,
            LocalCodexChatService::default(),
            None,
            PathBuf::from("target/nucleus-desktop-test/editor-drafts"),
            PathBuf::from("target/nucleus-desktop-test/ui.json"),
            Some(proof_fixture_root),
        )
    }

    fn new_with_profile(
        backend: SqliteBackend,
        snapshot_root: PathBuf,
        editor_drafts_path: PathBuf,
        workspace_ui_config_path: PathBuf,
        chat_turn_timeout: std::time::Duration,
        proof_fixture_root: Option<PathBuf>,
    ) -> Self {
        let snapshot_store = TaskReviewSnapshotStore::new(snapshot_root)
            .expect("local task review snapshot store should be writable");
        Self::with_chat(
            backend,
            LocalCodexChatService::with_task_review_snapshot_store_and_turn_timeout(
                snapshot_store.clone(),
                chat_turn_timeout,
            ),
            Some(snapshot_store),
            editor_drafts_path,
            workspace_ui_config_path,
            proof_fixture_root,
        )
    }

    fn with_chat(
        backend: SqliteBackend,
        chat: LocalCodexChatService,
        task_review_snapshot_store: Option<TaskReviewSnapshotStore>,
        editor_drafts_path: PathBuf,
        workspace_ui_config_path: PathBuf,
        proof_fixture_root: Option<PathBuf>,
    ) -> Self {
        let server_state = ServerStateService::new(backend.clone());
        let handler = LocalControlRequestHandler::new(backend, None);
        let startup_error = seed_fixture_state(&handler, proof_fixture_root.as_deref()).err();
        let adapter = TauriIpcControlCommandAdapter::fixture_backed(handler);

        Self {
            adapter: Arc::new(Mutex::new(adapter)),
            chat: Arc::new(Mutex::new(chat)),
            chat_cancellation: LocalCodexChatCancellationRegistry::default(),
            editor_drafts_path,
            editor_file_watch: EditorFileWatchRuntime::default(),
            server_state,
            startup_error,
            task_review_snapshot_store,
            terminal: TerminalHostRuntime::default(),
            workspace_ui_config_path,
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
async fn read_task_diff_overview(
    state: tauri::State<'_, DesktopState>,
    request: TaskDiffOverviewRequest,
) -> Result<TaskDiffOverviewResponse, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        nucleus_server::read_task_diff_overview(&server_state, &request)
    })
    .await
    .map_err(|_| "desktop diff worker failed".to_owned())?
}

#[tauri::command]
async fn read_task_diff_file_patch(
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
async fn read_task_review_decisions(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    task_id: String,
) -> Result<Vec<ControlSelectedTaskReviewDecisionRecordDto>, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        nucleus_server::selected_task_review_decision_records::read_selected_task_review_decisions(
            &server_state,
        )
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

#[tauri::command]
async fn send_agent_chat_message(
    state: tauri::State<'_, DesktopState>,
    request: LocalCodexChatRequest,
) -> Result<LocalCodexChatReply, String> {
    let active_turn = state
        .chat_cancellation
        .begin(&request.project_id, &request.conversation_id)?;
    let cancellation = active_turn.cancellation();
    let chat = Arc::clone(&state.chat);
    let adapter = Arc::clone(&state.adapter);
    let server_state = state.server_state.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _active_turn = active_turn;
        let mut chat = chat
            .lock()
            .map_err(|_| "agent chat runtime lock is poisoned".to_owned())?;
        chat.send_message_with_task_authoring_and_cancellation(
            &server_state,
            request,
            cancellation,
            &mut |control_request| {
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
            },
        )
    })
    .await
    .map_err(|error| format!("agent chat worker failed: {error}"))?
}

#[tauri::command]
fn cancel_agent_chat_turn(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    conversation_id: String,
) -> Result<bool, String> {
    state
        .chat_cancellation
        .request(&project_id, &conversation_id)
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
async fn list_agent_chat_threads(
    state: tauri::State<'_, DesktopState>,
) -> Result<Vec<LocalCodexChatThreadSummary>, String> {
    let chat = Arc::clone(&state.chat);
    let server_state = state.server_state.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let chat = chat
            .lock()
            .map_err(|_| "agent chat runtime lock is poisoned".to_owned())?;
        chat.threads(&server_state)
    })
    .await
    .map_err(|error| format!("agent chat thread worker failed: {error}"))?
}

#[tauri::command]
async fn rename_agent_chat_thread(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    conversation_id: String,
    title: String,
) -> Result<(), String> {
    let chat = Arc::clone(&state.chat);
    let server_state = state.server_state.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let chat = chat
            .lock()
            .map_err(|_| "agent chat runtime lock is poisoned".to_owned())?;
        chat.rename_thread(&server_state, &project_id, &conversation_id, &title)
    })
    .await
    .map_err(|error| format!("agent chat thread rename worker failed: {error}"))?
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
async fn submit_control_envelope(
    state: tauri::State<'_, DesktopState>,
    request: ControlRequestEnvelopeDto,
) -> Result<ControlResponseEnvelopeDto, ControlApiCodecError> {
    // Storage IO runs off the main thread; the adapter mutex no longer
    // serializes panel queries through the UI thread.
    let adapter = state.adapter.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut adapter = adapter.lock().map_err(|_| ControlApiCodecError {
            failure: nucleus_server::ControlApiCodecFailure::ServerErrorPayload,
            reason: "desktop command adapter lock is poisoned".to_owned(),
        })?;
        adapter.submit_control_envelope(request)
    })
    .await
    .map_err(|_| ControlApiCodecError {
        failure: nucleus_server::ControlApiCodecFailure::ServerErrorPayload,
        reason: "desktop command worker failed".to_owned(),
    })?
}

#[tauri::command]
fn load_workspace_ui_config(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
) -> Result<workspace_ui::WorkspaceUiConfigDto, String> {
    workspace_ui::load_workspace_ui_config(&state.workspace_ui_config_path, &project_id)
}

#[tauri::command]
fn save_workspace_ui_config(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    config: workspace_ui::WorkspaceUiConfigDto,
) -> Result<workspace_ui::WorkspaceUiConfigDto, String> {
    workspace_ui::save_workspace_ui_config(&state.workspace_ui_config_path, &project_id, config)
}

pub fn run() {
    let profile = desktop_profile::DesktopProfile::from_environment()
        .expect("invalid Nucleus desktop profile");
    profile
        .prepare()
        .expect("Nucleus desktop profile should be writable");
    let workspace_ui_config_path = profile.workspace_ui_config_path();
    let editor_drafts_path = profile.editor_drafts_path();
    let proof_fixture_root = profile.proof_fixture_root().map(Path::to_path_buf);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(DesktopState::new_with_profile(
            SqliteBackend::new(profile.database_path()),
            profile.snapshot_path(),
            editor_drafts_path,
            workspace_ui_config_path.clone(),
            profile.chat_turn_timeout(),
            proof_fixture_root,
        ))
        .setup(move |app| {
            app.set_theme(Some(tauri::Theme::Dark));
            if let Some(window) = app.get_webview_window("main") {
                window.set_theme(Some(tauri::Theme::Dark))?;
                if let Err(error) =
                    window_geometry::restore_and_track(&window, workspace_ui_config_path.clone())
                {
                    eprintln!("restore native window placement failed: {error}");
                }
                window.show()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            submit_control_envelope,
            send_agent_chat_message,
            cancel_agent_chat_turn,
            load_agent_chat_history,
            list_agent_chat_threads,
            rename_agent_chat_thread,
            list_agent_chat_models,
            load_workspace_ui_config,
            save_workspace_ui_config,
            desktop_startup_status,
            list_editor_directory,
            list_editor_files,
            search_editor_files,
            read_editor_file,
            save_editor_file,
            create_editor_file,
            rename_editor_file,
            delete_editor_file,
            editor_directories::create_editor_directory,
            editor_directories::rename_editor_directory,
            editor_directories::delete_editor_directory,
            editor_drafts::editor_draft_load,
            editor_drafts::editor_draft_save,
            editor_drafts::editor_draft_delete,
            editor_file_watch::editor_file_watch_start,
            editor_file_watch::editor_file_watch_stop,
            scm_working_copy::inspect_scm_working_copies,
            scm_working_copy::read_scm_working_copy_diff_command,
            scm_working_copy::mutate_scm_working_copy_command,
            scm_working_copy::commit_scm_working_copy_command,
            read_task_diff_overview,
            read_task_diff_file_patch,
            read_task_review_decisions,
            browser_panel::browser_panel_ensure,
            browser_panel::browser_panel_set_bounds,
            browser_panel::browser_panel_reset_cursor,
            browser_panel::browser_panel_navigate,
            browser_panel::browser_panel_action,
            browser_panel::browser_panel_current_url,
            terminal_panel::terminal_open_or_attach,
            terminal_panel::terminal_write,
            terminal_panel::terminal_resize,
            terminal_panel::terminal_close,
            terminal_panel::terminal_close_for_panel,
            terminal_panel::terminal_close_for_project
        ])
        .run(tauri::generate_context!())
        .expect("failed to run nucleus desktop");
}

#[cfg(test)]
mod tests;
