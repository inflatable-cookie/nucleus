use std::collections::{BTreeMap, BTreeSet};

use longhorn_config::{DomainDescriptor, DomainFilePath, DomainIssue, StorageClass};
use longhorn_core::{DomainId, PanelInstanceId, SchemaVersion};
use longhorn_layout::{
    LayoutContainer, LayoutDefinitionRegistry, LayoutDocument, LayoutMutationCommand,
    PanelInstance, RegionState,
};
use longhorn_layout_config::{LayoutBackupPolicy, NoLayoutMigration, RegisteredLayoutDomain};

use super::{LayoutDomain, LAYOUT_DOMAIN_FILE, LAYOUT_DOMAIN_ID, LAYOUT_DOMAIN_SCHEMA};
use crate::workspace_ui::registry::{
    agent_chat_instance, container_id, empty_container, empty_document,
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

pub(super) fn seeded_container(project_id: &str) -> Result<LayoutContainer, String> {
    let base = empty_container(project_id)?;
    let instance = agent_chat_instance(project_id)?;
    Ok(LayoutContainer::new(
        base.id().clone(),
        base.schema_id().clone(),
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
    ))
}

pub(super) fn append_project(
    document: &LayoutDocument,
    container: LayoutContainer,
    instances: impl IntoIterator<Item = PanelInstance>,
) -> Result<LayoutDocument, DomainIssue> {
    let revision = document
        .revision()
        .checked_next()
        .map_err(|error| layout_issue(error.to_string()))?;
    let mut containers = document.containers().to_vec();
    containers.push(container);
    let mut panel_instances = document.panel_instances().to_vec();
    panel_instances.extend(instances);
    Ok(LayoutDocument::new(revision, containers, panel_instances))
}

pub(super) fn claim_pending_document(
    document: &LayoutDocument,
    pending_id: &longhorn_core::LayoutContainerId,
    target: LayoutContainer,
    remap: &BTreeMap<PanelInstanceId, PanelInstanceId>,
) -> Result<LayoutDocument, DomainIssue> {
    let revision = document
        .revision()
        .checked_next()
        .map_err(|error| layout_issue(error.to_string()))?;
    let containers = document
        .containers()
        .iter()
        .filter(|container| container.id() != pending_id)
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
    Ok(LayoutDocument::new(revision, containers, panel_instances))
}

pub(super) fn remap_container(
    source: &LayoutContainer,
    target_id: longhorn_core::LayoutContainerId,
    remap: &BTreeMap<PanelInstanceId, PanelInstanceId>,
) -> Result<LayoutContainer, String> {
    Ok(LayoutContainer::new(
        target_id,
        source.schema_id().clone(),
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
    ))
}

pub(super) fn container_panel_ids(container: &LayoutContainer) -> BTreeSet<PanelInstanceId> {
    container
        .regions()
        .iter()
        .flat_map(|region| region.panel_instance_ids().iter().cloned())
        .collect()
}

pub(super) fn validate_project_command(
    project_id: &str,
    document: &LayoutDocument,
    command: &LayoutMutationCommand,
) -> Result<(), String> {
    let expected_container_id = container_id(project_id)?;
    let container = document
        .container(&expected_container_id)
        .ok_or_else(|| format!("Nucleus layout is missing for project {project_id}"))?;
    let contains_panel = |panel_instance_id: &PanelInstanceId| {
        container
            .regions()
            .iter()
            .any(|region| region.panel_instance_ids().contains(panel_instance_id))
    };
    let valid = match command {
        LayoutMutationCommand::CreatePanel { container_id, .. }
        | LayoutMutationCommand::ReorderRegion { container_id, .. }
        | LayoutMutationCommand::SetSizingSlot { container_id, .. }
        | LayoutMutationCommand::SetRegionCollapsed { container_id, .. } => {
            container_id == &expected_container_id
        }
        LayoutMutationCommand::ClosePanel { panel_instance_id }
        | LayoutMutationCommand::ActivatePanel { panel_instance_id } => {
            contains_panel(panel_instance_id)
        }
        LayoutMutationCommand::MovePanel {
            panel_instance_id,
            target_container_id,
            ..
        } => contains_panel(panel_instance_id) && target_container_id == &expected_container_id,
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
