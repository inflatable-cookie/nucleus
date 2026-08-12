//! Workspace layout snapshot projection.
//!
//! Split from the runtime god file; behavior unchanged.

use std::sync::atomic::Ordering;

use super::super::dto::WorkspaceLayoutSnapshotDto;
use super::super::registry::project_surface_id;
use super::WorkspaceUiRuntime;

impl WorkspaceUiRuntime {
    pub(super) fn snapshot_locked(
        &self,
        project_id: &str,
    ) -> Result<WorkspaceLayoutSnapshotDto, String> {
        let document = self.load_layout()?;
        let project_container_id = project_surface_id(project_id)?;
        let surface = document
            .surface(&project_container_id)
            .ok_or_else(|| format!("Nucleus layout is missing for project {project_id}"))?;
        let presentations = self.load_presentations()?;
        let project_presentations = presentations
            .projects
            .get(project_id)
            .ok_or_else(|| format!("Nucleus panel presentations are missing for {project_id}"))?;
        let context = presentations
            .contexts
            .get(project_id)
            .cloned()
            .unwrap_or_default();
        let mut panels = Vec::new();
        for region in surface.regions() {
            for panel_instance_id in region.panel_instance_ids() {
                let instance = document.panel_instance(panel_instance_id).ok_or_else(|| {
                    format!("Nucleus layout references missing panel {panel_instance_id}")
                })?;
                let presentation = project_presentations
                    .get(panel_instance_id.as_str())
                    .ok_or_else(|| {
                        format!("Nucleus panel presentation is missing for {panel_instance_id}")
                    })?;
                panels.push(
                    presentation.project(panel_instance_id.as_str(), instance.definition_id())?,
                );
            }
        }
        let registry = self.layout_domain.registry();
        Ok(WorkspaceLayoutSnapshotDto {
            projection_revision: self.projection_sequence.fetch_add(1, Ordering::Relaxed) + 1,
            project_id: project_id.to_owned(),
            surface_id: project_container_id.as_str().to_owned(),
            document,
            schemas: registry.schemas().cloned().collect(),
            panel_definitions: registry.panel_definitions().cloned().collect(),
            panels,
            context,
        })
    }
}
