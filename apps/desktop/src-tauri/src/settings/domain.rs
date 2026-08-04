use longhorn_config::{
    ConfigDomain, DomainDescriptor, DomainFilePath, DomainIssue, MigrationStep, StorageClass,
};
use longhorn_core::{DomainId, SchemaVersion};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct DesktopPreferences {
    pub(super) show_fixture_status: Option<bool>,
    pub(super) density: Option<String>,
    pub(super) default_provider_instance_id: Option<String>,
    pub(super) default_provider_id: Option<String>,
    pub(super) default_model: Option<String>,
    pub(super) default_reasoning_effort: Option<String>,
    pub(super) default_harness_mode: Option<String>,
}

#[derive(Clone)]
pub(super) struct DesktopPreferencesDomain {
    descriptor: DomainDescriptor,
}

impl DesktopPreferencesDomain {
    pub(super) fn new() -> Result<Self, String> {
        Ok(Self {
            descriptor: DomainDescriptor::new(
                DomainId::new("nucleus.desktop-preferences").map_err(|error| error.to_string())?,
                SchemaVersion::new(1).map_err(|error| error.to_string())?,
                StorageClass::UserConfig,
                Some(
                    DomainFilePath::new("preferences/nucleus.json")
                        .map_err(|error| error.to_string())?,
                ),
            )
            .map_err(|error| error.to_string())?,
        })
    }
}

impl ConfigDomain for DesktopPreferencesDomain {
    type Value = DesktopPreferences;

    fn descriptor(&self) -> &DomainDescriptor {
        &self.descriptor
    }

    fn default_value(&self) -> Self::Value {
        DesktopPreferences::default()
    }

    fn decode(&self, value: Value) -> Result<Self::Value, DomainIssue> {
        serde_json::from_value(value)
            .map_err(|error| DomainIssue::new("desktop-preferences-decode", error.to_string()))
    }

    fn encode(&self, value: &Self::Value) -> Result<Value, DomainIssue> {
        serde_json::to_value(value)
            .map_err(|error| DomainIssue::new("desktop-preferences-encode", error.to_string()))
    }

    fn validate(&self, value: &Self::Value) -> Result<(), DomainIssue> {
        if value
            .density
            .as_deref()
            .is_some_and(|density| !matches!(density, "compact" | "comfortable"))
        {
            return Err(DomainIssue::new(
                "desktop-preferences-density",
                "density must be compact or comfortable",
            ));
        }
        for (label, route_value) in [
            (
                "default provider instance",
                value.default_provider_instance_id.as_deref(),
            ),
            (
                "default model provider",
                value.default_provider_id.as_deref(),
            ),
            ("default model", value.default_model.as_deref()),
            (
                "default reasoning effort",
                value.default_reasoning_effort.as_deref(),
            ),
        ] {
            if route_value.is_some_and(|candidate| !valid_route_value(candidate)) {
                return Err(DomainIssue::new(
                    "desktop-preferences-agent-route",
                    format!("{label} must be a bounded provider route value"),
                ));
            }
        }
        if value
            .default_harness_mode
            .as_deref()
            .is_some_and(|mode| !matches!(mode, "normal" | "plan"))
        {
            return Err(DomainIssue::new(
                "desktop-preferences-harness-mode",
                "default harness mode must be normal or plan",
            ));
        }
        Ok(())
    }

    fn validate_raw(
        &self,
        schema_version: SchemaVersion,
        value: &Value,
    ) -> Result<(), DomainIssue> {
        if schema_version != self.descriptor.schema_version() {
            return Err(DomainIssue::new(
                "desktop-preferences-schema",
                "unsupported settings schema version",
            ));
        }
        self.validate(&self.decode(value.clone())?)
    }

    fn migrate_one(
        &self,
        _from: SchemaVersion,
        _value: Value,
    ) -> Result<Option<MigrationStep>, DomainIssue> {
        Ok(None)
    }
}

fn valid_route_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '-' | '_' | '.' | ':' | '/' | '@')
        })
}
