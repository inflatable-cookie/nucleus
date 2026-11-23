use std::{
    marker::PhantomData,
    os::fd::OwnedFd,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use longhorn_config::{
    BackupApplication, BackupArchiveLimits, BackupOperationalRoot, CheckedMutationError,
    ConfigDomain, ConfigStore, CoordinationAuthority, DomainDescriptor, DomainFilePath,
    DomainIssue, DurabilityRequirement, LoadOutcome, LoadedOrigin, MigrationStep, MutationError,
    MutationOptions, Sha256Digest, StorageClass, list_operational_backups,
};
use longhorn_core::{DomainId, SchemaVersion};
use longhorn_storage_layout::{
    PlatformDirectoryFacts, ResolvedStorageLayout, RootKind, StorageIdentity,
    StorageLayoutOverrides, StorageLayoutRequest, StorageProfile, TargetPlatform,
    resolve_storage_layout,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::{DispatchSettings, Hosts, PinnedVolume, Profiles, Projects, StorageDirectory};

const APP_ID: &str = "com.inflatablecookie.nucleus-engine";
const MUTATION: MutationOptions =
    MutationOptions::new(Duration::from_secs(5), DurabilityRequirement::Durable);

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
    #[error("{0}")]
    InvalidSettings(String),
    #[error("the settings changed. Read them again before saving.")]
    SettingsConflict,
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
    pub retention: RetentionSettings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionSettings {
    pub keep_newest: u32,
    pub max_age_days: Option<u32>,
}

impl Default for RetentionSettings {
    fn default() -> Self {
        Self {
            keep_newest: 10,
            max_age_days: None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot<T> {
    pub value: T,
    pub revision: String,
    pub configured: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backups {
    pub root: PathBuf,
    pub complete: bool,
    pub issues: usize,
    pub verified: Vec<VerifiedBackup>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedBackup {
    pub id: String,
    pub created_at: String,
}

#[derive(Clone)]
pub struct SettingsFile {
    home: PathBuf,
    store: Arc<ConfigStore>,
}

impl SettingsFile {
    /// Open the settings domains in an explicitly selected, existing engine home.
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
        register::<EngineSettings>(&mut store)?;
        register::<Profiles>(&mut store)?;
        register::<DispatchSettings>(&mut store)?;
        register::<Projects>(&mut store)?;
        register::<Hosts>(&mut store)?;
        Ok(Self {
            home: home.into(),
            store: Arc::new(store),
        })
    }

    /// Read a validated domain without writing it or changing its source.
    ///
    /// # Errors
    /// Returns an error for a corrupt, future, or unreadable settings file.
    pub fn read<S: SettingsValue>(&self) -> Result<SettingsSnapshot<S>, StorageError> {
        match self
            .store
            .load(&SettingsDomain::<S>::new()?)
            .map_err(|_| StorageError::SettingsUnavailable)?
        {
            LoadOutcome::Ready(config) => {
                snapshot(config.value, config.origin != LoadedOrigin::Default)
            }
            LoadOutcome::Recovery(_) | LoadOutcome::Unavailable(_) => {
                Err(StorageError::SettingsUnavailable)
            }
        }
    }

    /// Compare a revision and apply a validated edit in one Longhorn transaction.
    ///
    /// # Errors
    /// Returns an error if the edit is stale, invalid, or cannot be published.
    pub fn edit<S: SettingsValue>(
        &self,
        revision: &str,
        edit: impl FnOnce(&mut S) -> Result<(), StorageError>,
    ) -> Result<(SettingsSnapshot<S>, bool), StorageError> {
        let roots = layout(&self.home, None)?;
        let root = match S::CLASS {
            StorageClass::UserConfig => roots.storage_roots().config(),
            StorageClass::MachineState => roots.storage_roots().state(),
            _ => return Err(StorageError::Layout),
        };
        let volume = self
            .load()?
            .work_volume
            .ok_or(StorageError::MissingVolume)?;
        let directory = volume.dir(root.to_path_buf())?;
        let outcome = self
            .store
            .mutate_checked(&SettingsDomain::<S>::new()?, MUTATION, |current| {
                let configured = current.origin() != LoadedOrigin::Default;
                if revision_for(current.value(), configured)? != revision {
                    return Err(StorageError::SettingsConflict);
                }
                let previous = revision_for(current.value(), true)?;
                edit(current.value_mut())?;
                current
                    .value()
                    .validate()
                    .map_err(|issue| StorageError::InvalidSettings(issue.message))?;
                if revision_for(current.value(), true)? != previous {
                    current.value().verify_for_save(self)?;
                    directory.ensure()?;
                }
                Ok(configured)
            })
            .map_err(|error| match error {
                CheckedMutationError::Check(error) => error,
                CheckedMutationError::Mutation(MutationError::Validation(issue)) => {
                    StorageError::InvalidSettings(issue.message)
                }
                CheckedMutationError::Mutation(error) => error.into(),
            })?;
        let (was_configured, value, publication) = outcome.into_parts();
        let changed = publication.is_some();
        Ok((snapshot(value, was_configured || changed)?, changed))
    }

    /// Read the storage settings. A missing domain uses the disabled default.
    ///
    /// # Errors
    /// Returns an error for a corrupt, future, or unreadable settings file.
    pub fn load(&self) -> Result<EngineSettings, StorageError> {
        Ok(self.read()?.value)
    }

    /// Publish the startup configuration after checking the pinned volume.
    ///
    /// # Errors
    /// Returns an error if placement cannot be verified or settings cannot be saved.
    pub fn save(&self, settings: &EngineSettings) -> Result<(), StorageError> {
        settings.verify_for_save(self)?;
        let roots = layout(&self.home, None)?;
        let volume = settings
            .work_volume
            .as_ref()
            .ok_or(StorageError::MissingVolume)?;
        volume
            .dir(roots.storage_roots().state().to_path_buf())?
            .ensure()?;
        self.store.mutate(
            &SettingsDomain::new()?,
            MUTATION,
            |value: &mut EngineSettings| {
                value.clone_from(settings);
                Ok(())
            },
        )?;
        Ok(())
    }

    /// Resolve the active storage paths for the enabled engine.
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

impl StorageError {
    /// Whether Longhorn replaced the file before reporting a durability error.
    #[must_use]
    pub fn may_have_published(&self) -> bool {
        matches!(self, Self::SettingsMutation(MutationError::Publication(failure)) if failure.published)
    }
}

fn revision_for<S: SettingsValue>(value: &S, configured: bool) -> Result<String, StorageError> {
    if !configured {
        return Ok("default".into());
    }
    let encoded = serde_json::to_vec(value).map_err(|_| StorageError::SettingsUnavailable)?;
    Ok(Sha256Digest::from_bytes(&encoded).as_str().into())
}

fn snapshot<S: SettingsValue>(
    value: S,
    configured: bool,
) -> Result<SettingsSnapshot<S>, StorageError> {
    Ok(SettingsSnapshot {
        revision: revision_for(&value, configured)?,
        value,
        configured,
    })
}

fn register<S: SettingsValue>(store: &mut ConfigStore) -> Result<(), StorageError> {
    store
        .register(&SettingsDomain::<S>::new()?)
        .map_err(|_| StorageError::Layout)
}

pub struct EngineStorage {
    database: StorageDirectory,
    work: StorageDirectory,
    scratch: StorageDirectory,
    backup: StorageDirectory,
    mount: OwnedFd,
}

impl EngineStorage {
    fn resolve(home: &Path, settings: &EngineSettings) -> Result<Self, StorageError> {
        let volume = settings
            .work_volume
            .as_ref()
            .ok_or(StorageError::MissingVolume)?;
        let mount = volume.open_mount()?;
        volume.dir(home.to_path_buf())?.verify_from_mount(&mount)?;
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
            backup: volume.dir(roots.backup().to_path_buf())?,
            mount,
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

    #[must_use]
    pub const fn backup(&self) -> &StorageDirectory {
        &self.backup
    }

    /// List Longhorn-verified config archives in the active pinned backup root.
    ///
    /// # Errors
    /// Returns an error if the backup root escapes or cannot be verified.
    pub fn backups(&self) -> Result<Backups, StorageError> {
        let mut response = Backups {
            root: self.backup.path().to_path_buf(),
            complete: true,
            issues: 0,
            verified: Vec::new(),
        };
        match self.backup.verify_from_mount(&self.mount) {
            Ok(()) => {}
            Err(StorageError::ConfinedDirectory(rustix::io::Errno::NOENT)) => return Ok(response),
            Err(error) => return Err(error),
        }
        let root =
            BackupOperationalRoot::new(response.root.clone()).map_err(|_| StorageError::Layout)?;
        let application = BackupApplication::new(APP_ID, env!("CARGO_PKG_VERSION"))
            .map_err(|_| StorageError::Layout)?;
        let listing =
            list_operational_backups(&root, &application, BackupArchiveLimits::default(), 128);
        response.complete = listing.is_complete();
        response.issues = listing.diagnostics().len();
        response.verified = listing
            .candidates()
            .iter()
            .map(|backup| VerifiedBackup {
                id: backup.archive_id().into(),
                created_at: backup.created_at().into(),
            })
            .collect();
        Ok(response)
    }
}

fn layout(home: &Path, work_root: Option<&Path>) -> Result<ResolvedStorageLayout, StorageError> {
    let platform = if cfg!(target_os = "macos") {
        TargetPlatform::MacOs
    } else {
        TargetPlatform::Linux
    };
    let identity = StorageIdentity::new(APP_ID).map_err(|_| StorageError::Layout)?;
    let work = work_root.map_or_else(|| home.join("work"), Path::to_path_buf);
    let request = StorageLayoutRequest::new(identity, PlatformDirectoryFacts::new(platform))
        .with_profile(StorageProfile::PortableV1)
        .with_portable_root(home)
        .with_overrides(StorageLayoutOverrides::new().with(RootKind::Workspace, work));
    resolve_storage_layout(&request).map_err(|_| StorageError::Layout)
}

/// Typed values managed by the isolated engine's Longhorn configuration.
pub trait SettingsValue: Default + Serialize + DeserializeOwned {
    const ID: &'static str;
    const FILE: &'static str;
    const CLASS: StorageClass;

    /// Check stored or submitted settings without consulting an adapter.
    ///
    /// # Errors
    /// Returns an issue if a setting cannot be used.
    fn validate(&self) -> Result<(), DomainIssue>;

    /// Verify machine-local placement when saving settings that name storage roots.
    ///
    /// # Errors
    /// Returns an error if the configured paths cannot stay on the pinned volume.
    fn verify_for_save(&self, _file: &SettingsFile) -> Result<(), StorageError> {
        Ok(())
    }
}

impl SettingsValue for EngineSettings {
    const ID: &'static str = "nucleus.engine.settings";
    const FILE: &'static str = "engine.json";
    const CLASS: StorageClass = StorageClass::MachineState;

    fn validate(&self) -> Result<(), DomainIssue> {
        use crate::settings_domains::check;
        check(
            !self.enabled || self.work_volume.is_some(),
            "volume",
            "the enabled engine needs a pinned work volume",
        )?;
        check(
            self.retention.keep_newest > 0 && self.retention.max_age_days != Some(0),
            "retention",
            "use a positive backup count and age",
        )
    }

    fn verify_for_save(&self, file: &SettingsFile) -> Result<(), StorageError> {
        let paths = EngineStorage::resolve(&file.home, self)?;
        for path in [&paths.database, &paths.work, &paths.scratch, &paths.backup] {
            match path.verify_from_mount(&paths.mount) {
                Ok(()) | Err(StorageError::ConfinedDirectory(rustix::io::Errno::NOENT)) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}

struct SettingsDomain<S>(DomainDescriptor, PhantomData<S>);

impl<S: SettingsValue> SettingsDomain<S> {
    fn new() -> Result<Self, StorageError> {
        let id = DomainId::new(S::ID).map_err(|_| StorageError::Layout)?;
        let version = SchemaVersion::new(1).map_err(|_| StorageError::Layout)?;
        let path = DomainFilePath::new(S::FILE).map_err(|_| StorageError::Layout)?;
        Ok(Self(
            DomainDescriptor::new(id, version, S::CLASS, Some(path))
                .map_err(|_| StorageError::Layout)?,
            PhantomData,
        ))
    }
}

impl<S: SettingsValue> ConfigDomain for SettingsDomain<S> {
    type Value = S;

    fn descriptor(&self) -> &DomainDescriptor {
        &self.0
    }

    fn default_value(&self) -> S {
        S::default()
    }

    fn decode(&self, value: Value) -> Result<S, DomainIssue> {
        serde_json::from_value(value)
            .map_err(|_| DomainIssue::new("decode", "invalid settings document"))
    }

    fn encode(&self, value: &S) -> Result<Value, DomainIssue> {
        serde_json::to_value(value)
            .map_err(|_| DomainIssue::new("encode", "settings could not be encoded"))
    }

    fn validate(&self, value: &S) -> Result<(), DomainIssue> {
        value.validate()
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
