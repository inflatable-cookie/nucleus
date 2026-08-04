use longhorn_core::SettingsEntryId;
use longhorn_settings::{
    SettingsEditability, SettingsEffectiveSource, SettingsLimits, SettingsMutationOutcome,
    SettingsMutationTiming, SettingsOpaqueValue, SettingsRejection, SettingsRejectionCode,
    SettingsValueProjection,
};
use longhorn_settings_config::{
    SettingsCommittedMutation, SettingsConfigAdapter, SettingsConfigProjection,
    SettingsConfigProjectionError,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::domain::DesktopPreferences;
use super::{
    entry_id, rejection, DEFAULT_HARNESS_MODE_ENTRY_ID, DEFAULT_MODEL_ENTRY_ID,
    DEFAULT_PROVIDER_ID_ENTRY_ID, DEFAULT_PROVIDER_INSTANCE_ENTRY_ID, DEFAULT_REASONING_ENTRY_ID,
    DENSITY_ENTRY_ID, FIXTURE_STATUS_ENTRY_ID,
};

pub(super) struct GeneralPreferencesAdapter;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct GeneralIntent {
    show_fixture_status: bool,
}

impl SettingsConfigAdapter<DesktopPreferences> for GeneralPreferencesAdapter {
    type Intent = GeneralIntent;

    fn project(
        &self,
        value: &DesktopPreferences,
    ) -> Result<SettingsConfigProjection, SettingsConfigProjectionError> {
        SettingsConfigProjection::new(
            vec![projection(
                FIXTURE_STATUS_ENTRY_ID,
                value.show_fixture_status.map(|value| json!(value)),
                json!(true),
            )],
            Vec::new(),
        )
    }

    fn decode_intent(
        &self,
        intent: &SettingsOpaqueValue,
    ) -> Result<Self::Intent, SettingsRejection> {
        decode_intent(intent)
    }

    fn targeted_entries(&self, _intent: &Self::Intent) -> Vec<SettingsEntryId> {
        vec![entry_id(FIXTURE_STATUS_ENTRY_ID)]
    }

    fn validate_intent(
        &self,
        _current: &DesktopPreferences,
        _intent: &Self::Intent,
        _projection: &SettingsConfigProjection,
    ) -> Result<(), SettingsRejection> {
        Ok(())
    }

    fn patch(
        &self,
        current: &mut DesktopPreferences,
        intent: &Self::Intent,
    ) -> Result<(), SettingsRejection> {
        current.show_fixture_status = Some(intent.show_fixture_status);
        Ok(())
    }

    fn reset(
        &self,
        current: &mut DesktopPreferences,
        entry_ids: &[SettingsEntryId],
    ) -> Result<(), SettingsRejection> {
        if entry_ids == [entry_id(FIXTURE_STATUS_ENTRY_ID)] {
            current.show_fixture_status = None;
            Ok(())
        } else {
            Err(rejection(SettingsRejectionCode::InvalidIntent))
        }
    }

    fn activation_after_commit(
        &self,
        _mutation: SettingsCommittedMutation<'_, Self::Intent>,
        _timing: SettingsMutationTiming,
        _outcome: SettingsMutationOutcome,
        _committed: &SettingsConfigProjection,
    ) -> Vec<longhorn_settings::SettingsActivationRequirement> {
        Vec::new()
    }
}

pub(super) struct AppearancePreferencesAdapter;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AppearanceIntent {
    density: String,
}

impl SettingsConfigAdapter<DesktopPreferences> for AppearancePreferencesAdapter {
    type Intent = AppearanceIntent;

    fn project(
        &self,
        value: &DesktopPreferences,
    ) -> Result<SettingsConfigProjection, SettingsConfigProjectionError> {
        SettingsConfigProjection::new(
            vec![projection(
                DENSITY_ENTRY_ID,
                value.density.as_ref().map(|value| json!(value)),
                json!("compact"),
            )],
            Vec::new(),
        )
    }

    fn decode_intent(
        &self,
        intent: &SettingsOpaqueValue,
    ) -> Result<Self::Intent, SettingsRejection> {
        decode_intent(intent)
    }

    fn targeted_entries(&self, _intent: &Self::Intent) -> Vec<SettingsEntryId> {
        vec![entry_id(DENSITY_ENTRY_ID)]
    }

    fn validate_intent(
        &self,
        _current: &DesktopPreferences,
        intent: &Self::Intent,
        _projection: &SettingsConfigProjection,
    ) -> Result<(), SettingsRejection> {
        if matches!(intent.density.as_str(), "compact" | "comfortable") {
            Ok(())
        } else {
            Err(rejection(SettingsRejectionCode::InvalidIntent))
        }
    }

    fn patch(
        &self,
        current: &mut DesktopPreferences,
        intent: &Self::Intent,
    ) -> Result<(), SettingsRejection> {
        current.density = Some(intent.density.clone());
        Ok(())
    }

    fn reset(
        &self,
        current: &mut DesktopPreferences,
        entry_ids: &[SettingsEntryId],
    ) -> Result<(), SettingsRejection> {
        if entry_ids == [entry_id(DENSITY_ENTRY_ID)] {
            current.density = None;
            Ok(())
        } else {
            Err(rejection(SettingsRejectionCode::InvalidIntent))
        }
    }

    fn activation_after_commit(
        &self,
        _mutation: SettingsCommittedMutation<'_, Self::Intent>,
        _timing: SettingsMutationTiming,
        _outcome: SettingsMutationOutcome,
        _committed: &SettingsConfigProjection,
    ) -> Vec<longhorn_settings::SettingsActivationRequirement> {
        Vec::new()
    }
}

pub(super) struct AgentPreferencesAdapter;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct AgentPreferencesIntent {
    default_provider_instance_id: String,
    default_provider_id: Option<String>,
    default_model: String,
    default_reasoning_effort: String,
    default_harness_mode: String,
}

impl SettingsConfigAdapter<DesktopPreferences> for AgentPreferencesAdapter {
    type Intent = AgentPreferencesIntent;

    fn project(
        &self,
        value: &DesktopPreferences,
    ) -> Result<SettingsConfigProjection, SettingsConfigProjectionError> {
        SettingsConfigProjection::new(
            vec![
                projection(
                    DEFAULT_PROVIDER_INSTANCE_ENTRY_ID,
                    value
                        .default_provider_instance_id
                        .as_ref()
                        .map(|value| json!(value)),
                    json!("codex:local-default"),
                ),
                projection(
                    DEFAULT_PROVIDER_ID_ENTRY_ID,
                    value.default_provider_id.as_ref().map(|value| json!(value)),
                    Value::Null,
                ),
                projection(
                    DEFAULT_MODEL_ENTRY_ID,
                    value.default_model.as_ref().map(|value| json!(value)),
                    json!("gpt-5.4-mini"),
                ),
                projection(
                    DEFAULT_REASONING_ENTRY_ID,
                    value
                        .default_reasoning_effort
                        .as_ref()
                        .map(|value| json!(value)),
                    json!("low"),
                ),
                projection(
                    DEFAULT_HARNESS_MODE_ENTRY_ID,
                    value
                        .default_harness_mode
                        .as_ref()
                        .map(|value| json!(value)),
                    json!("normal"),
                ),
            ],
            Vec::new(),
        )
    }

    fn decode_intent(
        &self,
        intent: &SettingsOpaqueValue,
    ) -> Result<Self::Intent, SettingsRejection> {
        decode_intent(intent)
    }

    fn targeted_entries(&self, _intent: &Self::Intent) -> Vec<SettingsEntryId> {
        agent_entry_ids()
    }

    fn validate_intent(
        &self,
        _current: &DesktopPreferences,
        intent: &Self::Intent,
        _projection: &SettingsConfigProjection,
    ) -> Result<(), SettingsRejection> {
        if valid_route_value(&intent.default_provider_instance_id)
            && intent
                .default_provider_id
                .as_deref()
                .is_none_or(valid_route_value)
            && valid_route_value(&intent.default_model)
            && valid_route_value(&intent.default_reasoning_effort)
            && matches!(intent.default_harness_mode.as_str(), "normal" | "plan")
        {
            Ok(())
        } else {
            Err(rejection(SettingsRejectionCode::InvalidIntent))
        }
    }

    fn patch(
        &self,
        current: &mut DesktopPreferences,
        intent: &Self::Intent,
    ) -> Result<(), SettingsRejection> {
        current.default_provider_instance_id = Some(intent.default_provider_instance_id.clone());
        current.default_provider_id = intent.default_provider_id.clone();
        current.default_model = Some(intent.default_model.clone());
        current.default_reasoning_effort = Some(intent.default_reasoning_effort.clone());
        current.default_harness_mode = Some(intent.default_harness_mode.clone());
        Ok(())
    }

    fn reset(
        &self,
        current: &mut DesktopPreferences,
        entry_ids: &[SettingsEntryId],
    ) -> Result<(), SettingsRejection> {
        if entry_ids.is_empty()
            || entry_ids
                .iter()
                .any(|entry_id| !agent_entry_ids().contains(entry_id))
        {
            return Err(rejection(SettingsRejectionCode::InvalidIntent));
        }
        if entry_ids.contains(&entry_id(DEFAULT_MODEL_ENTRY_ID)) {
            current.default_model = None;
        }
        if entry_ids.contains(&entry_id(DEFAULT_PROVIDER_INSTANCE_ENTRY_ID)) {
            current.default_provider_instance_id = None;
        }
        if entry_ids.contains(&entry_id(DEFAULT_PROVIDER_ID_ENTRY_ID)) {
            current.default_provider_id = None;
        }
        if entry_ids.contains(&entry_id(DEFAULT_REASONING_ENTRY_ID)) {
            current.default_reasoning_effort = None;
        }
        if entry_ids.contains(&entry_id(DEFAULT_HARNESS_MODE_ENTRY_ID)) {
            current.default_harness_mode = None;
        }
        Ok(())
    }

    fn activation_after_commit(
        &self,
        _mutation: SettingsCommittedMutation<'_, Self::Intent>,
        _timing: SettingsMutationTiming,
        _outcome: SettingsMutationOutcome,
        _committed: &SettingsConfigProjection,
    ) -> Vec<longhorn_settings::SettingsActivationRequirement> {
        Vec::new()
    }
}

fn agent_entry_ids() -> Vec<SettingsEntryId> {
    vec![
        entry_id(DEFAULT_PROVIDER_INSTANCE_ENTRY_ID),
        entry_id(DEFAULT_PROVIDER_ID_ENTRY_ID),
        entry_id(DEFAULT_MODEL_ENTRY_ID),
        entry_id(DEFAULT_REASONING_ENTRY_ID),
        entry_id(DEFAULT_HARNESS_MODE_ENTRY_ID),
    ]
}

fn valid_route_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '-' | '_' | '.' | ':' | '/' | '@')
        })
}

fn projection(
    id: &str,
    configured: Option<Value>,
    compiled_default: Value,
) -> SettingsValueProjection {
    SettingsValueProjection {
        entry_id: entry_id(id),
        configured: configured.clone().map(opaque),
        effective: opaque(
            configured
                .clone()
                .unwrap_or_else(|| compiled_default.clone()),
        ),
        compiled_default: opaque(compiled_default),
        effective_source: if configured.is_some() {
            SettingsEffectiveSource::UserConfiguration
        } else {
            SettingsEffectiveSource::CompiledDefault
        },
        policy: None,
        editability: SettingsEditability::Editable,
        source_diagnostics: Vec::new(),
    }
}

fn decode_intent<T: serde::de::DeserializeOwned>(
    intent: &SettingsOpaqueValue,
) -> Result<T, SettingsRejection> {
    if intent.codec_version() != 1 {
        return Err(rejection(SettingsRejectionCode::InvalidIntent));
    }
    serde_json::from_value(intent.value().clone())
        .map_err(|_| rejection(SettingsRejectionCode::InvalidIntent))
}

fn opaque(value: Value) -> SettingsOpaqueValue {
    SettingsOpaqueValue::new(1, value, SettingsLimits::default())
        .expect("bounded Nucleus settings value")
}
