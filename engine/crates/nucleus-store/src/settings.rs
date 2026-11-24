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
    PlatformDirectoryFact, PlatformDirectoryFacts, ResolvedStorageLayout, RootKind,
    StorageIdentity, StorageLayoutOverrides, StorageLayoutRequest, StorageProfile, TargetPlatform,
    native_platform_directory_facts, resolve_storage_layout,
};
use rustix::fs::{FlockOperation, Mode, OFlags, flock, open};
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
    #[error("the pinned work volume is not mounted")]
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
    #[error("an isolated engine is already serving this profile or its lock is unreadable")]
    ProfileLock,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineSettings {
    pub enabled: bool,
    pub work_volume: Option<PinnedVolume>,
    pub work_root: Option<PathBuf>,
    pub scratch_root: Option<PathBuf>,
    pub log_root: Option<PathBuf>,
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
    layout: ResolvedStorageLayout,
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
        Self::with_layout(portable_layout(home)?, home)
    }

    /// Open the platform-native engine profile using Longhorn's directory facts.
    ///
    /// # Errors
    /// Returns an error for missing platform facts or inaccessible directories.
    pub fn open_default() -> Result<Self, StorageError> {
        Self::open_native(native_platform_directory_facts().map_err(|_| StorageError::Layout)?)
    }

    fn open_native(facts: PlatformDirectoryFacts) -> Result<Self, StorageError> {
        let runtime = facts
            .get(PlatformDirectoryFact::Cache)
            .ok_or(StorageError::Layout)?
            .join(APP_ID)
            .join("runtime");
        let layout = resolve_storage_layout(
            &StorageLayoutRequest::new(identity()?, facts)
                .with_profile(StorageProfile::PlatformNativeV1)
                .with_overrides(StorageLayoutOverrides::new().with(RootKind::Runtime, runtime)),
        )
        .map_err(|_| StorageError::Layout)?;
        let coordination = layout.storage_roots().state().to_path_buf();
        StorageDirectory::native(coordination.clone())?.ensure()?;
        Self::with_layout(layout, &coordination)
    }

    fn with_layout(layout: ResolvedStorageLayout, base: &Path) -> Result<Self, StorageError> {
        let coordination = CoordinationAuthority::new(base).map_err(|_| StorageError::Layout)?;
        let mut store = ConfigStore::new(layout.storage_roots().clone(), coordination);
        register::<EngineSettings>(&mut store)?;
        register::<Profiles>(&mut store)?;
        register::<DispatchSettings>(&mut store)?;
        register::<Projects>(&mut store)?;
        register::<Hosts>(&mut store)?;
        Ok(Self {
            layout,
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
        let root = match S::CLASS {
            StorageClass::UserConfig => self.layout.storage_roots().config(),
            StorageClass::MachineState => self.layout.storage_roots().state(),
            _ => return Err(StorageError::Layout),
        };
        let config = self.load()?;
        let scratch = scratch_path(&self.layout, &config);
        let directory = storage_dir(config.work_volume.as_ref(), root.to_path_buf(), &scratch)?;
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

    /// Resolve a new volume pin, with filesystem probe temp confined to scratch.
    /// # Errors
    /// Returns an error if the selected volume cannot be identified.
    pub fn identify_volume(
        &self,
        path: &Path,
        settings: &EngineSettings,
    ) -> Result<PinnedVolume, StorageError> {
        PinnedVolume::detect_using(path, Some(&scratch_path(&self.layout, settings)))
    }

    /// Publish the startup configuration after checking the pinned volume.
    ///
    /// # Errors
    /// Returns an error if placement cannot be verified or settings cannot be saved.
    pub fn save(&self, settings: &EngineSettings) -> Result<(), StorageError> {
        settings.verify_for_save(self)?;
        storage_dir(
            settings.work_volume.as_ref(),
            self.layout.storage_roots().state().to_path_buf(),
            &scratch_path(&self.layout, settings),
        )?
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
        EngineStorage::resolve(&self.layout, &settings)
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
    log: StorageDirectory,
    mount: Option<OwnedFd>,
}

impl EngineStorage {
    fn resolve(
        resolved: &ResolvedStorageLayout,
        settings: &EngineSettings,
    ) -> Result<Self, StorageError> {
        let volume = settings.work_volume.as_ref();
        let roots = resolved.storage_roots();
        let work = settings
            .work_root
            .clone()
            .or_else(|| roots.workspace().map(Path::to_path_buf))
            .unwrap_or_else(|| roots.state().join("work"));
        let scratch = scratch_path(resolved, settings);
        let directory = |path| storage_dir(volume, path, &scratch);
        let scratch_dir = directory(scratch.clone())?;
        let mount = volume
            .map(|volume| volume.open_mount(Some(&scratch)))
            .transpose()?;
        let log = settings
            .log_root
            .clone()
            .unwrap_or_else(|| roots.log().to_path_buf());
        let storage = Self {
            database: directory(resolved.durable_database_dir())?,
            work: directory(work)?,
            scratch: scratch_dir,
            backup: directory(roots.backup().to_path_buf())?,
            log: directory(log)?,
            mount,
        };
        for root in [
            roots.config(),
            roots.data(),
            roots.state(),
            roots.cache(),
            roots.runtime(),
        ] {
            storage.verify_optional(&directory(root.to_path_buf())?)?;
        }
        for path in [
            &storage.database,
            &storage.work,
            &storage.scratch,
            &storage.backup,
            &storage.log,
        ] {
            storage.verify_optional(path)?;
        }
        Ok(storage)
    }

    fn verify(&self, directory: &StorageDirectory) -> Result<(), StorageError> {
        match &self.mount {
            Some(mount) => directory.verify_from_mount(mount),
            None => directory.verify(),
        }
    }

    fn verify_optional(&self, directory: &StorageDirectory) -> Result<(), StorageError> {
        match self.verify(directory) {
            Ok(()) | Err(StorageError::ConfinedDirectory(rustix::io::Errno::NOENT)) => Ok(()),
            Err(error) => Err(error),
        }
    }

    #[must_use]
    pub const fn database(&self) -> &StorageDirectory {
        &self.database
    }

    /// Claim the same exclusive profile lock used by the running service.
    ///
    /// # Errors
    /// Returns an error if the profile directory or its lock is unavailable.
    pub fn lock_profile(&self) -> Result<OwnedFd, StorageError> {
        self.database.ensure()?;
        let lock = open(
            self.database.path().join("service.lock"),
            OFlags::RDWR | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        )
        .map_err(|_| StorageError::ProfileLock)?;
        flock(&lock, FlockOperation::NonBlockingLockExclusive)
            .map_err(|_| StorageError::ProfileLock)?;
        Ok(lock)
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

    #[must_use]
    pub const fn log(&self) -> &StorageDirectory {
        &self.log
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
        match self.verify(&self.backup) {
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

fn identity() -> Result<StorageIdentity, StorageError> {
    StorageIdentity::new(APP_ID).map_err(|_| StorageError::Layout)
}

fn storage_dir(
    volume: Option<&PinnedVolume>,
    path: PathBuf,
    scratch: &Path,
) -> Result<StorageDirectory, StorageError> {
    match volume {
        Some(volume) => volume.dir(path, scratch),
        None => StorageDirectory::native(path),
    }
}

fn scratch_path(layout: &ResolvedStorageLayout, settings: &EngineSettings) -> PathBuf {
    settings
        .scratch_root
        .clone()
        .unwrap_or_else(|| layout.storage_roots().runtime().join("scratch"))
}

fn portable_layout(home: &Path) -> Result<ResolvedStorageLayout, StorageError> {
    let platform = if cfg!(target_os = "macos") {
        TargetPlatform::MacOs
    } else {
        TargetPlatform::Linux
    };
    let request = StorageLayoutRequest::new(identity()?, PlatformDirectoryFacts::new(platform))
        .with_profile(StorageProfile::PortableV1)
        .with_portable_root(home)
        .with_overrides(StorageLayoutOverrides::new().with(RootKind::Workspace, home.join("work")));
    resolve_storage_layout(&request).map_err(|_| StorageError::Layout)
}

/// Typed values managed by the isolated engine's Longhorn configuration.
pub trait SettingsValue: Default + Serialize + DeserializeOwned {
    const ID: &'static str;
    const FILE: &'static str;
    const CLASS: StorageClass;
    /// Obsolete keys accepted only when reading previously stored documents.
    const RETIRED_KEYS: &'static [&'static str] = &[];

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
            self.retention.keep_newest > 0 && self.retention.max_age_days != Some(0),
            "retention",
            "use a positive backup count and age",
        )
    }

    fn verify_for_save(&self, file: &SettingsFile) -> Result<(), StorageError> {
        EngineStorage::resolve(&file.layout, self).map(|_| ())
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

    fn decode(&self, mut value: Value) -> Result<S, DomainIssue> {
        if let Some(fields) = value.as_object_mut() {
            for key in S::RETIRED_KEYS {
                fields.remove(*key);
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_dispatch_domain_discards_the_retired_load_key() {
        let temporary = tempfile::tempdir().expect("fixture home");
        let home = temporary.path().canonicalize().expect("canonical home");
        let config = home.join("config");
        std::fs::create_dir(&config).expect("config directory");
        let document = serde_json::json!({
            "domain": DispatchSettings::ID,
            "schemaVersion": 1,
            "value": {
                "usage": "normal",
                "slots": 3,
                "maxLoad": 18.0,
                "hostConcurrency": 1,
                "allowanceMinutes": 30,
            }
        });
        std::fs::write(config.join(DispatchSettings::FILE), document.to_string())
            .expect("old dispatch settings");
        let file = SettingsFile::open(&home).expect("settings");
        let saved = file
            .read::<DispatchSettings>()
            .expect("decode legacy settings");
        assert!(saved.configured);
        assert_eq!(saved.value.slots, 3);
        assert_eq!(saved.value.allowance_minutes, Some(30));
        assert!(
            serde_json::to_value(saved.value)
                .expect("current settings")
                .get("maxLoad")
                .is_none()
        );
    }

    #[test]
    fn a_missing_pinned_volume_never_creates_startup_roots() {
        let temporary = tempfile::tempdir().expect("fixture home");
        let mount = temporary.path().join("unmounted");
        let home = mount.join("engine-home");
        let settings = EngineSettings {
            enabled: true,
            work_volume: Some(PinnedVolume {
                mount: mount.clone(),
                volume_id: "absent".into(),
            }),
            ..EngineSettings::default()
        };
        assert!(matches!(
            EngineStorage::resolve(&portable_layout(&home).expect("layout"), &settings),
            Err(StorageError::MissingVolume)
        ));
        assert!(!mount.exists());
    }

    #[test]
    fn native_profile_can_open_without_a_volume_or_runtime_environment() {
        let temporary = tempfile::tempdir().expect("fixture home");
        let root = temporary.path().canonicalize().expect("canonical home");
        for platform in [TargetPlatform::MacOs, TargetPlatform::Linux] {
            let facts = PlatformDirectoryFacts::new(platform)
                .with(PlatformDirectoryFact::Config, root.join("config"))
                .with(PlatformDirectoryFact::Data, root.join("data"))
                .with(PlatformDirectoryFact::State, root.join("state"))
                .with(PlatformDirectoryFact::Cache, root.join("cache"))
                .with(PlatformDirectoryFact::Log, root.join("log"));
            let settings = SettingsFile::open_native(facts).expect("platform roots");
            settings
                .save(&EngineSettings {
                    enabled: true,
                    ..EngineSettings::default()
                })
                .expect("enable without a pin");
            let storage = settings.storage().expect("no volume is required");
            assert!(storage.scratch().path().starts_with(root.join("cache")));
            assert!(storage.work().path().starts_with(root.join("state")));
            assert!(storage.log().path().starts_with(root.join("log")));
            assert!(storage.database().path().starts_with(root.join("data")));
            crate::Store::open(&storage).expect("open native database");
        }
    }
}
