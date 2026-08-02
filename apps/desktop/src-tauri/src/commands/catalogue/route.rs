use super::COMMAND_SPEC_GROUPS;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NucleusCommandRoute {
    ShowCommandPalette,
    OpenSettings,
    CreateProject,
    ManageProjects,
    RefreshProjects,
    ShowProjects,
    ShowThreads,
    ShowFiles,
    ShowForge,
    RenameSelectedProject,
    ManageProjectResources,
    ParkSelectedProject,
    ArchiveSelectedProject,
    RenameActiveThread,
    ConvertThreadToProject,
    OpenAgentChatPanel,
    OpenBrowserPanel,
    OpenEditorPanel,
    OpenTerminalPanel,
    OpenTasksPanel,
    OpenDiffPanel,
    OpenMemoryPanel,
    CloseActivePanel,
    QuickOpenFile,
    SaveEditorFile,
    RefreshForge,
    CancelAgentTurn,
}

impl NucleusCommandRoute {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::ShowCommandPalette => "nucleus.route.shell.show-command-palette",
            Self::OpenSettings => "nucleus.route.shell.open-settings",
            Self::CreateProject => "nucleus.route.project.create",
            Self::ManageProjects => "nucleus.route.project.manage",
            Self::RefreshProjects => "nucleus.route.project.refresh",
            Self::ShowProjects => "nucleus.route.sidebar.show-projects",
            Self::ShowThreads => "nucleus.route.sidebar.show-threads",
            Self::ShowFiles => "nucleus.route.sidebar.show-files",
            Self::ShowForge => "nucleus.route.sidebar.show-forge",
            Self::RenameSelectedProject => "nucleus.route.project.rename-selected",
            Self::ManageProjectResources => "nucleus.route.project.manage-resources",
            Self::ParkSelectedProject => "nucleus.route.project.park-selected",
            Self::ArchiveSelectedProject => "nucleus.route.project.archive-selected",
            Self::RenameActiveThread => "nucleus.route.thread.rename-active",
            Self::ConvertThreadToProject => "nucleus.route.thread.convert-to-project",
            Self::OpenAgentChatPanel => "nucleus.route.panel.open-agent-chat",
            Self::OpenBrowserPanel => "nucleus.route.panel.open-browser",
            Self::OpenEditorPanel => "nucleus.route.panel.open-editor",
            Self::OpenTerminalPanel => "nucleus.route.panel.open-terminal",
            Self::OpenTasksPanel => "nucleus.route.panel.open-tasks",
            Self::OpenDiffPanel => "nucleus.route.panel.open-diff",
            Self::OpenMemoryPanel => "nucleus.route.panel.open-memory",
            Self::CloseActivePanel => "nucleus.route.panel.close-active",
            Self::QuickOpenFile => "nucleus.route.editor.quick-open",
            Self::SaveEditorFile => "nucleus.route.editor.save",
            Self::RefreshForge => "nucleus.route.forge.refresh",
            Self::CancelAgentTurn => "nucleus.route.agent.cancel-turn",
        }
    }

    pub(crate) fn from_route(value: &str) -> Option<Self> {
        COMMAND_SPEC_GROUPS
            .iter()
            .flat_map(|group| group.iter())
            .find(|spec| spec.route.as_str() == value)
            .map(|spec| spec.route)
    }
}
