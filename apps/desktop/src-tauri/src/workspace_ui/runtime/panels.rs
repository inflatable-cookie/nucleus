//! Workspace panel mutation validation: create-panel presentation matching.
//!
//! Split from the runtime god file; behavior unchanged.

use longhorn_surfaces::LayoutMutationCommand;

use super::super::dto::WorkspacePanelPresentationInputDto;
use super::super::product_state::PanelPresentation;
use super::super::registry::definition_for_kind;
use super::WorkspaceUiRuntime;

impl WorkspaceUiRuntime {
    pub(super) fn validate_create_presentation(
        &self,
        project_id: &str,
        command: &LayoutMutationCommand,
        input: Option<&WorkspacePanelPresentationInputDto>,
    ) -> Result<Option<(String, PanelPresentation)>, String> {
        match command {
            LayoutMutationCommand::CreatePanel {
                panel_instance_id,
                panel_definition_id,
                ..
            } => {
                let input = input.ok_or_else(|| {
                    "Nucleus create-panel command requires product presentation".to_owned()
                })?;
                if definition_for_kind(&input.kind)? != *panel_definition_id {
                    return Err(format!(
                        "Nucleus panel kind {} does not match definition {panel_definition_id}",
                        input.kind
                    ));
                }
                let (derived_id, presentation) = PanelPresentation::from_input(project_id, input)?;
                if derived_id != panel_instance_id.as_str() {
                    return Err(
                        "Nucleus create-panel identity does not match product presentation"
                            .to_owned(),
                    );
                }
                Ok(Some((derived_id, presentation)))
            }
            _ if input.is_some() => Err(
                "Nucleus product presentation is only valid for create-panel commands".to_owned(),
            ),
            _ => Ok(None),
        }
    }
}
