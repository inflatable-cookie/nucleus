//! Nucleus desktop Tauri application entry: managed state, command surface
//! registration, and app lifecycle.
//!
//! Command groups live in themed modules (`chat_commands`, `editor_commands`,
//! `workspace_commands`, `task_review_commands`, `control_commands`); state
//! construction and fixture seeding live in `state`.

use std::path::Path;
use std::sync::Arc;

use tauri::Manager;

use nucleus_local_store::SqliteBackend;

mod bridge;
mod browser_panel;
mod chat_commands;
mod commands;
mod config_operations;
mod control_commands;
mod desktop_profile;
mod editor_commands;
mod editor_directories;
mod editor_drafts;
mod editor_file_watch;
mod notifications;
mod operations;
mod scm_working_copy;
mod settings;
mod state;
mod storage_migration;
mod task_review_commands;
mod terminal_panel;
mod window_host;
mod workspace_commands;
mod workspace_ui;

pub(crate) use state::DesktopState;

#[cfg(test)]
pub(crate) use state::test_workspace_ui_runtime;

#[tauri::command]
fn desktop_window_page_ready(
    window: tauri::State<'_, window_host::NucleusWindowRuntime>,
) -> Result<longhorn_tauri_windowing::WindowRevealReceipt, String> {
    window.mark_page_ready()
}

fn desktop_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let (facts, home) = desktop_profile::host_storage_facts(app.handle())?;
            let profile = desktop_profile::DesktopProfile::from_environment(facts, &home)
                .map_err(std::io::Error::other)?;
            profile.prepare().map_err(std::io::Error::other)?;
            config_operations::restore::run_before_authorities(&profile)
                .map_err(std::io::Error::other)?;
            let workspace_ui_paths = profile.workspace_ui_paths();
            let workspace_ui = Arc::new(
                workspace_ui::WorkspaceUiRuntime::new(
                    profile.storage_roots().clone(),
                    &workspace_ui_paths,
                )
                .map_err(std::io::Error::other)?,
            );
            app.set_theme(Some(tauri::Theme::Dark));
            if let Some(window) = app.get_webview_window("main") {
                window.set_theme(Some(tauri::Theme::Dark))?;
            }
            window_host::install(app, &profile).map_err(std::io::Error::other)?;
            browser_panel::install(app);
            commands::install(app, profile.storage_roots().clone())
                .map_err(std::io::Error::other)?;
            notifications::install(
                app,
                profile.storage_roots().state().join("notifications.json"),
            )
            .map_err(std::io::Error::other)?;
            operations::install(app).map_err(std::io::Error::other)?;
            config_operations::install(app, profile.clone()).map_err(std::io::Error::other)?;
            settings::install(app, profile.settings_roots()).map_err(std::io::Error::other)?;
            let desktop_state = state::DesktopState::new_with_profile(
                SqliteBackend::new(profile.database_path()),
                profile.snapshot_path(),
                profile.editor_drafts_path(),
                workspace_ui,
                profile.chat_turn_timeout(),
                profile.proof_fixture_root().map(Path::to_path_buf),
                profile.profile_id().to_owned(),
                profile.layout_digest().to_owned(),
                profile.legacy_import_receipt().cloned(),
            );
            bridge::install(app, Arc::clone(&desktop_state.adapter))
                .map_err(std::io::Error::other)?;
            app.manage(desktop_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            control_commands::submit_control_envelope,
            chat_commands::send_agent_chat_message,
            chat_commands::cancel_agent_chat_turn,
            chat_commands::answer_agent_chat_question,
            chat_commands::decide_agent_chat_plan,
            chat_commands::select_agent_chat_actor,
            chat_commands::load_agent_chat_history,
            chat_commands::list_agent_chat_threads,
            chat_commands::rename_agent_chat_thread,
            chat_commands::delete_agent_chat_thread,
            chat_commands::agent_chat_provider_catalogue,
            chat_commands::agent_chat_credential_action,
            workspace_commands::workspace_layout_snapshot,
            workspace_commands::prepare_workspace_panel,
            workspace_commands::mutate_workspace_layout,
            workspace_commands::update_workspace_panel_presentation,
            workspace_commands::update_workspace_project_context,
            state::desktop_startup_status,
            desktop_window_page_ready,
            editor_commands::list_editor_directory,
            editor_commands::list_editor_files,
            editor_commands::search_editor_files,
            editor_commands::read_editor_file,
            editor_commands::save_editor_file,
            editor_commands::create_editor_file,
            editor_commands::rename_editor_file,
            editor_commands::delete_editor_file,
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
            task_review_commands::read_task_diff_overview,
            task_review_commands::read_task_diff_file_patch,
            task_review_commands::read_task_review_decisions,
            browser_panel::commands::longhorn_native_content_connect,
            browser_panel::commands::longhorn_native_content_snapshot,
            browser_panel::commands::longhorn_native_content_update_desired,
            browser_panel::commands::longhorn_native_content_decide_size,
            browser_panel::commands::browser_panel_destroy,
            browser_panel::commands::browser_panel_hide_for_unmount,
            browser_panel::commands::browser_panel_reset_cursor,
            browser_panel::commands::browser_panel_navigate,
            browser_panel::commands::browser_panel_action,
            browser_panel::commands::browser_panel_current_url,
            longhorn_tauri_command::longhorn_command_catalogue,
            longhorn_tauri_command::longhorn_command_keymap,
            longhorn_tauri_command::longhorn_command_keymap_preview,
            longhorn_tauri_command::longhorn_command_keymap_commit,
            longhorn_tauri_command::longhorn_command_keymap_reset,
            longhorn_tauri_operation::longhorn_operation_snapshot,
            longhorn_tauri_operation::longhorn_operation_mutate,
            longhorn_tauri_operation::longhorn_operation_cancel,
            longhorn_tauri_notifications::longhorn_notifications_snapshot,
            longhorn_tauri_notifications::longhorn_notifications_mutate,
            longhorn_tauri_config::longhorn_config_snapshot,
            longhorn_tauri_config::longhorn_config_storage_inspect,
            longhorn_tauri_config::longhorn_config_storage_execute,
            longhorn_tauri_config::longhorn_config_storage_recover,
            longhorn_tauri_config::longhorn_config_storage_cleanup,
            longhorn_tauri_config::longhorn_config_backup_create,
            config_operations::export::longhorn_config_backup_export,
            longhorn_tauri_config::longhorn_config_backup_retention,
            config_operations::restore::commands::nucleus_config_restore_prepare,
            config_operations::restore::commands::nucleus_config_restore_status,
            config_operations::restore::commands::nucleus_config_restore_confirm,
            longhorn_tauri_config::longhorn_config_restore_inspect,
            longhorn_tauri_config::longhorn_config_restore_plan,
            longhorn_tauri_config::longhorn_config_restore_execute,
            longhorn_tauri_config::longhorn_config_restore_adapter_execute,
            longhorn_tauri_config::longhorn_config_restore_recover,
            longhorn_tauri_bridge::longhorn_bridge_hello,
            longhorn_tauri_bridge::longhorn_bridge_authority,
            longhorn_tauri_bridge::longhorn_bridge_query,
            longhorn_tauri_bridge::longhorn_bridge_command,
            longhorn_tauri_bridge::longhorn_bridge_cancel,
            longhorn_tauri_bridge::longhorn_bridge_resync,
            settings::longhorn_settings_registry,
            settings::longhorn_settings_load,
            settings::longhorn_settings_apply,
            settings::longhorn_settings_reset,
            terminal_panel::terminal_open_or_attach,
            terminal_panel::terminal_write,
            terminal_panel::terminal_resize,
            terminal_panel::terminal_close,
            terminal_panel::terminal_close_for_panel,
            terminal_panel::terminal_close_for_project
        ])
        .build(desktop_context())
        .expect("failed to build nucleus desktop");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            app.state::<browser_panel::BrowserPanelRuntime>().teardown();
            window_host::teardown(app);
        }
    });
}

#[cfg(test)]
mod tests;
