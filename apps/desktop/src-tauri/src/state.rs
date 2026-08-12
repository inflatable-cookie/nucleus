//! Desktop managed state: storage, chat runtime, editor watch, terminal,
//! workspace UI, and the startup posture reported to the UI.
//!
//! Module index over the state surface: the managed state record, startup
//! posture, and the fixture seeding that runs at startup.

use std::path::PathBuf;
#[cfg(test)]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};

use nucleus_local_store::SqliteBackend;
use nucleus_server::{
    LocalCodexChatCancellationRegistry, LocalCodexChatQuestionRegistry, LocalCodexChatService,
    EditorFileWatchRuntime, ServerStateService, TaskReviewSnapshotStore,
    TauriIpcControlCommandAdapter, TerminalHostRuntime,
};

mod seeds;

use seeds::seed_fixture_state;

use crate::{storage_migration, window_host, workspace_ui};

#[cfg(test)]
use nucleus_server::{ControlApiCodecError, ControlApiCodecFailure, ControlRequestEnvelopeDto, ControlResponseEnvelopeDto};

pub(crate) struct DesktopState {
    pub(crate) adapter: Arc<Mutex<TauriIpcControlCommandAdapter<SqliteBackend>>>,
    pub(crate) chat: Arc<Mutex<LocalCodexChatService>>,
    pub(crate) chat_cancellation: LocalCodexChatCancellationRegistry,
    pub(crate) chat_questions: LocalCodexChatQuestionRegistry,
    pub(crate) editor_drafts_path: PathBuf,
    pub(crate) editor_file_watch: EditorFileWatchRuntime,
    pub(crate) server_state: ServerStateService<SqliteBackend>,
    pub(crate) startup_error: Option<String>,
    pub(crate) task_review_snapshot_store: Option<TaskReviewSnapshotStore>,
    pub(crate) terminal: TerminalHostRuntime,
    pub(crate) workspace_ui: Arc<workspace_ui::WorkspaceUiRuntime>,
    pub(crate) storage_profile_id: String,
    pub(crate) storage_layout_digest: String,
    pub(crate) legacy_import_receipt: Option<storage_migration::LegacyImportReceipt>,
}

/// Startup posture reported to the UI: storage posture, seeding outcome.
#[derive(Clone, serde::Serialize)]
pub(crate) struct DesktopStartupStatus {
    fixture_backed: bool,
    startup_error: Option<String>,
    window_restore_complete: bool,
    storage_profile_id: String,
    storage_layout_digest: String,
    legacy_import_receipt: Option<storage_migration::LegacyImportReceipt>,
}

#[tauri::command]
pub(crate) fn desktop_startup_status(
    state: tauri::State<'_, DesktopState>,
    window: tauri::State<'_, window_host::NucleusWindowRuntime>,
) -> DesktopStartupStatus {
    DesktopStartupStatus {
        fixture_backed: true,
        startup_error: state
            .startup_error
            .clone()
            .or_else(|| window.restore_error()),
        window_restore_complete: window.initial_restore_complete(),
        storage_profile_id: state.storage_profile_id.clone(),
        storage_layout_digest: state.storage_layout_digest.clone(),
        legacy_import_receipt: state.legacy_import_receipt.clone(),
    }
}

impl DesktopState {
    #[cfg(test)]
    pub(crate) fn new(backend: SqliteBackend) -> Self {
        Self::with_chat(
            backend,
            LocalCodexChatService::default(),
            None,
            PathBuf::from("target/nucleus-desktop-test/editor-drafts"),
            test_workspace_ui_runtime(),
            None,
            "test-v1".to_owned(),
            "test-layout".to_owned(),
            None,
        )
    }

    #[cfg(test)]
    pub(crate) fn new_with_proof_fixture(backend: SqliteBackend, proof_fixture_root: PathBuf) -> Self {
        Self::with_chat(
            backend,
            LocalCodexChatService::default(),
            None,
            PathBuf::from("target/nucleus-desktop-test/editor-drafts"),
            test_workspace_ui_runtime(),
            Some(proof_fixture_root),
            "test-v1".to_owned(),
            "test-layout".to_owned(),
            None,
        )
    }

    pub(crate) fn new_with_profile(
        backend: SqliteBackend,
        snapshot_root: PathBuf,
        editor_drafts_path: PathBuf,
        workspace_ui: Arc<workspace_ui::WorkspaceUiRuntime>,
        chat_turn_timeout: std::time::Duration,
        proof_fixture_root: Option<PathBuf>,
        storage_profile_id: String,
        storage_layout_digest: String,
        legacy_import_receipt: Option<storage_migration::LegacyImportReceipt>,
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
            workspace_ui,
            proof_fixture_root,
            storage_profile_id,
            storage_layout_digest,
            legacy_import_receipt,
        )
    }

    fn with_chat(
        backend: SqliteBackend,
        chat: LocalCodexChatService,
        task_review_snapshot_store: Option<TaskReviewSnapshotStore>,
        editor_drafts_path: PathBuf,
        workspace_ui: Arc<workspace_ui::WorkspaceUiRuntime>,
        proof_fixture_root: Option<PathBuf>,
        storage_profile_id: String,
        storage_layout_digest: String,
        legacy_import_receipt: Option<storage_migration::LegacyImportReceipt>,
    ) -> Self {
        let server_state = ServerStateService::new(backend.clone());
        let handler = nucleus_server::LocalControlRequestHandler::new(backend, None);
        let startup_error = seed_fixture_state(&handler, proof_fixture_root.as_deref())
            .err()
            .or_else(|| nucleus_server::recover_interrupted_chat_state(&server_state).err());
        let adapter = TauriIpcControlCommandAdapter::fixture_backed(handler);

        Self {
            adapter: Arc::new(Mutex::new(adapter)),
            chat: Arc::new(Mutex::new(chat)),
            chat_cancellation: LocalCodexChatCancellationRegistry::default(),
            chat_questions: LocalCodexChatQuestionRegistry::default(),
            editor_drafts_path,
            editor_file_watch: EditorFileWatchRuntime::default(),
            server_state,
            startup_error,
            task_review_snapshot_store,
            terminal: TerminalHostRuntime::default(),
            workspace_ui,
            storage_profile_id,
            storage_layout_digest,
            legacy_import_receipt,
        }
    }

    #[cfg(test)]
    pub(crate) fn submit_control_envelope(
        &self,
        request: ControlRequestEnvelopeDto,
    ) -> Result<ControlResponseEnvelopeDto, ControlApiCodecError> {
        let mut adapter = self.adapter.lock().map_err(|_| ControlApiCodecError {
            failure: ControlApiCodecFailure::ServerErrorPayload,
            reason: "desktop command adapter lock is poisoned".to_owned(),
        })?;

        adapter.submit_control_envelope(request)
    }
}

#[cfg(test)]
pub(crate) fn test_workspace_ui_runtime() -> Arc<workspace_ui::WorkspaceUiRuntime> {
    static RUNTIME: OnceLock<Arc<workspace_ui::WorkspaceUiRuntime>> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            let root = std::env::current_dir()
                .expect("desktop test current directory")
                .join("target/nucleus-desktop-test/workspace-ui");
            let config = root.join("config");
            let data = root.join("data");
            let state = root.join("state");
            let cache = root.join("cache");
            let runtime = root.join("runtime");
            let log = root.join("logs");
            let backup = root.join("backups");
            for path in [&config, &data, &state, &cache, &runtime, &log, &backup] {
                std::fs::create_dir_all(path).expect("desktop test storage root");
            }
            let roots = longhorn_config::StorageRoots::new(
                &config, &data, &state, &cache, &runtime, &log, &backup,
            )
            .expect("desktop test storage roots");
            let paths = workspace_ui::WorkspaceUiPaths::new(
                state.join("window-placement.json"),
                config.join("project-layouts.json"),
                config.join("project-panel-presentations.json"),
                backup.join("legacy-project-layouts.json"),
                backup.join("legacy-project-layouts.receipt.json"),
            );
            Arc::new(
                workspace_ui::WorkspaceUiRuntime::new(roots, &paths)
                    .expect("desktop test workspace UI runtime"),
            )
        })
        .clone()
}
