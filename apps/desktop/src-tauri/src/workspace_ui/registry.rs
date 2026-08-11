use longhorn_config::Sha256Digest;
use longhorn_core::{
    LayoutSchemaId, PanelDefinitionId, PanelInstanceId, RegionFamilyId, RegionId, SizingSlotId,
    SurfaceId, SurfaceRevision,
};
use longhorn_surfaces::{
    EmptyRegionPolicy, LayoutDefinitionRegistry, LayoutLimits, LayoutRatio, LayoutSchemaDefinition,
    PanelDefinition, PanelInstance, PanelInstancePolicy, PlacementSelector, RegionDefinition,
    RegionState, SizingSlotDefinition, SizingSlotState, SurfaceDocument, SurfaceRecord,
};

pub const SCHEMA_ID: &str = "schema:nucleus";
pub const PENDING_PROJECT_SCOPE: &str = "migration:pending-project";
pub const REGION_IDS: [&str; 5] = [
    "left",
    "center_top",
    "center_bottom",
    "right_top",
    "right_bottom",
];
pub const SIZING_SLOT_IDS: [&str; 4] =
    ["left-center", "center-right", "center-stack", "right-stack"];

const PANEL_KINDS: [(&str, &str); 11] = [
    ("activity", "panel:activity"),
    ("projectActivity", "panel:project-activity"),
    ("agentChat", "panel:agent-chat"),
    ("tasks", "panel:tasks"),
    ("terminal", "panel:terminal"),
    ("browser", "panel:browser"),
    ("editor", "panel:editor"),
    ("diff", "panel:diff"),
    ("forgeDiff", "panel:forge-diff"),
    ("memory", "panel:memory"),
    ("workspace", "panel:workspace"),
];

pub fn definition_registry() -> Result<LayoutDefinitionRegistry, String> {
    let activity_family = family_id("activity")?;
    let workspace_family = family_id("workspace")?;
    let schema = LayoutSchemaDefinition::new(
        schema_id()?,
        [
            region("left", &activity_family, 0, false)?,
            region("center_top", &workspace_family, 1, false)?,
            region("center_bottom", &workspace_family, 2, true)?,
            region("right_top", &workspace_family, 3, true)?,
            region("right_bottom", &workspace_family, 4, true)?,
        ],
        [
            sizing("left-center", 0, 200_000)?,
            sizing("center-right", 1, 740_000)?,
            sizing("center-stack", 2, 740_000)?,
            sizing("right-stack", 3, 740_000)?,
        ],
    );
    let workspace_allowed = [PlacementSelector::Family(workspace_family)];
    let activity_allowed = [PlacementSelector::Family(activity_family)];
    let panels = PANEL_KINDS
        .into_iter()
        .map(|(kind, id)| {
            let is_activity = matches!(kind, "activity" | "projectActivity");
            let default_region = if is_activity {
                "left"
            } else if kind == "memory" {
                "right_top"
            } else {
                "center_top"
            };
            Ok(PanelDefinition::new(
                panel_definition_id(id)?,
                [PlacementSelector::Region(region_id(default_region)?)],
                if is_activity {
                    activity_allowed.to_vec()
                } else {
                    workspace_allowed.to_vec()
                },
                if kind == "tasks" {
                    PanelInstancePolicy::OnePerContainer
                } else {
                    PanelInstancePolicy::Multiple
                },
                true,
                true,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    LayoutDefinitionRegistry::new(
        LayoutLimits::new(1, 5, 4, 16, 4_096, 65_536, 1_024).map_err(|error| error.to_string())?,
        [schema],
        panels,
    )
    .map_err(|error| error.to_string())
}

pub fn empty_document() -> SurfaceDocument {
    SurfaceDocument::new(SurfaceRevision::INITIAL, [], [], [])
}

pub fn empty_container(project_id: &str) -> Result<SurfaceRecord, String> {
    Ok(SurfaceRecord::new(
        project_surface_id(project_id)?,
        schema_id()?,
        None,
        [
            RegionState::new(region_id("left")?, [], None, None),
            RegionState::new(region_id("center_top")?, [], None, None),
            RegionState::new(region_id("center_bottom")?, [], None, Some(false)),
            RegionState::new(region_id("right_top")?, [], None, Some(false)),
            RegionState::new(region_id("right_bottom")?, [], None, Some(false)),
        ],
        [
            SizingSlotState::new(sizing_slot_id("left-center")?, ratio(200_000)?),
            SizingSlotState::new(sizing_slot_id("center-right")?, ratio(740_000)?),
            SizingSlotState::new(sizing_slot_id("center-stack")?, ratio(740_000)?),
            SizingSlotState::new(sizing_slot_id("right-stack")?, ratio(740_000)?),
        ],
        [longhorn_surfaces::SurfaceHostPreference::new(
            workspace_window_id()?,
            0,
        )],
    ))
}

pub fn agent_chat_instance(project_id: &str) -> Result<PanelInstance, String> {
    Ok(PanelInstance::new(
        panel_instance_id(project_id, "panel:agent-chat")?,
        definition_for_kind("agentChat")?,
    ))
}

/// Nucleus draws one project workspace in one window, so every Surface names it.
pub fn workspace_window_id() -> Result<longhorn_core::WindowId, String> {
    longhorn_core::WindowId::new("workspace").map_err(|error| error.to_string())
}

pub fn project_surface_id(project_id: &str) -> Result<SurfaceId, String> {
    validate_project_id(project_id)?;
    SurfaceId::new(format!(
        "container:{}",
        Sha256Digest::from_bytes(project_id.as_bytes()).as_str()
    ))
    .map_err(|error| error.to_string())
}

pub fn panel_instance_id(
    project_id: &str,
    external_panel_id: &str,
) -> Result<PanelInstanceId, String> {
    validate_project_id(project_id)?;
    if external_panel_id.trim().is_empty() || external_panel_id.len() > 512 {
        return Err("panel id must contain 1..=512 bytes".to_owned());
    }
    let mut identity = Vec::with_capacity(project_id.len() + external_panel_id.len() + 1);
    identity.extend_from_slice(project_id.as_bytes());
    identity.push(0);
    identity.extend_from_slice(external_panel_id.as_bytes());
    PanelInstanceId::new(format!(
        "instance:{}",
        Sha256Digest::from_bytes(&identity).as_str()
    ))
    .map_err(|error| error.to_string())
}

pub fn definition_for_kind(kind: &str) -> Result<PanelDefinitionId, String> {
    let normalized = if kind == "context" { "memory" } else { kind };
    let (_, id) = PANEL_KINDS
        .iter()
        .find(|(candidate, _)| *candidate == normalized)
        .ok_or_else(|| format!("unknown Nucleus panel kind {kind}"))?;
    panel_definition_id(id)
}

pub fn kind_for_definition(id: &PanelDefinitionId) -> Result<&'static str, String> {
    PANEL_KINDS
        .iter()
        .find(|(_, candidate)| *candidate == id.as_str())
        .map(|(kind, _)| *kind)
        .ok_or_else(|| format!("unknown Nucleus panel definition {id}"))
}

pub fn default_title(kind: &str) -> &'static str {
    match kind {
        "activity" => "Activity",
        "projectActivity" => "Projects",
        "agentChat" => "Agent Chat",
        "tasks" => "Tasks",
        "terminal" => "Terminal",
        "browser" => "Browser",
        "editor" => "Editor",
        "diff" => "Diff",
        "forgeDiff" => "Changes",
        "memory" => "Memory",
        _ => "Panel",
    }
}

pub fn region_id(value: &str) -> Result<RegionId, String> {
    RegionId::new(value).map_err(|error| error.to_string())
}

pub fn sizing_slot_id(value: &str) -> Result<SizingSlotId, String> {
    SizingSlotId::new(value).map_err(|error| error.to_string())
}

pub fn ratio(value: u32) -> Result<LayoutRatio, String> {
    LayoutRatio::from_millionths(value).map_err(|error| error.to_string())
}

pub fn validate_project_id(project_id: &str) -> Result<(), String> {
    if project_id.trim().is_empty() || project_id.len() > 512 {
        Err("project id must contain 1..=512 bytes".to_owned())
    } else {
        Ok(())
    }
}

fn schema_id() -> Result<LayoutSchemaId, String> {
    LayoutSchemaId::new(SCHEMA_ID).map_err(|error| error.to_string())
}

fn family_id(value: &str) -> Result<RegionFamilyId, String> {
    RegionFamilyId::new(value).map_err(|error| error.to_string())
}

fn panel_definition_id(value: &str) -> Result<PanelDefinitionId, String> {
    PanelDefinitionId::new(value).map_err(|error| error.to_string())
}

fn region(
    id: &str,
    family: &RegionFamilyId,
    order: u32,
    collapsible: bool,
) -> Result<RegionDefinition, String> {
    Ok(RegionDefinition::new(
        region_id(id)?,
        family.clone(),
        order,
        EmptyRegionPolicy::HideWhenEmpty,
        collapsible,
    ))
}

fn sizing(id: &str, order: u32, default: u32) -> Result<SizingSlotDefinition, String> {
    Ok(SizingSlotDefinition::new(
        sizing_slot_id(id)?,
        order,
        ratio(200_000)?,
        ratio(default)?,
        ratio(900_000)?,
    ))
}
