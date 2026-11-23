use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use longhorn_config::{
    ConfigDomain, ConfigStore, CoordinationAuthority, DomainDescriptor, DomainFilePath,
    DomainIssue, DurabilityRequirement, LoadOutcome, MigrationStep, MutationOptions, StorageClass,
};
use longhorn_core::{DomainId, SchemaVersion};
use longhorn_storage_layout::{
    PlatformDirectoryFacts, ResolvedStorageLayout, RootKind, StorageIdentity,
    StorageLayoutOverrides, StorageLayoutRequest, StorageProfile, TargetPlatform,
    resolve_storage_layout,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{PinnedVolume, StorageDirectory};

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("the engine is disabled")]
    Disabled,
    #[error("select a pinned work volume before enabling engine storage")]
    MissingVolume,
    #[error("the pinned, writable work volume is unavailable")]
    VolumeUnavailable,
    #[error("the storage path is outside the pinned volume")]
    OutsideVolume,
    #[error("the engine storage layout is invalid")]
    Layout,
    #[error("the engine settings could not be loaded")]
    SettingsUnavailable,
    #[error("the engine settings could not be updated")]
    SettingsMutation(#[from] longhorn_config::MutationError),
    #[error("the engine storage directory could not be prepared")]
    Directory(#[from] std::io::Error),
    #[error("the engine storage directory could not be opened without following links")]
    ConfinedDirectory(#[from] rustix::io::Errno),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineSettings {
    pub enabled: bool,
    pub work_volume: Option<PinnedVolume>,
    pub work_root: Option<PathBuf>,
    pub scratch_root: Option<PathBuf>,
}

pub struct SettingsFile {
    home: PathBuf,
    store: ConfigStore,
    domain: SettingsDomain,
}

impl SettingsFile {
    /// Open the settings domain in an explicitly selected, existing engine home.
    /// Opening creates no engine directories.
    ///
    /// # Errors
    /// Returns an error if the home is missing, redirected, or the layout is invalid.
    pub fn open(home: &Path) -> Result<Self, StorageError> {
        if !home.is_absolute() || home.canonicalize()? != home || !home.is_dir() {
            return Err(StorageError::Layout);
        }
        let layout = layout(home, None)?;
        let coordination = CoordinationAuthority::new(home).map_err(|_| StorageError::Layout)?;
        let mut store = ConfigStore::new(layout.storage_roots().clone(), coordination);
        let domain = SettingsDomain::new()?;
        store.register(&domain).map_err(|_| StorageError::Layout)?;
        Ok(Self {
            home: home.into(),
            store,
            domain,
        })
    }

    /// Read the settings. A missing domain uses the disabled default.
    ///
    /// # Errors
    /// Returns an error for a corrupt, future, or unreadable settings file.
    pub fn load(&self) -> Result<EngineSettings, StorageError> {
        match self
            .store
            .load(&self.domain)
            .map_err(|_| StorageError::SettingsUnavailable)?
        {
            LoadOutcome::Ready(config) => Ok(config.value),
            LoadOutcome::Recovery(_) | LoadOutcome::Unavailable(_) => {
                Err(StorageError::SettingsUnavailable)
            }
        }
    }

    /// Publish settings through Longhorn after checking the pinned volume.
    ///
    /// # Errors
    /// Returns an error if placement cannot be verified or settings cannot be saved.
    pub fn save(&self, settings: &EngineSettings) -> Result<(), StorageError> {
        EngineStorage::resolve(&self.home, settings)?;
        let volume = settings
            .work_volume
            .as_ref()
            .ok_or(StorageError::MissingVolume)?;
        let state = layout(&self.home, None)?
            .storage_roots()
            .state()
            .to_path_buf();
        volume.dir(state)?.ensure()?;
        self.store.mutate(
            &self.domain,
            MutationOptions::new(Duration::from_secs(5), DurabilityRequirement::Durable),
            |value| {
                value.clone_from(settings);
                Ok(())
            },
        )?;
        Ok(())
    }

    /// Resolve database, work and scratch directories for the enabled engine.
    ///
    /// # Errors
    /// Returns an error if the engine is disabled or the pinned volume cannot be used.
    pub fn storage(&self) -> Result<EngineStorage, StorageError> {
        let settings = self.load()?;
        if !settings.enabled {
            return Err(StorageError::Disabled);
        }
        EngineStorage::resolve(&self.home, &settings)
    }
}

pub struct EngineStorage {
    database: StorageDirectory,
    work: StorageDirectory,
    scratch: StorageDirectory,
}

impl EngineStorage {
    fn resolve(home: &Path, settings: &EngineSettings) -> Result<Self, StorageError> {
        let volume = settings
            .work_volume
            .as_ref()
            .ok_or(StorageError::MissingVolume)?;
        volume.dir(home.to_path_buf())?.verify()?;
        let resolved = layout(home, settings.work_root.as_deref())?;
        let roots = resolved.storage_roots();
        let work = roots.workspace().ok_or(StorageError::Layout)?;
        let scratch = settings
            .scratch_root
            .clone()
            .unwrap_or_else(|| roots.runtime().join("scratch"));
        Ok(Self {
            database: volume.dir(resolved.durable_database_dir())?,
            work: volume.dir(work.to_path_buf())?,
            scratch: volume.dir(scratch)?,
        })
    }

    #[must_use]
    pub const fn database(&self) -> &StorageDirectory {
        &self.database
    }

    #[must_use]
    pub const fn work(&self) -> &StorageDirectory {
        &self.work
    }

    #[must_use]
    pub const fn scratch(&self) -> &StorageDirectory {
        &self.scratch
    }
}

fn layout(home: &Path, work_root: Option<&Path>) -> Result<ResolvedStorageLayout, StorageError> {
    let platform = if cfg!(target_os = "macos") {
        TargetPlatform::MacOs
    } else {
        TargetPlatform::Linux
    };
    let identity = StorageIdentity::new("com.inflatablecookie.nucleus-engine")
        .map_err(|_| StorageError::Layout)?;
    let work = work_root.map_or_else(|| home.join("work"), Path::to_path_buf);
    let request = StorageLayoutRequest::new(identity, PlatformDirectoryFacts::new(platform))
        .with_profile(StorageProfile::PortableV1)
        .with_portable_root(home)
        .with_overrides(StorageLayoutOverrides::new().with(RootKind::Workspace, work));
    resolve_storage_layout(&request).map_err(|_| StorageError::Layout)
}

struct SettingsDomain(DomainDescriptor);

impl SettingsDomain {
    fn new() -> Result<Self, StorageError> {
        let id = DomainId::new("nucleus.engine.settings").map_err(|_| StorageError::Layout)?;
        let version = SchemaVersion::new(1).map_err(|_| StorageError::Layout)?;
        let path = DomainFilePath::new("engine.json").map_err(|_| StorageError::Layout)?;
        Ok(Self(
            DomainDescriptor::new(id, version, StorageClass::MachineState, Some(path))
                .map_err(|_| StorageError::Layout)?,
        ))
    }
}

impl ConfigDomain for SettingsDomain {
    type Value = EngineSettings;

    fn descriptor(&self) -> &DomainDescriptor {
        &self.0
    }

    fn default_value(&self) -> EngineSettings {
        EngineSettings::default()
    }

    fn decode(&self, value: Value) -> Result<EngineSettings, DomainIssue> {
        serde_json::from_value(value).map_err(|error| DomainIssue::new("decode", error.to_string()))
    }

    fn encode(&self, value: &EngineSettings) -> Result<Value, DomainIssue> {
        serde_json::to_value(value).map_err(|error| DomainIssue::new("encode", error.to_string()))
    }

    fn validate(&self, value: &EngineSettings) -> Result<(), DomainIssue> {
        if value.enabled && value.work_volume.is_none() {
            return Err(DomainIssue::new(
                "volume",
                "the enabled engine needs a pinned work volume",
            ));
        }
        Ok(())
    }

    fn validate_raw(&self, _: SchemaVersion, value: &Value) -> Result<(), DomainIssue> {
        self.validate(&self.decode(value.clone())?)
    }

    fn migrate_one(
        &self,
        _: SchemaVersion,
        _: Value,
    ) -> Result<Option<MigrationStep>, DomainIssue> {
        Ok(None)
    }
}
