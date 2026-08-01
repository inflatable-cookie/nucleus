use std::collections::BTreeMap;

use longhorn_config::{
    ConfigDomain, DomainDescriptor, DomainFilePath, DomainIssue, MigrationStep, StorageClass,
};
use longhorn_core::{DomainId, SchemaVersion};
use longhorn_display::KnownDisplayRegistry;
use longhorn_windowing::SavedWindowPlacement;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DOMAIN_ID: &str = "nucleus.window-placement";
pub const DOMAIN_FILE: &str = "window-placement.json";
const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct NucleusWindowState {
    #[serde(default)]
    pub known_displays: KnownDisplayRegistry,
    #[serde(default)]
    pub next_display_ordinal: u64,
    #[serde(default)]
    pub placements: BTreeMap<String, SavedWindowPlacement>,
}

pub struct NucleusWindowDomain {
    descriptor: DomainDescriptor,
}

impl NucleusWindowDomain {
    pub fn new() -> Result<Self, String> {
        let descriptor = DomainDescriptor::new(
            DomainId::new(DOMAIN_ID).map_err(|error| error.to_string())?,
            SchemaVersion::new(SCHEMA_VERSION).map_err(|error| error.to_string())?,
            StorageClass::MachineState,
            Some(DomainFilePath::new(DOMAIN_FILE).map_err(|error| error.to_string())?),
        )
        .map_err(|error| error.to_string())?;
        Ok(Self { descriptor })
    }
}

impl ConfigDomain for NucleusWindowDomain {
    type Value = NucleusWindowState;

    fn descriptor(&self) -> &DomainDescriptor {
        &self.descriptor
    }

    fn default_value(&self) -> Self::Value {
        NucleusWindowState::default()
    }

    fn decode(&self, value: Value) -> Result<Self::Value, DomainIssue> {
        serde_json::from_value(value).map_err(|error| {
            DomainIssue::new(
                "nucleus-window-placement-decode",
                format!("decode Nucleus window placement failed: {error}"),
            )
        })
    }

    fn encode(&self, value: &Self::Value) -> Result<Value, DomainIssue> {
        serde_json::to_value(value).map_err(|error| {
            DomainIssue::new(
                "nucleus-window-placement-encode",
                format!("encode Nucleus window placement failed: {error}"),
            )
        })
    }

    fn validate(&self, value: &Self::Value) -> Result<(), DomainIssue> {
        for (key, placement) in &value.placements {
            if key != placement.window_id().as_str() {
                return Err(DomainIssue::new(
                    "nucleus-window-placement-key-mismatch",
                    format!(
                        "placement key {key} does not match logical window {}",
                        placement.window_id()
                    ),
                ));
            }
        }
        Ok(())
    }

    fn validate_raw(
        &self,
        schema_version: SchemaVersion,
        value: &Value,
    ) -> Result<(), DomainIssue> {
        if schema_version.get() != SCHEMA_VERSION {
            return Err(DomainIssue::new(
                "nucleus-window-placement-schema",
                format!(
                    "unsupported Nucleus window placement schema {}",
                    schema_version.get()
                ),
            ));
        }
        let decoded = self.decode(value.clone())?;
        self.validate(&decoded)
    }

    fn migrate_one(
        &self,
        _from: SchemaVersion,
        _value: Value,
    ) -> Result<Option<MigrationStep>, DomainIssue> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use longhorn_config::ConfigDomain;
    use longhorn_core::{ScreenPoint, ScreenSize, WindowId, WindowPlacement};
    use longhorn_windowing::{SavedDisplayAssociation, SavedWindowPlacement};

    use super::{NucleusWindowDomain, NucleusWindowState};

    #[test]
    fn rejects_a_placement_stored_under_another_logical_id() {
        let domain = NucleusWindowDomain::new().unwrap();
        let mut value = NucleusWindowState::default();
        value.placements.insert(
            "window:other".to_owned(),
            SavedWindowPlacement::new(
                WindowId::new("window:primary").unwrap(),
                WindowPlacement::new(ScreenPoint::new(10, 20), ScreenSize::new(1280, 820)),
                false,
                SavedDisplayAssociation::unresolved(),
            ),
        );

        assert!(domain.validate(&value).is_err());
    }
}
