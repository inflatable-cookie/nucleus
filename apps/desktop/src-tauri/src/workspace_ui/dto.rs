use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use longhorn_surfaces::{
    LayoutMutationReceipt, LayoutMutationRejection, LayoutMutationRequest, LayoutSchemaDefinition,
    PanelDefinition, SurfaceDocument,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspacePanelPresentationInputDto {
    pub external_id: String,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub resource_targets: BTreeMap<String, String>,
    #[serde(default)]
    pub editor_file: Option<WorkspaceEditorFileDto>,
    #[serde(default)]
    pub forge_diff: Option<WorkspaceForgeDiffDto>,
    #[serde(default)]
    pub run_review: Option<WorkspaceRunReviewDto>,
    #[serde(default)]
    pub conversation_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspacePanelPresentationDto {
    pub panel_instance_id: String,
    pub external_id: String,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub resource_targets: BTreeMap<String, String>,
    #[serde(default)]
    pub editor_file: Option<WorkspaceEditorFileDto>,
    #[serde(default)]
    pub forge_diff: Option<WorkspaceForgeDiffDto>,
    #[serde(default)]
    pub run_review: Option<WorkspaceRunReviewDto>,
    #[serde(default)]
    pub conversation_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceProjectContextDto {
    #[serde(default)]
    pub selected_goal_id: Option<String>,
    #[serde(default)]
    pub selected_task_id: Option<String>,
    #[serde(default)]
    pub active_conversation_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WorkspaceLayoutSnapshotDto {
    pub projection_revision: u64,
    pub project_id: String,
    pub surface_id: String,
    pub document: SurfaceDocument,
    pub schemas: Vec<LayoutSchemaDefinition>,
    pub panel_definitions: Vec<PanelDefinition>,
    pub panels: Vec<WorkspacePanelPresentationDto>,
    pub context: WorkspaceProjectContextDto,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceLayoutMutationDto {
    pub request: LayoutMutationRequest,
    #[serde(default)]
    pub create_panel: Option<WorkspacePanelPresentationInputDto>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum WorkspaceLayoutDispatchResultDto {
    Committed { receipt: LayoutMutationReceipt },
    Rejected { rejection: LayoutMutationRejection },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WorkspaceLayoutMutationResponseDto {
    pub result: WorkspaceLayoutDispatchResultDto,
    pub snapshot: WorkspaceLayoutSnapshotDto,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WorkspacePreparedPanelDto {
    pub panel_instance_id: String,
    pub panel_definition_id: String,
    pub region_id: String,
    pub presentation: WorkspacePanelPresentationInputDto,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceUiPaths {
    window_placement: PathBuf,
    project_layouts: PathBuf,
    panel_presentations: PathBuf,
    legacy_layout_backup: PathBuf,
    layout_migration_receipt: PathBuf,
}

impl WorkspaceUiPaths {
    pub fn new(
        window_placement: PathBuf,
        project_layouts: PathBuf,
        panel_presentations: PathBuf,
        legacy_layout_backup: PathBuf,
        layout_migration_receipt: PathBuf,
    ) -> Self {
        Self {
            window_placement,
            project_layouts,
            panel_presentations,
            legacy_layout_backup,
            layout_migration_receipt,
        }
    }

    pub fn window_placement(&self) -> &Path {
        &self.window_placement
    }

    pub fn project_layouts(&self) -> &Path {
        &self.project_layouts
    }

    pub fn panel_presentations(&self) -> &Path {
        &self.panel_presentations
    }

    pub fn legacy_layout_backup(&self) -> &Path {
        &self.legacy_layout_backup
    }

    pub fn layout_migration_receipt(&self) -> &Path {
        &self.layout_migration_receipt
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkspaceWindowPlacementDto {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normal_bounds: Option<WorkspaceWindowBoundsDto>,
    #[serde(default)]
    pub maximized: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkspaceWindowBoundsDto {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WorkspaceLayoutDto {
    pub left_center_ratio: f64,
    pub center_right_ratio: f64,
    pub center_stack_ratio: f64,
    pub right_stack_ratio: f64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkspaceRegionsDto {
    #[serde(default)]
    pub left: Vec<WorkspacePanelDto>,
    #[serde(default)]
    pub right_top: Vec<WorkspacePanelDto>,
    #[serde(default)]
    pub right_bottom: Vec<WorkspacePanelDto>,
    #[serde(default)]
    pub center_top: Vec<WorkspacePanelDto>,
    #[serde(default)]
    pub center_bottom: Vec<WorkspacePanelDto>,
}

impl WorkspaceRegionsDto {
    pub fn get(&self, region: &str) -> Option<&[WorkspacePanelDto]> {
        match region {
            "left" => Some(&self.left),
            "center_top" => Some(&self.center_top),
            "center_bottom" => Some(&self.center_bottom),
            "right_top" => Some(&self.right_top),
            "right_bottom" => Some(&self.right_bottom),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkspacePanelDto {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub closeable: bool,
    pub movable: bool,
    #[serde(default)]
    pub resource_targets: BTreeMap<String, String>,
    #[serde(default)]
    pub editor_file: Option<WorkspaceEditorFileDto>,
    #[serde(default)]
    pub forge_diff: Option<WorkspaceForgeDiffDto>,
    #[serde(default)]
    pub run_review: Option<WorkspaceRunReviewDto>,
    #[serde(default)]
    pub allowed_regions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkspaceRunReviewDto {
    pub run_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkspaceEditorFileDto {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    pub file_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkspaceForgeDiffDto {
    pub resource_id: String,
    pub path: String,
    #[serde(default = "default_forge_diff_scope")]
    pub scope: String,
}

pub fn default_forge_diff_scope() -> String {
    "all".to_owned()
}
