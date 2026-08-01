use std::collections::{BTreeMap, BTreeSet};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::Duration;

use longhorn_config::{
    ConfigStore, CoordinationAuthority, DomainDescriptor, DomainFilePath, DomainIssue,
    DurabilityRequirement, LoadOutcome, MutationOptions, StorageClass, StorageRoots,
};
use longhorn_core::{DomainId, LayoutRequestId, LayoutRevision, PanelInstanceId, SchemaVersion};
use longhorn_layout::{
    validate_document, LayoutContainer, LayoutDefinitionRegistry, LayoutDocument,
    LayoutMutationCommand, LayoutMutationEngine, LayoutMutationRequest, PanelInstance, RegionState,
    SizingSlotState,
};
use longhorn_layout_config::{LayoutBackupPolicy, NoLayoutMigration, RegisteredLayoutDomain};

use super::dto::{
    WorkspaceLayoutDto, WorkspacePanelDto, WorkspaceRegionsDto, WorkspaceUiConfigDto,
    WorkspaceUiPaths, WorkspaceWindowDto, WorkspaceWindowPlacementDto, DTO_SCHEMA_VERSION,
};
use super::migration;
use super::product_state::{PanelPresentation, PanelPresentationDomain, PanelPresentationState};
use super::registry::{
    agent_chat_instance, container_id, default_title, definition_for_kind, definition_registry,
    empty_container, empty_document, kind_for_definition, panel_instance_id, ratio, region_id,
    sizing_slot_id, validate_project_id, PENDING_PROJECT_SCOPE, PRIMARY_WINDOW_ID, REGION_IDS,
    SCHEMA_ID, SIZING_SLOT_IDS,
};

const LAYOUT_DOMAIN_ID: &str = "nucleus.project-layouts";
const LAYOUT_DOMAIN_FILE: &str = "project-layouts.json";
const LAYOUT_DOMAIN_SCHEMA: u32 = 1;
const MAX_BATCH_COMMANDS: usize = 4_096;

type LayoutDomain = RegisteredLayoutDomain<NoLayoutMigration>;

pub struct WorkspaceUiRuntime {
    store: ConfigStore,
    layout_domain: LayoutDomain,
    presentation_domain: PanelPresentationDomain,
    options: MutationOptions,
    request_sequence: AtomicU64,
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
            request_sequence: AtomicU64::new(0),
            scope_lock: Mutex::new(()),
        };
        if let Some(prepared) = prepared {
            runtime.publish_migration(&prepared)?;
            prepared.complete(paths.project_layouts(), paths.panel_presentations())?;
        }
        Ok(runtime)
    }

    pub fn load(
        &self,
        project_id: &str,
        placement: WorkspaceWindowPlacementDto,
    ) -> Result<WorkspaceUiConfigDto, String> {
        validate_project_id(project_id)?;
        let _guard = self
            .scope_lock
            .lock()
            .map_err(|_| "Nucleus layout scope lock is poisoned".to_owned())?;
        self.ensure_project(project_id)?;
        self.materialize(project_id, placement)
    }

    pub fn save(
        &self,
        project_id: &str,
        requested: WorkspaceUiConfigDto,
        placement: WorkspaceWindowPlacementDto,
    ) -> Result<WorkspaceUiConfigDto, String> {
        validate_project_id(project_id)?;
        validate_request_envelope(&requested)?;
        let _guard = self
            .scope_lock
            .lock()
            .map_err(|_| "Nucleus layout scope lock is poisoned".to_owned())?;
        self.ensure_project(project_id)?;
        let current = self.load_layout()?;
        if current.revision().get() != requested.layout_revision {
            return Err(format!(
                "stale Nucleus layout revision: expected {}, current {}",
                requested.layout_revision,
                current.revision().get()
            ));
        }
        let desired =
            desired_project(project_id, &requested.window, self.layout_domain.registry())?;
        let requests = self.requests_for_project(&current, &desired)?;

        let current_presentations = self.load_presentations()?;
        let mut superset = current_presentations.clone();
        superset
            .projects
            .entry(project_id.to_owned())
            .or_default()
            .extend(desired.presentations.clone());
        if superset != current_presentations {
            self.publish_presentations(superset)?;
        }

        if !requests.is_empty() {
            let registry = self.layout_domain.registry();
            self.store
                .mutate(&self.layout_domain, self.options, |document| {
                    let engine = LayoutMutationEngine::new(registry);
                    let mut candidate = document.clone();
                    for request in &requests {
                        let receipt = engine
                            .apply(&candidate, request)
                            .map_err(|error| layout_issue(error.to_string()))?;
                        candidate = receipt.authoritative_document().clone();
                    }
                    *document = candidate;
                    Ok(())
                })
                .map_err(|error| {
                    format!("publish Nucleus layout mutation batch failed: {error}")
                })?;
        }

        let mut exact = self.load_presentations()?;
        exact
            .projects
            .insert(project_id.to_owned(), desired.presentations);
        self.publish_presentations(exact)?;
        self.materialize(project_id, placement)
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

    fn materialize(
        &self,
        project_id: &str,
        placement: WorkspaceWindowPlacementDto,
    ) -> Result<WorkspaceUiConfigDto, String> {
        let document = self.load_layout()?;
        let presentations = self.load_presentations()?;
        let container = document
            .container(&container_id(project_id)?)
            .ok_or_else(|| format!("Nucleus layout is missing for project {project_id}"))?;
        let project_presentations = presentations
            .projects
            .get(project_id)
            .ok_or_else(|| format!("Nucleus panel presentations are missing for {project_id}"))?;
        let regions = materialize_regions(
            self.layout_domain.registry(),
            &document,
            container,
            project_presentations,
        )?;
        let active_panels = materialize_active(container, project_presentations)?;
        Ok(WorkspaceUiConfigDto {
            schema_version: DTO_SCHEMA_VERSION,
            layout_revision: document.revision().get(),
            window: WorkspaceWindowDto {
                id: PRIMARY_WINDOW_ID.to_owned(),
                placement,
                layout: materialize_sizing(container)?,
                regions,
                active_panels,
            },
        })
    }

    fn requests_for_project(
        &self,
        current: &LayoutDocument,
        desired: &DesiredProject,
    ) -> Result<Vec<LayoutMutationRequest>, String> {
        let container_id = desired.container.id().clone();
        let current_container = current
            .container(&container_id)
            .ok_or_else(|| "current Nucleus project layout container is missing".to_owned())?;
        let current_ids = container_panel_ids(current_container);
        let desired_ids = container_panel_ids(&desired.container);
        let desired_instances: BTreeMap<_, _> = desired
            .instances
            .iter()
            .map(|instance| (instance.id().clone(), instance))
            .collect();
        let mut candidate = current.clone();
        let engine = LayoutMutationEngine::new(self.layout_domain.registry());
        let mut requests = Vec::new();

        for id in &current_ids {
            let removed = !desired_ids.contains(id);
            let replaced = desired_instances
                .get(id)
                .zip(current.panel_instance(id))
                .is_some_and(|(desired, existing)| {
                    desired.definition_id() != existing.definition_id()
                });
            if removed || replaced {
                self.push_request(
                    &engine,
                    &mut candidate,
                    &mut requests,
                    LayoutMutationCommand::ClosePanel {
                        panel_instance_id: id.clone(),
                    },
                )?;
            }
        }

        for desired_instance in &desired.instances {
            let needs_create = candidate.panel_instance(desired_instance.id()).is_none();
            if !needs_create {
                continue;
            }
            let region = panel_region(&desired.container, desired_instance.id())?;
            let insertion_index = candidate
                .container(&container_id)
                .and_then(|container| container.region(&region))
                .map(|state| state.panel_instance_ids().len())
                .ok_or_else(|| "Nucleus create target region is missing".to_owned())?;
            self.push_request(
                &engine,
                &mut candidate,
                &mut requests,
                LayoutMutationCommand::CreatePanel {
                    panel_instance_id: desired_instance.id().clone(),
                    panel_definition_id: desired_instance.definition_id().clone(),
                    container_id: container_id.clone(),
                    region_id: region,
                    insertion_index: u32::try_from(insertion_index)
                        .map_err(|_| "Nucleus region insertion index exceeds u32".to_owned())?,
                },
            )?;
        }

        for desired_instance in &desired.instances {
            let desired_region = panel_region(&desired.container, desired_instance.id())?;
            let current_region = panel_region(
                candidate
                    .container(&container_id)
                    .ok_or_else(|| "Nucleus candidate container is missing".to_owned())?,
                desired_instance.id(),
            )?;
            if current_region == desired_region {
                continue;
            }
            let insertion_index = candidate
                .container(&container_id)
                .and_then(|container| container.region(&desired_region))
                .map(|state| state.panel_instance_ids().len())
                .ok_or_else(|| "Nucleus move target region is missing".to_owned())?;
            self.push_request(
                &engine,
                &mut candidate,
                &mut requests,
                LayoutMutationCommand::MovePanel {
                    panel_instance_id: desired_instance.id().clone(),
                    target_container_id: container_id.clone(),
                    target_region_id: desired_region,
                    insertion_index: u32::try_from(insertion_index)
                        .map_err(|_| "Nucleus region insertion index exceeds u32".to_owned())?,
                },
            )?;
        }

        for desired_region in desired.container.regions() {
            let candidate_region = candidate
                .container(&container_id)
                .and_then(|container| container.region(desired_region.region_id()))
                .ok_or_else(|| "Nucleus candidate region is missing".to_owned())?;
            if candidate_region.panel_instance_ids() != desired_region.panel_instance_ids() {
                self.push_request(
                    &engine,
                    &mut candidate,
                    &mut requests,
                    LayoutMutationCommand::ReorderRegion {
                        container_id: container_id.clone(),
                        region_id: desired_region.region_id().clone(),
                        panel_instance_ids: desired_region.panel_instance_ids().to_vec(),
                    },
                )?;
            }
            let candidate_region = candidate
                .container(&container_id)
                .and_then(|container| container.region(desired_region.region_id()))
                .ok_or_else(|| "Nucleus candidate region is missing".to_owned())?;
            if candidate_region.active_panel_instance_id()
                != desired_region.active_panel_instance_id()
            {
                if let Some(active) = desired_region.active_panel_instance_id() {
                    self.push_request(
                        &engine,
                        &mut candidate,
                        &mut requests,
                        LayoutMutationCommand::ActivatePanel {
                            panel_instance_id: active.clone(),
                        },
                    )?;
                }
            }
        }

        for desired_slot in desired.container.sizing_slots() {
            let candidate_slot = candidate
                .container(&container_id)
                .and_then(|container| container.sizing_slot(desired_slot.sizing_slot_id()))
                .ok_or_else(|| "Nucleus candidate sizing slot is missing".to_owned())?;
            if candidate_slot.ratio() != desired_slot.ratio() {
                self.push_request(
                    &engine,
                    &mut candidate,
                    &mut requests,
                    LayoutMutationCommand::SetSizingSlot {
                        container_id: container_id.clone(),
                        sizing_slot_id: desired_slot.sizing_slot_id().clone(),
                        ratio: desired_slot.ratio(),
                    },
                )?;
            }
        }

        if requests.len() > MAX_BATCH_COMMANDS {
            return Err(format!(
                "Nucleus layout mutation batch exceeds {MAX_BATCH_COMMANDS} commands"
            ));
        }
        Ok(requests)
    }

    fn push_request(
        &self,
        engine: &LayoutMutationEngine<'_>,
        candidate: &mut LayoutDocument,
        requests: &mut Vec<LayoutMutationRequest>,
        command: LayoutMutationCommand,
    ) -> Result<(), String> {
        let sequence = self.request_sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let request = LayoutMutationRequest::new(
            LayoutRequestId::new(format!("request:nucleus:{sequence}"))
                .map_err(|error| error.to_string())?,
            candidate.revision(),
            command,
        );
        let receipt = engine
            .apply(candidate, &request)
            .map_err(|error| format!("Nucleus layout request rejected: {error}"))?;
        *candidate = receipt.authoritative_document().clone();
        requests.push(request);
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

struct DesiredProject {
    container: LayoutContainer,
    instances: Vec<PanelInstance>,
    presentations: BTreeMap<String, PanelPresentation>,
}

fn desired_project(
    project_id: &str,
    window: &WorkspaceWindowDto,
    registry: &LayoutDefinitionRegistry,
) -> Result<DesiredProject, String> {
    if window.id != PRIMARY_WINDOW_ID {
        return Err(format!(
            "Nucleus layout request identifies {}, expected {PRIMARY_WINDOW_ID}",
            window.id
        ));
    }
    let mut instances = Vec::new();
    let mut presentations = BTreeMap::new();
    let mut external_to_internal = BTreeMap::new();
    let mut seen = BTreeSet::new();
    let mut regions = Vec::new();
    for region_name in REGION_IDS {
        let panels = window
            .regions
            .get(region_name)
            .expect("registered Nucleus region has a DTO field");
        let mut ids = Vec::new();
        for panel in panels {
            if !seen.insert(panel.id.clone()) {
                return Err(format!("Nucleus layout repeats panel id {}", panel.id));
            }
            let internal = panel_instance_id(project_id, &panel.id)?;
            let definition = definition_for_kind(&panel.kind)?;
            let (presentation_id, presentation) = PanelPresentation::from_panel(project_id, panel)?;
            external_to_internal.insert(panel.id.clone(), internal.clone());
            ids.push(internal.clone());
            instances.push(PanelInstance::new(internal, definition));
            presentations.insert(presentation_id, presentation);
        }
        let active = match window.active_panels.get(region_name) {
            Some(external) => {
                let internal = external_to_internal
                    .get(external)
                    .ok_or_else(|| format!("Nucleus active panel {external} does not exist"))?;
                if !ids.contains(internal) {
                    return Err(format!(
                        "Nucleus active panel {external} is not in region {region_name}"
                    ));
                }
                Some(internal.clone())
            }
            None => ids.first().cloned(),
        };
        regions.push(RegionState::new(
            region_id(region_name)?,
            ids,
            active,
            matches!(region_name, "center_bottom" | "right_top" | "right_bottom").then_some(false),
        ));
    }
    let values = [
        window.layout.left_center_ratio,
        window.layout.center_right_ratio,
        window.layout.center_stack_ratio,
        window.layout.right_stack_ratio,
    ];
    let sizing = SIZING_SLOT_IDS
        .into_iter()
        .zip(values)
        .map(|(id, value)| {
            if !value.is_finite() || !(0.2..=0.9).contains(&value) {
                return Err(format!(
                    "Nucleus sizing value for {id} is outside 0.2..=0.9"
                ));
            }
            Ok(SizingSlotState::new(
                sizing_slot_id(id)?,
                ratio((value * 1_000_000.0).round() as u32)?,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let container = LayoutContainer::new(
        container_id(project_id)?,
        longhorn_core::LayoutSchemaId::new(SCHEMA_ID).map_err(|error| error.to_string())?,
        regions,
        sizing,
    );
    let document = LayoutDocument::new(
        LayoutRevision::INITIAL,
        [container.clone()],
        instances.clone(),
    );
    validate_document(registry, &document)
        .map_err(|error| format!("Nucleus requested layout is invalid: {error}"))?;
    Ok(DesiredProject {
        container,
        instances,
        presentations,
    })
}

fn registered_layout_domain(registry: LayoutDefinitionRegistry) -> Result<LayoutDomain, String> {
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

fn seeded_container(project_id: &str) -> Result<LayoutContainer, String> {
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

fn append_project(
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

fn claim_pending_document(
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

fn remap_container(
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

fn materialize_regions(
    registry: &LayoutDefinitionRegistry,
    document: &LayoutDocument,
    container: &LayoutContainer,
    presentations: &BTreeMap<String, PanelPresentation>,
) -> Result<WorkspaceRegionsDto, String> {
    let mut by_region = BTreeMap::new();
    for region in container.regions() {
        let panels = region
            .panel_instance_ids()
            .iter()
            .map(|id| materialize_panel(registry, document, container, id, presentations))
            .collect::<Result<Vec<_>, String>>()?;
        by_region.insert(region.region_id().as_str(), panels);
    }
    Ok(WorkspaceRegionsDto {
        left: by_region.remove("left").unwrap_or_default(),
        center_top: by_region.remove("center_top").unwrap_or_default(),
        center_bottom: by_region.remove("center_bottom").unwrap_or_default(),
        right_top: by_region.remove("right_top").unwrap_or_default(),
        right_bottom: by_region.remove("right_bottom").unwrap_or_default(),
    })
}

fn materialize_panel(
    registry: &LayoutDefinitionRegistry,
    document: &LayoutDocument,
    container: &LayoutContainer,
    id: &PanelInstanceId,
    presentations: &BTreeMap<String, PanelPresentation>,
) -> Result<WorkspacePanelDto, String> {
    let instance = document
        .panel_instance(id)
        .ok_or_else(|| format!("Nucleus layout references missing panel {id}"))?;
    let definition = registry
        .panel_definition(instance.definition_id())
        .ok_or_else(|| {
            format!(
                "Nucleus layout references unknown definition {}",
                instance.definition_id()
            )
        })?;
    let presentation = presentations
        .get(id.as_str())
        .ok_or_else(|| format!("Nucleus panel presentation is missing for {id}"))?;
    let kind = kind_for_definition(instance.definition_id())?;
    let allowed_regions = registry
        .eligible_regions(container.schema_id(), instance.definition_id())
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|region| region.as_str().to_owned())
        .collect();
    Ok(WorkspacePanelDto {
        id: presentation.external_id.clone(),
        kind: kind.to_owned(),
        title: if presentation.title.is_empty() {
            default_title(kind).to_owned()
        } else {
            presentation.title.clone()
        },
        closeable: definition.is_closeable(),
        movable: definition.is_movable(),
        resource_targets: presentation.resource_targets.clone(),
        editor_file: presentation.editor_file.clone(),
        forge_diff: presentation.forge_diff.clone(),
        allowed_regions,
    })
}

fn materialize_active(
    container: &LayoutContainer,
    presentations: &BTreeMap<String, PanelPresentation>,
) -> Result<BTreeMap<String, String>, String> {
    container
        .regions()
        .iter()
        .filter_map(|region| {
            region.active_panel_instance_id().map(|id| {
                presentations
                    .get(id.as_str())
                    .map(|presentation| {
                        (
                            region.region_id().as_str().to_owned(),
                            presentation.external_id.clone(),
                        )
                    })
                    .ok_or_else(|| format!("Nucleus active panel presentation is missing for {id}"))
            })
        })
        .collect()
}

fn materialize_sizing(container: &LayoutContainer) -> Result<WorkspaceLayoutDto, String> {
    let value = |id: &str| {
        container
            .sizing_slot(&sizing_slot_id(id)?)
            .map(|slot| f64::from(slot.ratio().millionths()) / 1_000_000.0)
            .ok_or_else(|| format!("Nucleus sizing slot {id} is missing"))
    };
    Ok(WorkspaceLayoutDto {
        left_center_ratio: value("left-center")?,
        center_right_ratio: value("center-right")?,
        center_stack_ratio: value("center-stack")?,
        right_stack_ratio: value("right-stack")?,
    })
}

fn container_panel_ids(container: &LayoutContainer) -> BTreeSet<PanelInstanceId> {
    container
        .regions()
        .iter()
        .flat_map(|region| region.panel_instance_ids().iter().cloned())
        .collect()
}

fn panel_region(
    container: &LayoutContainer,
    panel_id: &PanelInstanceId,
) -> Result<longhorn_core::RegionId, String> {
    container
        .regions()
        .iter()
        .find(|region| region.panel_instance_ids().contains(panel_id))
        .map(|region| region.region_id().clone())
        .ok_or_else(|| format!("panel {panel_id} is not placed in its project container"))
}

fn validate_request_envelope(requested: &WorkspaceUiConfigDto) -> Result<(), String> {
    if requested.schema_version != DTO_SCHEMA_VERSION {
        return Err(format!(
            "workspace UI schema {} is not supported; expected {DTO_SCHEMA_VERSION}",
            requested.schema_version
        ));
    }
    Ok(())
}

fn layout_issue(detail: impl Into<String>) -> DomainIssue {
    DomainIssue::new("nucleus-layout-mutation", detail)
}
