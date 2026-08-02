use longhorn_command::{
    CommandAvailability, CommandAvailabilityReason, CommandAvailabilityReasonCode,
    CommandDiagnostic,
};
use longhorn_core::CommandAvailabilityReasonId;

use super::NucleusCommandState;
use crate::commands::catalogue::NucleusCommandRoute;

impl NucleusCommandState {
    pub(super) fn availability(&self, route: NucleusCommandRoute) -> CommandAvailability {
        use NucleusCommandRoute as Route;
        match route {
            Route::RenameSelectedProject
            | Route::ManageProjectResources
            | Route::ParkSelectedProject
            | Route::ArchiveSelectedProject
            | Route::OpenAgentChatPanel
            | Route::OpenBrowserPanel
            | Route::OpenEditorPanel
            | Route::OpenTerminalPanel
            | Route::OpenTasksPanel
            | Route::OpenDiffPanel
            | Route::OpenMemoryPanel
                if !self.has_selected_project =>
            {
                unavailable(
                    "nucleus:no-selected-project",
                    "Select a project before running this command.",
                )
            }
            Route::RenameActiveThread | Route::ConvertThreadToProject
                if !self.has_active_thread =>
            {
                unavailable(
                    "nucleus:no-active-thread",
                    "Open an Agent Chat thread before running this command.",
                )
            }
            Route::CloseActivePanel if !self.has_active_panel => unavailable(
                "nucleus:no-active-panel",
                "Focus a workspace panel before running this command.",
            ),
            Route::QuickOpenFile if !self.has_selected_project => unavailable(
                "nucleus:no-selected-project",
                "Select a project before opening a file.",
            ),
            Route::SaveEditorFile if !self.has_open_editor_file => {
                unavailable("nucleus:no-open-editor-file", "Open a file before saving.")
            }
            Route::SaveEditorFile if !self.editor_dirty => unavailable(
                "nucleus:editor-clean",
                "The active editor has no unsaved changes.",
            ),
            Route::RefreshForge if !self.forge_refreshable => unavailable(
                "nucleus:forge-unavailable",
                "The selected project has no refreshable working copy.",
            ),
            Route::CancelAgentTurn if !self.turn_running => {
                unavailable("nucleus:no-active-turn", "No Agent Chat turn is running.")
            }
            _ => CommandAvailability::available(),
        }
    }
}

fn unavailable(code: &str, detail: &str) -> CommandAvailability {
    CommandAvailability::unavailable(CommandAvailabilityReason::new(
        CommandAvailabilityReasonCode::Consumer(
            CommandAvailabilityReasonId::new(code).expect("static availability reason id"),
        ),
        Some(CommandDiagnostic::new(detail).expect("static command diagnostic")),
    ))
}
