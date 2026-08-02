use std::fs;

use longhorn_config::StorageRoots;
use longhorn_core::SettingsRequestId;
use longhorn_settings::{SettingsLoadOutcome, SettingsProtocolVersion};
use tempfile::TempDir;

use super::super::*;

pub(super) struct Fixture {
    _temp: TempDir,
    pub(super) roots: StorageRoots,
}

impl Fixture {
    pub(super) fn new() -> Self {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        let roots = StorageRoots::new(
            root.join("config"),
            root.join("data"),
            root.join("state"),
            root.join("cache"),
            root.join("runtime"),
            root.join("log"),
            root.join("backup"),
        )
        .unwrap();
        for path in [
            roots.config(),
            roots.data(),
            roots.state(),
            roots.cache(),
            roots.runtime(),
            roots.log(),
            roots.backup(),
        ] {
            fs::create_dir_all(path).unwrap();
        }
        Self { _temp: temp, roots }
    }

    pub(super) fn authority(&self) -> NucleusSettingsAuthority {
        NucleusSettingsAuthority::new(self.roots.clone()).unwrap()
    }

    pub(super) fn load(
        &self,
        authority: &mut NucleusSettingsAuthority,
        scope: &str,
    ) -> longhorn_settings::SettingsScopeSnapshot {
        let outcome = authority
            .load(
                "main",
                SettingsLoadCommand {
                    protocol_version: SettingsProtocolVersion::CURRENT,
                    request_id: request_id(&format!("request:test:load-{scope}")),
                    registry_generation: GENERATION,
                    scope_id: scope_id(scope),
                    known_authority: None,
                },
            )
            .unwrap();
        let SettingsLoadOutcome::Loaded { snapshot } = outcome else {
            panic!("expected settings snapshot")
        };
        snapshot
    }
}

pub(super) fn request_id(value: &str) -> SettingsRequestId {
    SettingsRequestId::new(value).unwrap()
}
