use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::Duration;

use longhorn_config::{
    ConfigStore, CoordinationAuthority, DurabilityRequirement, LoadOutcome, MutationOptions,
    StorageRoots,
};
use longhorn_core::PanelInstanceId;
use longhorn_layout::{LayoutDocument, LayoutMutationCommand, LayoutMutationEngine};
use longhorn_layout_config::{NoLayoutMigration, RegisteredLayoutDomain};

use super::dto::{
    WorkspaceLayoutDispatchResultDto, WorkspaceLayoutMutationDto,
    WorkspaceLayoutMutationResponseDto, WorkspaceLayoutSnapshotDto,
    WorkspacePanelPresentationInputDto, WorkspacePreparedPanelDto, WorkspaceUiPaths,
};
use super::migration;
use super::product_state::{PanelPresentation, PanelPresentationDomain, PanelPresentationState};
use super::registry::{
    agent_chat_instance, container_id, definition_for_kind, definition_registry, panel_instance_id,
    validate_project_id, PENDING_PROJECT_SCOPE, SCHEMA_ID,
};

mod project_documents;

use project_documents::{
    append_project, claim_pending_document, container_panel_ids, layout_issue,
    registered_layout_domain, remap_container, seeded_container, validate_project_command,
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
        let container = document
            .container(&container_id(project_id)?)
            .ok_or_else(|| format!("Nucleus layout is missing for project {project_id}"))?;
        let instance_id =
            PanelInstanceId::new(panel_instance_id).map_err(|error| error.to_string())?;
        if !container_panel_ids(container).contains(&instance_id) {
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

    fn snapshot_locked(&self, project_id: &str) -> Result<WorkspaceLayoutSnapshotDto, String> {
        let document = self.load_layout()?;
        let project_container_id = container_id(project_id)?;
        let container = document
            .container(&project_container_id)
            .ok_or_else(|| format!("Nucleus layout is missing for project {project_id}"))?;
        let presentations = self.load_presentations()?;
        let project_presentations = presentations
            .projects
            .get(project_id)
            .ok_or_else(|| format!("Nucleus panel presentations are missing for {project_id}"))?;
        let mut panels = Vec::new();
        for region in container.regions() {
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
            container_id: project_container_id.as_str().to_owned(),
            document,
            schemas: registry.schemas().cloned().collect(),
            panel_definitions: registry.panel_definitions().cloned().collect(),
            panels,
        })
    }

    fn validate_create_presentation(
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

    fn publish_migration(
        &self,
        prepared: &migration::PreparedLayoutMigration,
    ) -> Result<(), String> {
        if prepared.publish_presentations {
            let value = prepared.presentations.clone();
            self.store
                .mutate(&self.presentation_domain, self.options, |current| {
                    *current = value.clone();
                    Ok(())
                })
                .map_err(|error| {
                    format!("publish migrated Nucleus panel presentations failed: {error}")
                })?;
        }
        if prepared.publish_layout {
            let value = prepared.document.clone();
            self.store
                .mutate(&self.layout_domain, self.options, |current| {
                    *current = value.clone();
                    Ok(())
                })
                .map_err(|error| format!("publish migrated Nucleus layouts failed: {error}"))?;
        }
        self.load_layout()?;
        self.load_presentations()?;
        Ok(())
    }

    fn ensure_project(&self, project_id: &str) -> Result<(), String> {
        let document = self.load_layout()?;
        let project_container = container_id(project_id)?;
        if document.container(&project_container).is_some() {
            let presentations = self.load_presentations()?;
            if presentations.projects.contains_key(project_id) {
                return Ok(());
            }
            return Err(format!(
                "Nucleus panel presentations are missing for project {project_id}"
            ));
        }

        let pending_container = container_id(PENDING_PROJECT_SCOPE)?;
        if document.container(&pending_container).is_some() {
            return self.claim_pending_project(project_id, &document);
        }

        let mut presentations = self.load_presentations()?;
        presentations
            .projects
            .entry(project_id.to_owned())
            .or_insert(BTreeMap::from([PanelPresentation::agent_chat(project_id)?]));
        self.publish_presentations(presentations)?;

        let container = seeded_container(project_id)?;
        let instance = agent_chat_instance(project_id)?;
        self.store
            .mutate(&self.layout_domain, self.options, |current| {
                if current.container(&project_container).is_some() {
                    return Ok(());
                }
                if current.container(&pending_container).is_some() {
                    return Err(layout_issue(
                        "pending legacy layout appeared while seeding a project",
                    ));
                }
                *current = append_project(current, container.clone(), [instance.clone()])?;
                Ok(())
            })
            .map_err(|error| format!("seed Nucleus project layout failed: {error}"))?;
        Ok(())
    }

    fn claim_pending_project(
        &self,
        project_id: &str,
        document: &LayoutDocument,
    ) -> Result<(), String> {
        let pending_id = container_id(PENDING_PROJECT_SCOPE)?;
        let target_id = container_id(project_id)?;
        let pending = document
            .container(&pending_id)
            .ok_or_else(|| "pending Nucleus layout container disappeared".to_owned())?;
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
                if current.container(&target_container.id().clone()).is_some() {
                    return Ok(());
                }
                *current =
                    claim_pending_document(current, &pending_id, target_container.clone(), &remap)?;
                Ok(())
            })
            .map_err(|error| format!("claim pending Nucleus project layout failed: {error}"))?;
        Ok(())
    }

    fn load_layout(&self) -> Result<LayoutDocument, String> {
        match self
            .store
            .load(&self.layout_domain)
            .map_err(|error| format!("load Nucleus layout domain failed: {error}"))?
        {
            LoadOutcome::Ready(loaded) => Ok(loaded.value),
            other => Err(format!(
                "Nucleus layout domain requires recovery: {other:?}"
            )),
        }
    }

    fn load_presentations(&self) -> Result<PanelPresentationState, String> {
        match self
            .store
            .load(&self.presentation_domain)
            .map_err(|error| format!("load Nucleus panel presentations failed: {error}"))?
        {
            LoadOutcome::Ready(loaded) => Ok(loaded.value),
            other => Err(format!(
                "Nucleus panel presentation domain requires recovery: {other:?}"
            )),
        }
    }

    fn publish_presentations(&self, value: PanelPresentationState) -> Result<(), String> {
        self.store
            .mutate(&self.presentation_domain, self.options, |current| {
                *current = value.clone();
                Ok(())
            })
            .map_err(|error| format!("publish Nucleus panel presentations failed: {error}"))?;
        Ok(())
    }
}
