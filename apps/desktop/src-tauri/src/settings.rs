use std::{sync::Arc, time::Duration};

use longhorn_config::{
    ConfigStore, CoordinationAuthority, DurabilityRequirement, MutationOptions, StorageRoots,
};
use longhorn_core::{
    SettingsApplyUnitId, SettingsCapabilityId, SettingsEntryId, SettingsModuleId, SettingsPageId,
    SettingsRendererId, SettingsScopeId, SettingsSectionId,
};
use longhorn_settings::{
    SettingsApplyCommand, SettingsLoadCommand, SettingsLoadOutcome, SettingsMutationResult,
    SettingsRegistryGeneration, SettingsRegistrySnapshot, SettingsRejection, SettingsRejectionCode,
    SettingsResetCommand, SettingsScopeChangedEvent,
};
use longhorn_settings_config::ConfigSettingsApplyUnit;
use longhorn_tauri_settings::{
    mutation_changed_event, SettingsAuthority, SettingsCommandService, SettingsHandlerAssembly,
    SettingsHostError, SETTINGS_SCOPE_CHANGED_EVENT,
};
use tauri::Manager;
use tauri::{Emitter, State, Webview};

#[cfg(test)]
use longhorn_settings::SettingsOpaqueValue;
#[cfg(test)]
use serde_json::Value;

use self::{
    adapters::{AgentPreferencesAdapter, AppearancePreferencesAdapter, GeneralPreferencesAdapter},
    domain::DesktopPreferencesDomain,
    registry::build_registry,
};

mod adapters;
mod domain;
mod registry;

const GENERATION: SettingsRegistryGeneration = SettingsRegistryGeneration::new(4);
const LOCK_TIMEOUT: Duration = Duration::from_secs(1);
const MODULE_ID: &str = "nucleus:desktop-settings";
const SECTION_ID: &str = "nucleus:application";
const CAPABILITY_ID: &str = "nucleus:desktop-settings";
const GENERAL_PAGE_ID: &str = "nucleus:general";
const APPEARANCE_PAGE_ID: &str = "nucleus:appearance";
const AGENT_PAGE_ID: &str = "nucleus:agent-provider";
const GENERAL_RENDERER_ID: &str = "nucleus:settings-general";
const APPEARANCE_RENDERER_ID: &str = "nucleus:settings-appearance";
const AGENT_RENDERER_ID: &str = "nucleus:settings-agent-provider";
const GENERAL_SCOPE_ID: &str = "nucleus:general-preferences";
const APPEARANCE_SCOPE_ID: &str = "nucleus:appearance-preferences";
const AGENT_SCOPE_ID: &str = "nucleus:agent-preferences";
const GENERAL_UNIT_ID: &str = "nucleus:general-preferences";
const APPEARANCE_UNIT_ID: &str = "nucleus:appearance-preferences";
const AGENT_UNIT_ID: &str = "nucleus:agent-preferences";
const FIXTURE_STATUS_ENTRY_ID: &str = "nucleus:show-fixture-status";
const DENSITY_ENTRY_ID: &str = "nucleus:interface-density";
const DEFAULT_MODEL_ENTRY_ID: &str = "nucleus:default-agent-model";
const DEFAULT_PROVIDER_INSTANCE_ENTRY_ID: &str = "nucleus:default-agent-provider";
const DEFAULT_PROVIDER_ID_ENTRY_ID: &str = "nucleus:default-model-provider";
const DEFAULT_REASONING_ENTRY_ID: &str = "nucleus:default-agent-reasoning";
const DEFAULT_HARNESS_MODE_ENTRY_ID: &str = "nucleus:default-harness-mode";

type GeneralUnit = ConfigSettingsApplyUnit<DesktopPreferencesDomain, GeneralPreferencesAdapter>;
type AppearanceUnit =
    ConfigSettingsApplyUnit<DesktopPreferencesDomain, AppearancePreferencesAdapter>;
type AgentUnit = ConfigSettingsApplyUnit<DesktopPreferencesDomain, AgentPreferencesAdapter>;

pub fn install(app: &tauri::App, roots: StorageRoots) -> Result<(), String> {
    let authority = NucleusSettingsAuthority::new(roots)?;
    let service: Arc<dyn SettingsCommandService> =
        Arc::new(SettingsHandlerAssembly::new(authority));
    app.manage(NucleusSettingsState { service });
    Ok(())
}

pub(crate) struct NucleusSettingsState {
    service: Arc<dyn SettingsCommandService>,
}

#[tauri::command]
pub fn longhorn_settings_registry(
    webview: Webview,
    state: State<'_, NucleusSettingsState>,
) -> Result<SettingsRegistrySnapshot, SettingsHostError> {
    state.service.registry(webview.window().label())
}

#[tauri::command]
pub fn longhorn_settings_load(
    webview: Webview,
    state: State<'_, NucleusSettingsState>,
    command: SettingsLoadCommand,
) -> Result<SettingsLoadOutcome, SettingsHostError> {
    state.service.load(webview.window().label(), command)
}

#[tauri::command]
pub fn longhorn_settings_apply(
    webview: Webview,
    state: State<'_, NucleusSettingsState>,
    command: SettingsApplyCommand,
) -> Result<SettingsMutationResult, SettingsHostError> {
    let result = state.service.apply(webview.window().label(), command)?;
    publish_mutation_hint(&webview, &result);
    Ok(result)
}

#[tauri::command]
pub fn longhorn_settings_reset(
    webview: Webview,
    state: State<'_, NucleusSettingsState>,
    command: SettingsResetCommand,
) -> Result<SettingsMutationResult, SettingsHostError> {
    let result = state.service.reset(webview.window().label(), command)?;
    publish_mutation_hint(&webview, &result);
    Ok(result)
}

fn publish_mutation_hint(webview: &Webview, result: &SettingsMutationResult) {
    for event in mutation_change_events(result) {
        let _ = webview.emit(SETTINGS_SCOPE_CHANGED_EVENT, event);
    }
}

fn mutation_change_events(result: &SettingsMutationResult) -> Vec<SettingsScopeChangedEvent> {
    let Some(event) = mutation_changed_event(result) else {
        return Vec::new();
    };
    [GENERAL_SCOPE_ID, APPEARANCE_SCOPE_ID, AGENT_SCOPE_ID]
        .into_iter()
        .map(|scope| SettingsScopeChangedEvent {
            protocol_version: event.protocol_version,
            registry_generation: event.registry_generation,
            scope_id: scope_id(scope),
            scope_revision: event.scope_revision,
        })
        .collect()
}

struct NucleusSettingsAuthority {
    registry: SettingsRegistrySnapshot,
    store: ConfigStore,
    general: GeneralUnit,
    appearance: AppearanceUnit,
    agent: AgentUnit,
    options: MutationOptions,
}

impl NucleusSettingsAuthority {
    fn new(roots: StorageRoots) -> Result<Self, String> {
        let registry = build_registry()?;
        let domain = DesktopPreferencesDomain::new()?;
        let general = ConfigSettingsApplyUnit::new(
            &registry,
            &apply_unit_id(GENERAL_UNIT_ID),
            domain.clone(),
            GeneralPreferencesAdapter,
        )
        .map_err(|error| format!("bind general settings failed: {error}"))?;
        let appearance = ConfigSettingsApplyUnit::new(
            &registry,
            &apply_unit_id(APPEARANCE_UNIT_ID),
            domain.clone(),
            AppearancePreferencesAdapter,
        )
        .map_err(|error| format!("bind appearance settings failed: {error}"))?;
        let agent = ConfigSettingsApplyUnit::new(
            &registry,
            &apply_unit_id(AGENT_UNIT_ID),
            domain.clone(),
            AgentPreferencesAdapter,
        )
        .map_err(|error| format!("bind agent settings failed: {error}"))?;
        let coordination = CoordinationAuthority::new(roots.data())
            .map_err(|error| format!("settings coordination failed: {error}"))?;
        let mut store = ConfigStore::new(roots, coordination);
        store
            .register(&domain)
            .map_err(|error| format!("register desktop settings domain failed: {error}"))?;
        Ok(Self {
            registry: SettingsRegistrySnapshot::from(&registry),
            store,
            general,
            appearance,
            agent,
            options: MutationOptions::new(LOCK_TIMEOUT, DurabilityRequirement::Durable),
        })
    }

    fn authorize(caller: &str) -> Result<(), SettingsHostError> {
        if caller == "main" {
            Ok(())
        } else {
            Err(SettingsHostError::authority(
                "settings caller is not authorized",
                false,
            ))
        }
    }

    fn operational(error: impl std::fmt::Display) -> SettingsHostError {
        SettingsHostError::authority(error.to_string(), true)
    }
}

impl SettingsAuthority for NucleusSettingsAuthority {
    fn registry(&mut self, caller: &str) -> Result<SettingsRegistrySnapshot, SettingsHostError> {
        Self::authorize(caller)?;
        Ok(self.registry.clone())
    }

    fn load(
        &mut self,
        caller: &str,
        command: SettingsLoadCommand,
    ) -> Result<SettingsLoadOutcome, SettingsHostError> {
        Self::authorize(caller)?;
        match command.scope_id.as_str() {
            GENERAL_SCOPE_ID => self.general.load(&self.store, &command, LOCK_TIMEOUT),
            APPEARANCE_SCOPE_ID => self.appearance.load(&self.store, &command, LOCK_TIMEOUT),
            AGENT_SCOPE_ID => self.agent.load(&self.store, &command, LOCK_TIMEOUT),
            _ => {
                return Ok(SettingsLoadOutcome::Rejected {
                    rejection: rejection(SettingsRejectionCode::RegistryChanged),
                });
            }
        }
        .map_err(Self::operational)
    }

    fn apply(
        &mut self,
        caller: &str,
        command: SettingsApplyCommand,
    ) -> Result<SettingsMutationResult, SettingsHostError> {
        Self::authorize(caller)?;
        match command.apply_unit_id.as_str() {
            GENERAL_UNIT_ID => self.general.apply(&self.store, &command, self.options),
            APPEARANCE_UNIT_ID => self.appearance.apply(&self.store, &command, self.options),
            AGENT_UNIT_ID => self.agent.apply(&self.store, &command, self.options),
            _ => return Ok(rejected_mutation(SettingsRejectionCode::RegistryChanged)),
        }
        .map_err(Self::operational)
    }

    fn reset(
        &mut self,
        caller: &str,
        command: SettingsResetCommand,
    ) -> Result<SettingsMutationResult, SettingsHostError> {
        Self::authorize(caller)?;
        match command.apply_unit_id.as_str() {
            GENERAL_UNIT_ID => self.general.reset(&self.store, &command, self.options),
            APPEARANCE_UNIT_ID => self.appearance.reset(&self.store, &command, self.options),
            AGENT_UNIT_ID => self.agent.reset(&self.store, &command, self.options),
            _ => return Ok(rejected_mutation(SettingsRejectionCode::RegistryChanged)),
        }
        .map_err(Self::operational)
    }
}

#[cfg(test)]
fn opaque(value: Value) -> SettingsOpaqueValue {
    SettingsOpaqueValue::new(1, value, longhorn_settings::SettingsLimits::default())
        .expect("bounded Nucleus settings value")
}

fn rejection(code: SettingsRejectionCode) -> SettingsRejection {
    SettingsRejection {
        code,
        diagnostic: None,
    }
}

fn rejected_mutation(code: SettingsRejectionCode) -> SettingsMutationResult {
    SettingsMutationResult::Rejected {
        rejection: rejection(code),
        snapshot: None,
    }
}

macro_rules! id {
    ($function:ident, $type:ty) => {
        fn $function(value: &str) -> $type {
            <$type>::new(value).expect("static Nucleus settings id")
        }
    };
}

id!(module_id, SettingsModuleId);
id!(section_id, SettingsSectionId);
id!(page_id, SettingsPageId);
id!(renderer_id, SettingsRendererId);
id!(scope_id, SettingsScopeId);
id!(apply_unit_id, SettingsApplyUnitId);
id!(capability_id, SettingsCapabilityId);
id!(entry_id, SettingsEntryId);

#[cfg(test)]
mod tests;
