//! Local client profile layout persistence boundary types.

use nucleus_projects::ProjectId;

use crate::displays::DisplayInventory;
use crate::ids::ClientProfileId;
use crate::project_panels::ProjectPanelLayoutRules;
use crate::windows::WorkspaceWindowConfig;

/// Local layout record family.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LocalLayoutRecordKind {
    GlobalShellLayout,
    ProjectPanelLayout,
}

/// Persistence scope for layout records.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalLayoutPersistenceScope {
    LocalClientProfile { client_profile_id: ClientProfileId },
}

/// Global display/window shell state for one local client profile.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GlobalShellLayoutRecord {
    pub client_profile_id: ClientProfileId,
    pub display_inventory: DisplayInventory,
    pub windows: Vec<WorkspaceWindowConfig>,
}

/// Per-project panel layout state for one local client profile.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectPanelLayoutRecord {
    pub client_profile_id: ClientProfileId,
    pub project_id: ProjectId,
    pub rules: ProjectPanelLayoutRules,
}

/// Local-only layout record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalLayoutRecord {
    GlobalShell(GlobalShellLayoutRecord),
    ProjectPanel(ProjectPanelLayoutRecord),
}

impl LocalLayoutRecord {
    pub fn kind(&self) -> LocalLayoutRecordKind {
        match self {
            Self::GlobalShell(_) => LocalLayoutRecordKind::GlobalShellLayout,
            Self::ProjectPanel(_) => LocalLayoutRecordKind::ProjectPanelLayout,
        }
    }

    pub fn persistence_scope(&self) -> LocalLayoutPersistenceScope {
        match self {
            Self::GlobalShell(record) => LocalLayoutPersistenceScope::LocalClientProfile {
                client_profile_id: record.client_profile_id.clone(),
            },
            Self::ProjectPanel(record) => LocalLayoutPersistenceScope::LocalClientProfile {
                client_profile_id: record.client_profile_id.clone(),
            },
        }
    }

    pub fn is_repo_projection_allowed(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{
        GlobalShellLayoutRecord, LocalLayoutPersistenceScope, LocalLayoutRecord,
        LocalLayoutRecordKind, ProjectPanelLayoutRecord,
    };
    use crate::displays::DisplayInventory;
    use crate::ids::{
        ClientProfileId, DisplayArrangementSignature, ProjectPanelLayoutId, WindowId,
    };
    use crate::project_panels::ProjectPanelLayoutRules;
    use nucleus_projects::ProjectId;

    fn client_profile_id() -> ClientProfileId {
        ClientProfileId("client:local".to_string())
    }

    #[test]
    fn global_shell_layout_is_local_client_profile_scoped() {
        let record = LocalLayoutRecord::GlobalShell(GlobalShellLayoutRecord {
            client_profile_id: client_profile_id(),
            display_inventory: DisplayInventory {
                signature: DisplayArrangementSignature("display:signature".to_string()),
                displays: Vec::new(),
            },
            windows: Vec::new(),
        });

        assert_eq!(record.kind(), LocalLayoutRecordKind::GlobalShellLayout);
        assert_eq!(
            record.persistence_scope(),
            LocalLayoutPersistenceScope::LocalClientProfile {
                client_profile_id: client_profile_id()
            }
        );
        assert!(!record.is_repo_projection_allowed());
    }

    #[test]
    fn project_panel_layout_is_local_and_project_linked() {
        let project_id = ProjectId("project:nucleus".to_string());
        let record = LocalLayoutRecord::ProjectPanel(ProjectPanelLayoutRecord {
            client_profile_id: client_profile_id(),
            project_id: project_id.clone(),
            rules: ProjectPanelLayoutRules::chat_led_shell(
                ProjectPanelLayoutId("layout:chat-led".to_string()),
                project_id,
                WindowId("window:primary".to_string()),
            ),
        });

        assert_eq!(record.kind(), LocalLayoutRecordKind::ProjectPanelLayout);
        assert_eq!(
            record.persistence_scope(),
            LocalLayoutPersistenceScope::LocalClientProfile {
                client_profile_id: client_profile_id()
            }
        );
        assert!(!record.is_repo_projection_allowed());
    }
}
