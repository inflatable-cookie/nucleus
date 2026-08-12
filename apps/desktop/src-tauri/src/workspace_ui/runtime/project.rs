//! Workspace project seeding and pending-project claiming.
//!
//! Split from the runtime god file; behavior unchanged.

use std::collections::BTreeMap;

use longhorn_core::PanelInstanceId;
use longhorn_surfaces::SurfaceDocument;

use super::super::product_state::PanelPresentation;
use super::super::registry::{
    agent_chat_instance, panel_instance_id, project_surface_id, PENDING_PROJECT_SCOPE,
};
use super::project_documents::{
    append_project, claim_pending_document, layout_issue, remap_container, seeded_container,
};
use super::WorkspaceUiRuntime;

impl WorkspaceUiRuntime {
    pub(super) fn ensure_project(&self, project_id: &str) -> Result<(), String> {
        let document = self.load_layout()?;
        let project_container = project_surface_id(project_id)?;
        if document.surface(&project_container).is_some() {
            let presentations = self.load_presentations()?;
            if presentations.projects.contains_key(project_id) {
                return Ok(());
            }
            return Err(format!(
                "Nucleus panel presentations are missing for project {project_id}"
            ));
        }

        let pending_container = project_surface_id(PENDING_PROJECT_SCOPE)?;
        if document.surface(&pending_container).is_some() {
            return self.claim_pending_project(project_id, &document);
        }

        let mut presentations = self.load_presentations()?;
        presentations
            .projects
            .entry(project_id.to_owned())
            .or_insert(BTreeMap::from([PanelPresentation::agent_chat(project_id)?]));
        self.publish_presentations(presentations)?;

        let surface = seeded_container(project_id)?;
        let instance = agent_chat_instance(project_id)?;
        self.store
            .mutate(&self.layout_domain, self.options, |current| {
                if current.surface(&project_container).is_some() {
                    return Ok(());
                }
                if current.surface(&pending_container).is_some() {
                    return Err(layout_issue(
                        "pending legacy layout appeared while seeding a project",
                    ));
                }
                *current = append_project(current, surface.clone(), [instance.clone()])?;
                Ok(())
            })
            .map_err(|error| format!("seed Nucleus project layout failed: {error}"))?;
        Ok(())
    }

    pub(super) fn claim_pending_project(
        &self,
        project_id: &str,
        document: &SurfaceDocument,
    ) -> Result<(), String> {
        let pending_id = project_surface_id(PENDING_PROJECT_SCOPE)?;
        let target_id = project_surface_id(project_id)?;
        let pending = document
            .surface(&pending_id)
            .ok_or_else(|| "pending Nucleus layout surface disappeared".to_owned())?;
        let mut presentations = self.load_presentations()?;
        let source_records = presentations
            .projects
            .get(PENDING_PROJECT_SCOPE)
            .or_else(|| presentations.projects.get(project_id))
            .cloned()
            .ok_or_else(|| "pending Nucleus panel presentations are missing".to_owned())?;
        let remap = source_records
            .iter()
            .map(|(old, record)| {
                Ok((
                    PanelInstanceId::new(old).map_err(|error| error.to_string())?,
                    panel_instance_id(project_id, &record.external_id)?,
                ))
            })
            .collect::<Result<BTreeMap<_, _>, String>>()?;
        let target_records = source_records
            .into_values()
            .map(|record| {
                let id = panel_instance_id(project_id, &record.external_id)?;
                Ok((id.as_str().to_owned(), record))
            })
            .collect::<Result<BTreeMap<_, _>, String>>()?;
        presentations.projects.remove(PENDING_PROJECT_SCOPE);
        presentations
            .projects
            .insert(project_id.to_owned(), target_records);
        self.publish_presentations(presentations)?;

        let target_container = remap_container(pending, target_id, &remap)?;
        self.store
            .mutate(&self.layout_domain, self.options, |current| {
                if current.surface(&target_container.id().clone()).is_some() {
                    return Ok(());
                }
                *current =
                    claim_pending_document(current, &pending_id, target_container.clone(), &remap)?;
                Ok(())
            })
            .map_err(|error| format!("claim pending Nucleus project layout failed: {error}"))?;
        Ok(())
    }
}
