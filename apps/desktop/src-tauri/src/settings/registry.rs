use longhorn_command_settings::{
    register_command_settings, COMMAND_CATALOGUE_CAPABILITY_ID, WRITABLE_KEYMAP_CAPABILITY_ID,
};
use longhorn_settings::{
    SettingsApplyUnitDefinition, SettingsCapabilityDefinition, SettingsLimits,
    SettingsModuleDefinition, SettingsMutationTiming, SettingsPageDefinition, SettingsPageFeatures,
    SettingsRegistry, SettingsRegistryBuilder, SettingsRendererDefinition, SettingsScopeDefinition,
    SettingsSectionDefinition,
};
use longhorn_settings_config::{
    register_config_operations_settings, BACKUP_CREATE_CAPABILITY_ID, BACKUP_EXPORT_CAPABILITY_ID,
    BACKUP_INVENTORY_CAPABILITY_ID, BACKUP_RETENTION_CAPABILITY_ID,
    STORAGE_DIAGNOSTICS_CAPABILITY_ID,
};

use super::*;

pub(super) fn build_registry() -> Result<SettingsRegistry, String> {
    let mut builder = SettingsRegistryBuilder::new(GENERATION, SettingsLimits::default());
    builder
        .register_module(SettingsModuleDefinition {
            id: module_id(MODULE_ID),
            label: "Nucleus".to_owned(),
            order: 0,
        })
        .map_err(registry_error)?;
    builder
        .register_section(SettingsSectionDefinition {
            id: section_id(SECTION_ID),
            module_id: module_id(MODULE_ID),
            label: "Application".to_owned(),
            order: 0,
        })
        .map_err(registry_error)?;
    builder
        .register_capability(SettingsCapabilityDefinition {
            id: capability_id(CAPABILITY_ID),
            module_id: module_id(MODULE_ID),
        })
        .map_err(registry_error)?;

    for (id, renderer, label, keywords, order, scope, unit) in [
        (
            GENERAL_PAGE_ID,
            GENERAL_RENDERER_ID,
            "General",
            vec!["fixture".to_owned(), "status".to_owned()],
            0,
            GENERAL_SCOPE_ID,
            GENERAL_UNIT_ID,
        ),
        (
            APPEARANCE_PAGE_ID,
            APPEARANCE_RENDERER_ID,
            "Appearance",
            vec!["density".to_owned(), "interface".to_owned()],
            10,
            APPEARANCE_SCOPE_ID,
            APPEARANCE_UNIT_ID,
        ),
        (
            AGENT_PAGE_ID,
            AGENT_RENDERER_ID,
            "Agent & models",
            vec![
                "provider".to_owned(),
                "model".to_owned(),
                "reasoning".to_owned(),
                "plan".to_owned(),
            ],
            20,
            AGENT_SCOPE_ID,
            AGENT_UNIT_ID,
        ),
    ] {
        register_page(
            &mut builder,
            PageRegistration {
                id,
                renderer,
                label,
                keywords,
                order,
                scope,
                unit,
            },
        )?;
    }

    register_command_settings(&mut builder).map_err(registry_error)?;
    register_config_operations_settings(&mut builder).map_err(registry_error)?;

    builder
        .seal([
            capability_id(CAPABILITY_ID),
            capability_id(COMMAND_CATALOGUE_CAPABILITY_ID),
            capability_id(WRITABLE_KEYMAP_CAPABILITY_ID),
            capability_id(STORAGE_DIAGNOSTICS_CAPABILITY_ID),
            capability_id(BACKUP_INVENTORY_CAPABILITY_ID),
            capability_id(BACKUP_CREATE_CAPABILITY_ID),
            capability_id(BACKUP_EXPORT_CAPABILITY_ID),
            capability_id(BACKUP_RETENTION_CAPABILITY_ID),
        ])
        .map_err(registry_error)
}

struct PageRegistration {
    id: &'static str,
    renderer: &'static str,
    label: &'static str,
    keywords: Vec<String>,
    order: i32,
    scope: &'static str,
    unit: &'static str,
}

fn register_page(
    builder: &mut SettingsRegistryBuilder,
    page: PageRegistration,
) -> Result<(), String> {
    builder
        .register_renderer(SettingsRendererDefinition {
            id: renderer_id(page.renderer),
            module_id: module_id(MODULE_ID),
        })
        .map_err(registry_error)?;
    builder
        .register_scope(SettingsScopeDefinition {
            id: scope_id(page.scope),
            module_id: module_id(MODULE_ID),
        })
        .map_err(registry_error)?;
    builder
        .register_apply_unit(SettingsApplyUnitDefinition {
            id: apply_unit_id(page.unit),
            module_id: module_id(MODULE_ID),
            scope_id: scope_id(page.scope),
            timing: if page.unit == GENERAL_UNIT_ID {
                SettingsMutationTiming::Immediate
            } else {
                SettingsMutationTiming::Staged
            },
            reset_supported: true,
        })
        .map_err(registry_error)?;
    builder
        .register_page(SettingsPageDefinition {
            id: page_id(page.id),
            module_id: module_id(MODULE_ID),
            section_id: section_id(SECTION_ID),
            renderer_id: renderer_id(page.renderer),
            label: page.label.to_owned(),
            keywords: page.keywords,
            order: page.order,
            anchors: Vec::new(),
            required_capabilities: vec![capability_id(CAPABILITY_ID)],
            readable_scope_ids: vec![scope_id(page.scope)],
            writable_apply_unit_ids: vec![apply_unit_id(page.unit)],
            features: SettingsPageFeatures {
                reset: true,
                ..SettingsPageFeatures::default()
            },
        })
        .map_err(registry_error)
}

fn registry_error(error: impl std::fmt::Display) -> String {
    format!("build Nucleus settings registry failed: {error}")
}
