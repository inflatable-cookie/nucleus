//! Workspace UI runtime: layout and panel presentation state for each
//! project, with serialized command dispatch.
//!
//! Module index over the runtime surface: the public API, snapshot
//! projection, layout and presentation persistence, project seeding, and
//! panel mutation validation.

use std::sync::{
    atomic::AtomicU64,
    Mutex,
};
use std::time::Duration;

use longhorn_config::{
    ConfigStore, CoordinationAuthority, DurabilityRequirement, MutationOptions, StorageRoots,
};
use longhorn_core::PanelInstanceId;
use longhorn_surfaces::{LayoutMutationCommand, LayoutMutationEngine};
use longhorn_surfaces_config::{NoLayoutMigration, RegisteredLayoutDomain};

use super::dto::{
    WorkspaceLayoutDispatchResultDto, WorkspaceLayoutMutationDto,
    WorkspaceLayoutMutationResponseDto, WorkspaceLayoutSnapshotDto,
    WorkspacePanelPresentationInputDto, WorkspacePreparedPanelDto, WorkspaceProjectContextDto,
    WorkspaceUiPaths,
};
use super::migration;
use super::product_state::{
    normalize_project_context, PanelPresentation, PanelPresentationDomain,
};
use super::registry::{
    definition_for_kind, definition_registry, project_surface_id, validate_project_id, SCHEMA_ID,
};

mod panels;
mod project;
mod project_documents;
mod snapshot;
mod store;

use project_documents::{
    layout_issue, registered_layout_domain, surface_panel_ids, validate_project_command,
};

const LAYOUT_DOMAIN_ID: &str = "nucleus.project-layouts";
const LAYOUT_DOMAIN_FILE: &str = "project-layouts.json";
const LAYOUT_DOMAIN_SCHEMA: u32 = 1;

type LayoutDomain = RegisteredLayoutDomain<NoLayoutMigration>;

pub struct WorkspaceUiRuntime {
    store: ConfigStore,
    layout_domain: LayoutDomain,
    presentation_domain: PanelPresentationDomain,
    options: MutationOptions,
    projection_sequence: AtomicU64,
    scope_lock: Mutex<()>,
}

impl WorkspaceUiRuntime {
    pub fn new(roots: StorageRoots, paths: &WorkspaceUiPaths) -> Result<Self, String> {
        let registry = definition_registry()?;
        let prepared = migration::prepare(
            paths.project_layouts(),
            paths.panel_presentations(),
            paths.legacy_layout_backup(),
            paths.layout_migration_receipt(),
            &registry,
        )?;
        let layout_domain = registered_layout_domain(registry)?;
        let presentation_domain = PanelPresentationDomain::new()?;
        let coordination = CoordinationAuthority::new(roots.data())
            .map_err(|error| format!("create Nucleus layout coordination failed: {error}"))?;
        let mut store = ConfigStore::new(roots, coordination);
        store
            .register(&layout_domain)
            .map_err(|error| format!("register Nucleus layout domain failed: {error}"))?;
        store.register(&presentation_domain).map_err(|error| {
            format!("register Nucleus panel presentation domain failed: {error}")
        })?;
        let runtime = Self {
            store,
            layout_domain,
            presentation_domain,
            options: MutationOptions::new(Duration::from_secs(1), DurabilityRequirement::Atomic),
            projection_sequence: AtomicU64::new(0),
            scope_lock: Mutex::new(()),
        };
        if let Some(prepared) = prepared {
            runtime.publish_migration(&prepared)?;
            prepared.complete(paths.project_layouts(), paths.panel_presentations())?;
        }
        Ok(runtime)
    }

    pub fn snapshot(&self, project_id: &str) -> Result<WorkspaceLayoutSnapshotDto, String> {
        validate_project_id(project_id)?;
        let _guard = self
            .scope_lock
            .lock()
            .map_err(|_| "Nucleus layout scope lock is poisoned".to_owned())?;
        self.ensure_project(project_id)?;
        self.snapshot_locked(project_id)
    }

    pub fn prepare_panel(
        &self,
        project_id: &str,
        presentation: WorkspacePanelPresentationInputDto,
    ) -> Result<WorkspacePreparedPanelDto, String> {
        validate_project_id(project_id)?;
        let _guard = self
            .scope_lock
            .lock()
            .map_err(|_| "Nucleus layout scope lock is poisoned".to_owned())?;
        self.ensure_project(project_id)?;
        let (panel_instance_id, _) = PanelPresentation::from_input(project_id, &presentation)?;
        let panel_definition_id = definition_for_kind(&presentation.kind)?;
        let region_id = self
            .layout_domain
            .registry()
            .default_region(
                &longhorn_core::LayoutSchemaId::new(SCHEMA_ID)
                    .map_err(|error| error.to_string())?,
                &panel_definition_id,
            )
            .map_err(|error| error.to_string())?
            .ok_or_else(|| {
                format!(
                    "Nucleus panel kind {} has no default region",
                    presentation.kind
                )
            })?;
        Ok(WorkspacePreparedPanelDto {
            panel_instance_id,
            panel_definition_id: panel_definition_id.as_str().to_owned(),
            region_id: region_id.as_str().to_owned(),
            presentation,
        })
    }

    pub fn dispatch(
        &self,
        project_id: &str,
        mutation: WorkspaceLayoutMutationDto,
    ) -> Result<WorkspaceLayoutMutationResponseDto, String> {
        validate_project_id(project_id)?;
        let _guard = self
            .scope_lock
            .lock()
            .map_err(|_| "Nucleus layout scope lock is poisoned".to_owned())?;
        self.ensure_project(project_id)?;
        let current = self.load_layout()?;
        validate_project_command(project_id, &current, mutation.request.command())?;
        let create_presentation = self.validate_create_presentation(
            project_id,
            mutation.request.command(),
            mutation.create_panel.as_ref(),
        )?;
        let engine = LayoutMutationEngine::new(self.layout_domain.registry());
        let result = match engine.apply(&current, &mutation.request) {
            Ok(receipt) => {
                let before_presentations = self.load_presentations()?;
                let mut next_presentations = before_presentations.clone();
                if let Some((id, presentation)) = create_presentation {
                    next_presentations
                        .projects
                        .entry(project_id.to_owned())
                        .or_default()
                        .insert(id, presentation);
                } else if let LayoutMutationCommand::ClosePanel { panel_instance_id } =
                    mutation.request.command()
                {
                    let records =
                        next_presentations
                            .projects
                            .get_mut(project_id)
                            .ok_or_else(|| {
                                format!("Nucleus panel presentations are missing for {project_id}")
                            })?;
                    records.remove(panel_instance_id.as_str()).ok_or_else(|| {
                        format!("Nucleus panel presentation is missing for {panel_instance_id}")
                    })?;
                }
                let presentations_changed = next_presentations != before_presentations;
                if presentations_changed {
                    self.publish_presentations(next_presentations)?;
                }

                let committed = receipt.authoritative_document().clone();
                if let Err(error) =
                    self.store
                        .mutate(&self.layout_domain, self.options, |document| {
                            if document != &current {
                                return Err(layout_issue(
                                    "Nucleus layout changed during serialized command dispatch",
                                ));
                            }
                            *document = committed.clone();
                            Ok(())
                        })
                {
                    if presentations_changed {
                        let _ = self.publish_presentations(before_presentations);
                    }
                    return Err(format!("publish Nucleus layout command failed: {error}"));
                }
                WorkspaceLayoutDispatchResultDto::Committed { receipt }
            }
            Err(rejection) => WorkspaceLayoutDispatchResultDto::Rejected { rejection },
        };
        Ok(WorkspaceLayoutMutationResponseDto {
            result,
            snapshot: self.snapshot_locked(project_id)?,
        })
    }

    pub fn update_panel_presentation(
        &self,
        project_id: &str,
        panel_instance_id: &str,
        input: WorkspacePanelPresentationInputDto,
    ) -> Result<WorkspaceLayoutSnapshotDto, String> {
        validate_project_id(project_id)?;
        let _guard = self
            .scope_lock
            .lock()
            .map_err(|_| "Nucleus layout scope lock is poisoned".to_owned())?;
        self.ensure_project(project_id)?;
        let document = self.load_layout()?;
        let surface = document
            .surface(&project_surface_id(project_id)?)
            .ok_or_else(|| format!("Nucleus layout is missing for project {project_id}"))?;
        let instance_id =
            PanelInstanceId::new(panel_instance_id).map_err(|error| error.to_string())?;
        if !surface_panel_ids(surface).contains(&instance_id) {
            return Err(format!(
                "panel {panel_instance_id} is outside project {project_id}"
            ));
        }
        let instance = document
            .panel_instance(&instance_id)
            .ok_or_else(|| format!("panel {panel_instance_id} is missing"))?;
        if definition_for_kind(&input.kind)? != *instance.definition_id() {
            return Err(format!("panel {panel_instance_id} kind cannot change"));
        }
        let (derived_id, presentation) = PanelPresentation::from_input(project_id, &input)?;
        if derived_id != panel_instance_id {
            return Err(format!(
                "panel {panel_instance_id} external identity cannot change"
            ));
        }
        let mut presentations = self.load_presentations()?;
        let records = presentations
            .projects
            .get_mut(project_id)
            .ok_or_else(|| format!("Nucleus panel presentations are missing for {project_id}"))?;
        if !records.contains_key(panel_instance_id) {
            return Err(format!("panel presentation {panel_instance_id} is missing"));
        }
        records.insert(panel_instance_id.to_owned(), presentation);
        self.publish_presentations(presentations)?;
        self.snapshot_locked(project_id)
    }

    pub fn update_project_context(
        &self,
        project_id: &str,
        context: WorkspaceProjectContextDto,
    ) -> Result<WorkspaceLayoutSnapshotDto, String> {
        validate_project_id(project_id)?;
        let context = normalize_project_context(project_id, context)?;
        let _guard = self
            .scope_lock
            .lock()
            .map_err(|_| "Nucleus layout scope lock is poisoned".to_owned())?;
        self.ensure_project(project_id)?;
        let mut presentations = self.load_presentations()?;
        presentations
            .contexts
            .insert(project_id.to_owned(), context);
        self.publish_presentations(presentations)?;
        self.snapshot_locked(project_id)
    }
}
