use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use longhorn_config::Sha256Digest;
use longhorn_core::SurfaceRevision;
use longhorn_surfaces::{
    normalize_layout, validate_layout, LayoutDefinitionRegistry, PanelInstance, RegionState,
    SizingSlotState, SurfaceDocument, SurfaceRecord,
};
use serde::Serialize;
use serde_json::Value;

use super::legacy::{decode_project_layout_source, LegacyProjectLayout};
use super::product_state::{
    PanelPresentation, PanelPresentationState, DOMAIN_ID as PRESENTATION_DOMAIN_ID,
};
use super::registry::{
    definition_for_kind, panel_instance_id, project_surface_id, ratio, region_id, sizing_slot_id,
    PENDING_PROJECT_SCOPE, REGION_IDS, SCHEMA_ID, SIZING_SLOT_IDS,
};

#[derive(Clone, Debug)]
pub struct PreparedLayoutMigration {
    pub document: SurfaceDocument,
    pub presentations: PanelPresentationState,
    pub publish_layout: bool,
    pub publish_presentations: bool,
    source_sha256: Sha256Digest,
    source_bytes: u64,
    backup_path: PathBuf,
    receipt_path: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LayoutMigrationReceipt<'a> {
    migration: &'static str,
    source_sha256: &'a str,
    source_bytes: u64,
    backup_path: &'a Path,
    layout_path: &'a Path,
    layout_sha256: String,
    presentation_path: &'a Path,
    presentation_sha256: String,
    project_count: usize,
    pending_legacy_layout: bool,
}

pub fn prepare(
    layout_path: &Path,
    presentation_path: &Path,
    backup_path: &Path,
    receipt_path: &Path,
    registry: &LayoutDefinitionRegistry,
) -> Result<Option<PreparedLayoutMigration>, String> {
    if receipt_path.exists() {
        if layout_path.exists() && presentation_path.exists() {
            return Ok(None);
        }
        return Err(format!(
            "Nucleus layout migration receipt at {} exists but a target is missing",
            receipt_path.display()
        ));
    }

    let layout_is_current = current_domain(layout_path, "nucleus.project-layouts")?;
    let presentations_are_current = current_domain(presentation_path, PRESENTATION_DOMAIN_ID)?;

    let source = if layout_path.exists() && !layout_is_current {
        let bytes = fs::read(layout_path).map_err(|error| {
            format!(
                "read legacy project layouts at {} failed: {error}",
                layout_path.display()
            )
        })?;
        let converted = convert(&bytes, registry)?;
        publish_verified_backup(backup_path, &bytes)?;
        fs::remove_file(layout_path).map_err(|error| {
            format!(
                "remove backed-up legacy project layouts at {} failed: {error}",
                layout_path.display()
            )
        })?;
        return Ok(Some(prepared(
            converted,
            bytes,
            !layout_is_current,
            !presentations_are_current,
            backup_path,
            receipt_path,
        )));
    } else if backup_path.exists() {
        fs::read(backup_path).map_err(|error| {
            format!(
                "read interrupted layout migration backup at {} failed: {error}",
                backup_path.display()
            )
        })?
    } else {
        return Ok(None);
    };

    let converted = convert(&source, registry)?;
    Ok(Some(prepared(
        converted,
        source,
        !layout_is_current,
        !presentations_are_current,
        backup_path,
        receipt_path,
    )))
}

impl PreparedLayoutMigration {
    pub fn complete(&self, layout_path: &Path, presentation_path: &Path) -> Result<(), String> {
        let layout = fs::read(layout_path).map_err(|error| {
            format!(
                "read migrated layout domain at {} failed: {error}",
                layout_path.display()
            )
        })?;
        let presentation = fs::read(presentation_path).map_err(|error| {
            format!(
                "read migrated panel presentation domain at {} failed: {error}",
                presentation_path.display()
            )
        })?;
        let receipt = LayoutMigrationReceipt {
            migration: "nucleus-project-layout-card098-v1",
            source_sha256: self.source_sha256.as_str(),
            source_bytes: self.source_bytes,
            backup_path: &self.backup_path,
            layout_path,
            layout_sha256: Sha256Digest::from_bytes(&layout).as_str().to_owned(),
            presentation_path,
            presentation_sha256: Sha256Digest::from_bytes(&presentation).as_str().to_owned(),
            project_count: self.presentations.projects.len()
                - usize::from(
                    self.presentations
                        .projects
                        .contains_key(PENDING_PROJECT_SCOPE),
                ),
            pending_legacy_layout: self
                .presentations
                .projects
                .contains_key(PENDING_PROJECT_SCOPE),
        };
        write_json_atomically(&self.receipt_path, &receipt)
    }
}

fn prepared(
    converted: (SurfaceDocument, PanelPresentationState),
    source: Vec<u8>,
    publish_layout: bool,
    publish_presentations: bool,
    backup_path: &Path,
    receipt_path: &Path,
) -> PreparedLayoutMigration {
    PreparedLayoutMigration {
        document: converted.0,
        presentations: converted.1,
        publish_layout,
        publish_presentations,
        source_sha256: Sha256Digest::from_bytes(&source),
        source_bytes: source.len() as u64,
        backup_path: backup_path.to_path_buf(),
        receipt_path: receipt_path.to_path_buf(),
    }
}

fn convert(
    bytes: &[u8],
    registry: &LayoutDefinitionRegistry,
) -> Result<(SurfaceDocument, PanelPresentationState), String> {
    let source = decode_project_layout_source(bytes)?;
    let mut surfaces = Vec::new();
    let mut instances = Vec::new();
    let mut presentations = PanelPresentationState::default();
    for (project_id, layout) in source.project_layouts {
        let converted = convert_project(&project_id, layout)?;
        surfaces.push(converted.surface);
        instances.extend(converted.instances);
        presentations
            .projects
            .insert(project_id, converted.presentations);
    }
    if let Some(layout) = source.pending_legacy_layout {
        let converted = convert_project(PENDING_PROJECT_SCOPE, layout)?;
        surfaces.push(converted.surface);
        instances.extend(converted.instances);
        presentations
            .projects
            .insert(PENDING_PROJECT_SCOPE.to_owned(), converted.presentations);
    }
    let document = normalize_layout(
        registry,
        &SurfaceDocument::new(SurfaceRevision::INITIAL, surfaces, instances, []),
    )
    .map_err(|error| format!("normalize migrated project layouts failed: {error}"))?;
    validate_layout(registry, &document)
        .map_err(|error| format!("validate migrated project layouts failed: {error}"))?;
    Ok((document, presentations))
}

struct ConvertedProject {
    surface: SurfaceRecord,
    instances: Vec<PanelInstance>,
    presentations: BTreeMap<String, PanelPresentation>,
}

fn convert_project(
    project_id: &str,
    layout: LegacyProjectLayout,
) -> Result<ConvertedProject, String> {
    let mut instances = Vec::new();
    let mut presentations = BTreeMap::new();
    let mut external_to_internal = BTreeMap::new();
    let mut seen_external = BTreeSet::new();
    let mut region_states = Vec::new();

    for region_name in REGION_IDS {
        let panels = layout
            .regions
            .get(region_name)
            .expect("registered Nucleus region has a DTO field");
        let mut ids = Vec::new();
        for panel in panels {
            if !seen_external.insert(panel.id.clone()) {
                return Err(format!(
                    "project {project_id} repeats external panel id {}",
                    panel.id
                ));
            }
            let definition = definition_for_kind(&panel.kind)?;
            let internal = panel_instance_id(project_id, &panel.id)?;
            let (presentation_id, presentation) = PanelPresentation::from_panel(project_id, panel)?;
            external_to_internal.insert(panel.id.clone(), internal.clone());
            presentations.insert(presentation_id, presentation);
            ids.push(internal.clone());
            instances.push(PanelInstance::new(internal, definition));
        }
        let active = layout
            .active_panels
            .get(region_name)
            .and_then(|external| external_to_internal.get(external))
            .cloned();
        region_states.push(RegionState::new(
            region_id(region_name)?,
            ids,
            active,
            matches!(region_name, "center_bottom" | "right_top" | "right_bottom").then_some(false),
        ));
    }

    let values = [
        layout.layout.left_center_ratio,
        layout.layout.center_right_ratio,
        layout.layout.center_stack_ratio,
        layout.layout.right_stack_ratio,
    ];
    let sizing = SIZING_SLOT_IDS
        .into_iter()
        .zip(values)
        .map(|(id, value)| {
            let millionths = (value * 1_000_000.0).round() as u32;
            Ok(SizingSlotState::new(
                sizing_slot_id(id)?,
                ratio(millionths)?,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(ConvertedProject {
        surface: SurfaceRecord::new(
            project_surface_id(project_id)?,
            longhorn_core::LayoutSchemaId::new(SCHEMA_ID).map_err(|error| error.to_string())?,
            None,
            region_states,
            sizing,
            [longhorn_surfaces::SurfaceHostPreference::new(
                super::registry::workspace_window_id()?,
                0,
            )],
        ),
        instances,
        presentations,
    })
}

fn current_domain(path: &Path, expected: &str) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let bytes = fs::read(path).map_err(|error| {
        format!(
            "read domain candidate at {} failed: {error}",
            path.display()
        )
    })?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "domain candidate at {} is not valid JSON: {error}",
            path.display()
        )
    })?;
    let Some(domain) = value.get("domain").and_then(Value::as_str) else {
        return Ok(false);
    };
    if domain != expected {
        return Err(format!(
            "domain candidate at {} identifies {domain}, expected {expected}",
            path.display()
        ));
    }
    Ok(true)
}

fn publish_verified_backup(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.exists() {
        let existing =
            fs::read(path).map_err(|error| format!("read legacy layout backup failed: {error}"))?;
        if Sha256Digest::from_bytes(&existing) != Sha256Digest::from_bytes(bytes) {
            return Err(format!(
                "legacy layout backup at {} contains different source bytes",
                path.display()
            ));
        }
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "legacy layout backup path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create legacy layout backup directory failed: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes)
        .map_err(|error| format!("write legacy layout backup failed: {error}"))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("publish legacy layout backup failed: {error}"))?;
    let published =
        fs::read(path).map_err(|error| format!("verify legacy layout backup failed: {error}"))?;
    if Sha256Digest::from_bytes(&published) != Sha256Digest::from_bytes(bytes) {
        return Err("published legacy layout backup digest does not match source".to_owned());
    }
    Ok(())
}

fn write_json_atomically(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "layout migration receipt path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create layout migration receipt directory failed: {error}"))?;
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("encode layout migration receipt failed: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes)
        .map_err(|error| format!("write layout migration receipt failed: {error}"))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("publish layout migration receipt failed: {error}"))
}
