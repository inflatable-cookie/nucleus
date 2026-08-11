use std::collections::{BTreeMap, BTreeSet};

use longhorn_config::{DomainDescriptor, DomainFilePath, DomainIssue, StorageClass};
use longhorn_core::{DomainId, PanelInstanceId, SchemaVersion};
use longhorn_surfaces::{
    LayoutDefinitionRegistry, LayoutMutationCommand, PanelInstance, RegionState, SurfaceDocument,
    SurfaceRecord,
};
use longhorn_surfaces_config::{LayoutBackupPolicy, NoLayoutMigration, RegisteredLayoutDomain};

use super::{LayoutDomain, LAYOUT_DOMAIN_FILE, LAYOUT_DOMAIN_ID, LAYOUT_DOMAIN_SCHEMA};
use crate::workspace_ui::registry::{
    agent_chat_instance, empty_container, empty_document, project_surface_id,
};

pub(super) fn registered_layout_domain(
    registry: LayoutDefinitionRegistry,
) -> Result<LayoutDomain, String> {
    let descriptor = DomainDescriptor::new(
        DomainId::new(LAYOUT_DOMAIN_ID).map_err(|error| error.to_string())?,
        SchemaVersion::new(LAYOUT_DOMAIN_SCHEMA).map_err(|error| error.to_string())?,
        StorageClass::UserConfig,
        Some(DomainFilePath::new(LAYOUT_DOMAIN_FILE).map_err(|error| error.to_string())?),
    )
    .map_err(|error| error.to_string())?;
    RegisteredLayoutDomain::new(
        descriptor,
        empty_document(),
        registry,
        NoLayoutMigration,
        LayoutBackupPolicy::Include,
    )
    .map_err(|error| error.to_string())
}

pub(super) fn seeded_container(project_id: &str) -> Result<SurfaceRecord, String> {
    let base = empty_container(project_id)?;
    let instance = agent_chat_instance(project_id)?;
    Ok(SurfaceRecord::new(
        base.id().clone(),
        base.schema_id().clone(),
        base.label().map(str::to_owned),
        base.regions().iter().map(|region| {
            if region.region_id().as_str() == "center_top" {
                RegionState::new(
                    region.region_id().clone(),
                    [instance.id().clone()],
                    Some(instance.id().clone()),
                    region.collapsed(),
                )
            } else {
                region.clone()
            }
        }),
        base.sizing_slots().iter().cloned(),
        base.host_preferences().iter().cloned(),
    ))
}

pub(super) fn append_project(
    document: &SurfaceDocument,
    surface: SurfaceRecord,
    instances: impl IntoIterator<Item = PanelInstance>,
) -> Result<SurfaceDocument, DomainIssue> {
    let revision = document
        .revision()
        .checked_next()
        .map_err(|error| layout_issue(error.to_string()))?;
    let mut surfaces = document.surfaces().to_vec();
    surfaces.push(surface);
    let mut panel_instances = document.panel_instances().to_vec();
    panel_instances.extend(instances);
    Ok(SurfaceDocument::new(
        revision,
        surfaces,
        panel_instances,
        [],
    ))
}

pub(super) fn claim_pending_document(
    document: &SurfaceDocument,
    pending_id: &longhorn_core::SurfaceId,
    target: SurfaceRecord,
    remap: &BTreeMap<PanelInstanceId, PanelInstanceId>,
) -> Result<SurfaceDocument, DomainIssue> {
    let revision = document
        .revision()
        .checked_next()
        .map_err(|error| layout_issue(error.to_string()))?;
    let surfaces = document
        .surfaces()
        .iter()
        .filter(|surface| surface.id() != pending_id)
        .cloned()
        .chain([target])
        .collect::<Vec<_>>();
    let panel_instances = document
        .panel_instances()
        .iter()
        .map(|instance| {
            remap.get(instance.id()).map_or_else(
                || instance.clone(),
                |id| PanelInstance::new(id.clone(), instance.definition_id().clone()),
            )
        })
        .collect::<Vec<_>>();
    Ok(SurfaceDocument::new(
        revision,
        surfaces,
        panel_instances,
        [],
    ))
}

pub(super) fn remap_container(
    source: &SurfaceRecord,
    target_id: longhorn_core::SurfaceId,
    remap: &BTreeMap<PanelInstanceId, PanelInstanceId>,
) -> Result<SurfaceRecord, String> {
    Ok(SurfaceRecord::new(
        target_id,
        source.schema_id().clone(),
        source.label().map(str::to_owned),
        source.regions().iter().map(|region| {
            RegionState::new(
                region.region_id().clone(),
                region
                    .panel_instance_ids()
                    .iter()
                    .map(|id| remap.get(id).cloned().unwrap_or_else(|| id.clone())),
                region
                    .active_panel_instance_id()
                    .map(|id| remap.get(id).cloned().unwrap_or_else(|| id.clone())),
                region.collapsed(),
            )
        }),
        source.sizing_slots().iter().cloned(),
        source.host_preferences().iter().cloned(),
    ))
}

pub(super) fn surface_panel_ids(surface: &SurfaceRecord) -> BTreeSet<PanelInstanceId> {
    surface
        .regions()
        .iter()
        .flat_map(|region| region.panel_instance_ids().iter().cloned())
        .collect()
}

pub(super) fn validate_project_command(
    project_id: &str,
    document: &SurfaceDocument,
    command: &LayoutMutationCommand,
) -> Result<(), String> {
    let expected_container_id = project_surface_id(project_id)?;
    let surface = document
        .surface(&expected_container_id)
        .ok_or_else(|| format!("Nucleus layout is missing for project {project_id}"))?;
    let contains_panel = |panel_instance_id: &PanelInstanceId| {
        surface
            .regions()
            .iter()
            .any(|region| region.panel_instance_ids().contains(panel_instance_id))
    };
    let valid = match command {
        LayoutMutationCommand::CreatePanel { surface_id, .. }
        | LayoutMutationCommand::ReorderRegion { surface_id, .. }
        | LayoutMutationCommand::SetSizingSlot { surface_id, .. }
        | LayoutMutationCommand::SetRegionCollapsed { surface_id, .. } => {
            surface_id == &expected_container_id
        }
        LayoutMutationCommand::ClosePanel { panel_instance_id }
        | LayoutMutationCommand::ActivatePanel { panel_instance_id } => {
            contains_panel(panel_instance_id)
        }
        LayoutMutationCommand::MovePanel {
            panel_instance_id,
            target_surface_id,
            ..
        } => contains_panel(panel_instance_id) && target_surface_id == &expected_container_id,
    };
    if valid {
        Ok(())
    } else {
        Err(format!(
            "Nucleus layout command is outside project scope {project_id}"
        ))
    }
}

pub(super) fn layout_issue(detail: impl Into<String>) -> DomainIssue {
    DomainIssue::new("nucleus-layout-mutation", detail)
}
