use std::{
    cell::RefCell,
    collections::BTreeSet,
    error::Error,
    marker::PhantomData,
    os::fd::OwnedFd,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use longhorn_config::{
    BackupApplication, BackupArchiveFileName, BackupArchiveLimits, BackupCaptureOptions,
    BackupCatalog, BackupKind, BackupMetadata, BackupOperationalRoot, BackupProducer,
    CheckedMutationError, ConfigDomain, ConfigStore, CoordinationAuthority, DomainDescriptor,
    DomainFilePath, DomainIssue, DurabilityRequirement, LoadOutcome, LoadedConfig, LoadedOrigin,
    MigrationRewriteError, MigrationRewriteOptions, MigrationStep, MutationError, MutationOptions,
    RestoreOperationState, RestoreRecoveryOptions, RestoreSafetyBackupOptions, Sha256Digest,
    StorageClass, list_operational_backups,
};
use longhorn_core::{DomainId, SchemaVersion};
use longhorn_storage_layout::{
    PlatformDirectoryFact, PlatformDirectoryFacts, ResolvedStorageLayout, RootKind,
    StorageIdentity, StorageLayoutOverrides, StorageLayoutRequest, StorageProfile, TargetPlatform,
    native_platform_directory_facts, resolve_storage_layout,
};
use nucleus_core::profiles::Slots;
use rustix::fs::{FlockOperation, Mode, OFlags, flock, open};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    DispatchSettings, GitHubAccountSettings, Hosts, PinnedVolume, Profiles, Projects,
    StorageDirectory,
};

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
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
    /// A write or removal which outlived its caller and holds its owner.
    #[error(
        "The work volume or layout cannot be verified: {step} has not returned after {}. This waits until it does. If it never does, restart the engine.",
        age(.since)
    )]
    CallHeld { step: &'static str, since: Instant },
    #[error("Barge could not place {class}: {reason}")]
    BargePlacement { class: &'static str, reason: String },
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
    #[error("{0}")]
    SettingsDocument(String),
    #[error("the engine settings could not be updated")]
    SettingsMutation(#[from] longhorn_config::MutationError),
    #[error("the engine storage directory could not be prepared")]
    Directory(#[from] std::io::Error),
    #[error("the engine storage directory could not be opened without following links")]
    ConfinedDirectory(#[from] rustix::io::Errno),
    #[error("an isolated engine is already serving this profile or its lock is unreadable")]
    ProfileLock,
}

fn age(since: &Instant) -> String {
    let seconds = since.elapsed().as_secs();
    if seconds < 120 {
        format!("{seconds} seconds")
    } else {
        format!("{} minutes", seconds / 60)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineSettings {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_volume: Option<PinnedVolume>,
    #[serde(skip_serializing_if = "StoragePlacement::is_internal")]
    pub placement: StoragePlacement,
    pub work_root: Option<PathBuf>,
    pub scratch_root: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub builds_root: Option<PathBuf>,
    pub log_root: Option<PathBuf>,
    pub retention: RetentionSettings,
}

/// Selects the defaults for expendable engine storage.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoragePlacement {
    #[default]
    Internal,
    Barge,
}

impl StoragePlacement {
    #[expect(
        clippy::trivially_copy_pass_by_ref,
        reason = "Serde passes skip predicates a reference"
    )]
    fn is_internal(&self) -> bool {
        *self == Self::Internal
    }
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
    layout: ResolvedStorageLayout,
    store: Arc<ConfigStore>,
}

impl SettingsFile {
    /// The canonical home identifying this engine profile.
    #[must_use]
    pub fn home(&self) -> &Path {
        &self.home
    }

    /// Open the settings domains in an explicitly selected, existing engine home.
    /// Opening validates the domains and publishes any required schema upgrades.
    ///
    /// # Errors
    /// Returns an error if the home, layout, or settings cannot be verified.
    pub fn open(home: &Path) -> Result<Self, StorageError> {
        if !home.is_absolute() || home.canonicalize()? != home || !home.is_dir() {
            return Err(StorageError::Layout);
        }
        if default_home().is_ok_and(|default| default == home) {
            return Self::open_default();
        }
        Self::with_layout(portable_layout(home)?, home)
    }

    /// Open the internal transition home, with platform defaults for expendable files.
    ///
    /// # Errors
    /// Returns an error if the directories or settings cannot be verified.
    pub fn open_default() -> Result<Self, StorageError> {
        Self::open_account(
            &default_home()?,
            native_platform_directory_facts().map_err(|_| StorageError::Layout)?,
        )
    }

    fn open_account(home: &Path, facts: PlatformDirectoryFacts) -> Result<Self, StorageError> {
        let cache = facts
            .get(PlatformDirectoryFact::Cache)
            .ok_or(StorageError::Layout)?
            .join(APP_ID);
        let work = facts
            .get(PlatformDirectoryFact::State)
            .ok_or(StorageError::Layout)?
            .join(APP_ID)
            .join("workspaces");
        let layout = resolve_storage_layout(
            &StorageLayoutRequest::new(identity()?, facts)
                .with_profile(StorageProfile::PortableV1)
                .with_portable_root(home)
                .with_overrides(
                    StorageLayoutOverrides::new()
                        .with(RootKind::Workspace, work)
                        .with(RootKind::Runtime, cache.join("runtime"))
                        .with(RootKind::Cache, cache),
                ),
        )
        .map_err(|_| StorageError::Layout)?;
        StorageDirectory::native(home.to_path_buf())?.ensure()?;
        Self::with_layout(layout, home)
    }

    fn with_layout(layout: ResolvedStorageLayout, base: &Path) -> Result<Self, StorageError> {
        let coordination = CoordinationAuthority::new(base).map_err(|_| StorageError::Layout)?;
        let mut store = ConfigStore::new(layout.storage_roots().clone(), coordination);
        let engine = register::<EngineSettings>(&mut store)?;
        let profiles = register::<Profiles>(&mut store)?;
        let dispatch = register::<DispatchSettings>(&mut store)?;
        let projects = register::<Projects>(&mut store)?;
        let hosts = register::<Hosts>(&mut store)?;
        let github = register::<GitHubAccountSettings>(&mut store)?;
        if store.restore_operation_state() != RestoreOperationState::Inactive {
            store
                .recover_restore(RestoreRecoveryOptions::new(MUTATION.lock_timeout))
                .map_err(|error| StorageError::InvalidSettings(error.to_string()))?;
        }
        let backup = layout.storage_roots().backup();
        engine.upgrade(&store, backup)?;
        profiles.upgrade(&store, backup)?;
        dispatch.upgrade(&store, backup)?;
        projects.upgrade(&store, backup)?;
        hosts.upgrade(&store, backup)?;
        github.upgrade(&store, backup)?;
        Ok(Self {
            home: base.to_path_buf(),
            layout,
            store: Arc::new(store),
        })
    }

    /// Read a validated domain without writing it or changing its source.
    ///
    /// # Errors
    /// Returns an error for a corrupt, future, or unreadable settings file.
    pub fn read<S: SettingsValue>(&self) -> Result<SettingsSnapshot<S>, StorageError> {
        let config = SettingsDomain::<S>::new()?.load(&self.store)?;
        snapshot(config.value, config.origin != LoadedOrigin::Default)
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
        self.edit_in(revision, &directory, edit)
    }

    fn edit_in<S: SettingsValue>(
        &self,
        revision: &str,
        directory: &StorageDirectory,
        edit: impl FnOnce(&mut S) -> Result<(), StorageError>,
    ) -> Result<(SettingsSnapshot<S>, bool), StorageError> {
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

    /// Apply startup flags at the revision read by the CLI. An offline profile move
    /// verifies the destination using the proposed roots and volume pin.
    ///
    /// # Errors
    /// Returns an error if the proposal is stale or its storage cannot be verified.
    pub fn configure(
        &self,
        snapshot: &SettingsSnapshot<EngineSettings>,
        patch: impl Fn(&mut EngineSettings),
    ) -> Result<(), StorageError> {
        let mut proposed = snapshot.value.clone();
        patch(&mut proposed);
        proposed.verify_for_save(self)?;
        let directory = storage_dir(
            proposed.work_volume.as_ref(),
            self.layout.storage_roots().state().to_owned(),
            &scratch_path(&self.layout, &proposed),
        )?;
        self.edit_in(&snapshot.revision, &directory, |current| {
            patch(current);
            Ok(())
        })?;
        Ok(())
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
        let settings = self.enabled_settings()?;
        EngineStorage::resolve(&self.layout, &self.home, &settings)
    }

    /// Claim the exclusive service lock on the durable profile before opening runtime roots.
    ///
    /// # Errors
    /// Returns an error if the engine is disabled or its durable directory or lock is unavailable.
    pub fn lock_profile(&self) -> Result<LockedProfile, StorageError> {
        let settings = self.enabled_settings()?;
        let database = storage_dir(
            settings.work_volume.as_ref(),
            self.layout.durable_database_dir(),
            &scratch_path(&self.layout, &settings),
        )?;
        database.ensure()?;
        let lock = open(
            database.path().join("service.lock"),
            OFlags::RDWR | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        )
        .map_err(|_| StorageError::ProfileLock)?;
        flock(&lock, FlockOperation::NonBlockingLockExclusive)
            .map_err(|_| StorageError::ProfileLock)?;
        Ok(LockedProfile {
            file: self.clone(),
            settings,
            lock: Arc::new(lock),
        })
    }

    fn enabled_settings(&self) -> Result<EngineSettings, StorageError> {
        let settings = self.load()?;
        if !settings.enabled {
            return Err(StorageError::Disabled);
        }
        Ok(settings)
    }

    /// Resolve configured roots for status, including when the engine is disabled.
    /// # Errors
    /// Returns an error if settings or the pinned volume cannot be verified.
    pub fn configured_storage(&self) -> Result<EngineStorage, StorageError> {
        EngineStorage::resolve(&self.layout, &self.home, &self.load()?)
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

fn register<S: SettingsValue>(store: &mut ConfigStore) -> Result<SettingsDomain<S>, StorageError> {
    let mut domain = SettingsDomain::new()?;
    domain.retired_keys = Some(RefCell::default());
    store.register(&domain).map_err(|_| StorageError::Layout)?;
    Ok(domain)
}

/// An enabled profile held exclusively while its service starts and runs.
pub struct LockedProfile {
    file: SettingsFile,
    settings: EngineSettings,
    lock: Arc<OwnedFd>,
}

impl LockedProfile {
    /// Keep the profile locked while handling an initialization failure or exit.
    #[must_use]
    pub fn retain_lock(&self) -> Arc<OwnedFd> {
        Arc::clone(&self.lock)
    }

    /// Resolve runtime storage from the same settings used to claim the service lock.
    ///
    /// # Errors
    /// Returns an error if the configured storage cannot be used.
    pub fn into_storage(self) -> Result<(SettingsFile, EngineStorage, Arc<OwnedFd>), StorageError> {
        let storage = EngineStorage::resolve(&self.file.layout, &self.file.home, &self.settings)?;
        Ok((self.file, storage, self.lock))
    }
}

pub struct EngineStorage {
    home: PathBuf,
    placement: StoragePlacement,
    barge_paths: BargePaths,
    bin: StorageDirectory,
    database: StorageDirectory,
    work: StorageDirectory,
    scratch: StorageDirectory,
    builds: StorageDirectory,
    backup: StorageDirectory,
    log: StorageDirectory,
    mount: Option<OwnedFd>,
}

/// Class paths used by the running engine. Explicit overrides bypass their class.
#[derive(Debug, Default, Serialize)]
pub struct BargePaths {
    #[serde(skip_serializing_if = "Option::is_none")]
    worktrees: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scratch: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    builds: Option<PathBuf>,
}

impl EngineStorage {
    fn resolve(
        resolved: &ResolvedStorageLayout,
        home: &Path,
        settings: &EngineSettings,
    ) -> Result<Self, StorageError> {
        Self::resolve_with(resolved, home, settings, crate::barge::class_path)
    }

    fn resolve_with(
        resolved: &ResolvedStorageLayout,
        home: &Path,
        settings: &EngineSettings,
        class_path: impl Fn(&'static str) -> Result<PathBuf, StorageError>,
    ) -> Result<Self, StorageError> {
        let volume = settings.work_volume.as_ref();
        let roots = resolved.storage_roots();
        let mut barge_paths = BargePaths::default();
        if settings.placement == StoragePlacement::Barge {
            if volume.is_some() {
                return Err(StorageError::InvalidSettings(
                    "migrate the legacy volume profile before enabling Barge placement".into(),
                ));
            }
            for (class, explicit, path) in [
                ("worktrees", &settings.work_root, &mut barge_paths.worktrees),
                ("scratch", &settings.scratch_root, &mut barge_paths.scratch),
                ("builds", &settings.builds_root, &mut barge_paths.builds),
            ] {
                if explicit.is_none() {
                    *path = Some(class_path(class)?);
                }
            }
        }
        let scratch = scratch_path(resolved, settings);
        let directory = |path| storage_dir(volume, path, &scratch);
        let class_directory = |class, path: &Option<PathBuf>, default| match path {
            Some(path) => StorageDirectory::barge(path.clone()).map_err(|error| {
                StorageError::BargePlacement {
                    class,
                    reason: format!(
                        "class directory for {} is unavailable ({error})",
                        path.display()
                    ),
                }
            }),
            None => directory(default),
        };
        let mount = volume
            .map(|volume| volume.open_mount(Some(&scratch)))
            .transpose()?;
        let log = settings
            .log_root
            .clone()
            .unwrap_or_else(|| roots.log().to_path_buf());
        let work = settings.work_root.clone().unwrap_or_else(|| {
            roots
                .workspace()
                .map_or_else(|| roots.state().join("work"), Path::to_path_buf)
        });
        let builds = settings.builds_root.clone().unwrap_or_else(|| {
            if roots.cache().starts_with(home) {
                scratch.join("cargo-target")
            } else {
                roots.cache().join("builds")
            }
        });
        let storage = Self {
            home: home.to_path_buf(),
            placement: settings.placement,
            bin: directory(home.join("bin"))?,
            database: directory(resolved.durable_database_dir())?,
            work: class_directory("worktrees", &barge_paths.worktrees, work)?,
            scratch: class_directory("scratch", &barge_paths.scratch, scratch.clone())?,
            builds: class_directory("builds", &barge_paths.builds, builds)?,
            backup: directory(roots.backup().to_path_buf())?,
            log: directory(log)?,
            barge_paths,
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
            &storage.bin,
            &storage.database,
            &storage.work,
            &storage.scratch,
            &storage.builds,
            &storage.backup,
            &storage.log,
        ] {
            storage.verify_optional(path)?;
        }
        Ok(storage)
    }

    /// Hold on to the work and scratch roots a running service starts with, so a
    /// missing or substituted root is unavailable until the original returns.
    ///
    /// # Errors
    /// Returns an error if either root cannot be created or opened.
    pub fn pin_roots(&mut self) -> Result<(), StorageError> {
        self.work = self.work.clone().pinned()?;
        self.scratch = self.scratch.clone().pinned()?;
        Ok(())
    }

    /// The profile home used for durable state.
    #[must_use]
    pub fn home(&self) -> &Path {
        &self.home
    }

    /// The placement mode selected at engine startup.
    #[must_use]
    pub const fn placement(&self) -> StoragePlacement {
        self.placement
    }

    /// The Barge classes used by the running engine.
    #[must_use]
    pub const fn barge_paths(&self) -> &BargePaths {
        &self.barge_paths
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
    pub const fn bin(&self) -> &StorageDirectory {
        &self.bin
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

    /// The root for Cargo output and other expendable builds.
    #[must_use]
    pub const fn builds(&self) -> &StorageDirectory {
        &self.builds
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
        let application =
            BackupApplication::new(APP_ID, APP_VERSION).map_err(|_| StorageError::Layout)?;
        let listing =
            list_operational_backups(&root, &application, BackupArchiveLimits::default(), 128);
        response.complete = listing.is_complete();
        response.issues = listing
            .diagnostics()
            .iter()
            .filter(|diagnostic| {
                diagnostic.kind != longhorn_config::BackupRetentionDiagnosticKind::Unmanaged
                    || !diagnostic.path.as_deref().is_some_and(schema_backup)
            })
            .count();
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

fn schema_backup(path: &Path) -> bool {
    let Some((version, suffix)) = path
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix("engine-before-v"))
        .and_then(|n| n.strip_suffix(".sqlite"))
        .and_then(|n| n.split_once('-'))
    else {
        return false;
    };
    let Ok(version) = version.parse::<i32>() else {
        return false;
    };
    if !(1..crate::SCHEMA_VERSION).contains(&version)
        || suffix.len() != 6
        || !suffix.bytes().all(|b| b.is_ascii_alphanumeric())
        || !path.symlink_metadata().is_ok_and(|m| m.is_file())
    {
        return false;
    }
    // Inspect only the SQLite header. Opening a WAL-mode file through SQLite can
    // create sidecars even when the connection is read-only.
    let Ok(fd) = open(
        path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    ) else {
        return false;
    };
    let mut header = [0u8; 72];
    std::io::Read::read_exact(&mut std::fs::File::from(fd), &mut header).is_ok()
        && header.starts_with(b"SQLite format 3\0")
        && header[60..64] == version.to_be_bytes()
        && header[68..72] == crate::APPLICATION_ID.to_be_bytes()
}

fn identity() -> Result<StorageIdentity, StorageError> {
    StorageIdentity::new(APP_ID).map_err(|_| StorageError::Layout)
}

pub(crate) fn default_home() -> Result<PathBuf, StorageError> {
    std::env::home_dir()
        .filter(|home| home.is_absolute())
        .map(|home| home.join(".nucleus/engine"))
        .ok_or(StorageError::Layout)
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
    /// The domain's current schema version. Version 1 files upgrade on startup.
    const VERSION: u32 = 2;

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
        EngineStorage::resolve(&file.layout, &file.home, self).map(|_| ())
    }
}

struct SettingsDomain<S> {
    descriptor: DomainDescriptor,
    value_type: PhantomData<S>,
    retired_keys: Option<RefCell<BTreeSet<&'static str>>>,
}

impl<S: SettingsValue> SettingsDomain<S> {
    fn new() -> Result<Self, StorageError> {
        let id = DomainId::new(S::ID).map_err(|_| StorageError::Layout)?;
        let version = SchemaVersion::new(S::VERSION).map_err(|_| StorageError::Layout)?;
        let path = DomainFilePath::new(S::FILE).map_err(|_| StorageError::Layout)?;
        Ok(Self {
            descriptor: DomainDescriptor::new(id, version, S::CLASS, Some(path))
                .map_err(|_| StorageError::Layout)?,
            value_type: PhantomData,
            retired_keys: None,
        })
    }

    fn error(detail: &(impl std::fmt::Display + ?Sized)) -> StorageError {
        StorageError::SettingsDocument(format!("{}: {detail}", S::FILE))
    }

    fn load(&self, store: &ConfigStore) -> Result<LoadedConfig<S>, StorageError> {
        match store.load(self).map_err(|error| Self::error(&error))? {
            LoadOutcome::Ready(config) => Ok(config),
            LoadOutcome::Recovery(recovery) => Err(Self::error(&recovery.detail)),
            LoadOutcome::Unavailable(_) => Err(StorageError::SettingsUnavailable),
        }
    }

    fn upgrade(&self, store: &ConfigStore, backup: &Path) -> Result<(), StorageError> {
        let loaded = self.load(store)?;
        let (LoadedOrigin::MigratedInMemory { .. }, Some(source)) = (loaded.origin, loaded.source)
        else {
            return Ok(());
        };
        let path = source
            .path
            .canonicalize()
            .map_err(|error| Self::error(&error))?;
        if path != source.path {
            return Err(Self::error("settings path is redirected"));
        }
        StorageDirectory::native(backup.into())?.ensure()?;
        self.rewrite(store, backup)
            .map_err(|error| Self::error(&error))
    }

    fn rewrite(&self, store: &ConfigStore, backup: &Path) -> Result<(), Box<dyn Error>> {
        let mut catalog = BackupCatalog::new();
        catalog.include(self)?;
        let id = format!("settings-upgrade-{}-{}", S::FILE, uuid::Uuid::new_v4());
        let now = OffsetDateTime::now_utc().format(&Rfc3339)?;
        let application = BackupApplication::new(APP_ID, APP_VERSION)?;
        let producer = BackupProducer::new("nucleus", APP_VERSION)?;
        let metadata =
            BackupMetadata::new(&id, BackupKind::PreMigration, now, application, producer)?;
        let timeout = MUTATION.lock_timeout;
        let safety = RestoreSafetyBackupOptions::new(
            metadata,
            BackupOperationalRoot::new(backup)?,
            BackupArchiveFileName::new(format!("{id}.longhorn-backup"))?,
            BackupCaptureOptions::new(timeout, longhorn_config::BackupLimits::default()),
            BackupArchiveLimits::default(),
        );
        match store.rewrite_migrated_domain(
            &catalog,
            self,
            MigrationRewriteOptions::new(timeout, safety),
        ) {
            Ok(receipt) => {
                let keys = self
                    .retired_keys
                    .as_ref()
                    .map_or_else(BTreeSet::new, RefCell::take);
                let message = format!(
                    "Upgraded {} to settings version {}. Removed keys {keys:?}. Verified backup at {}",
                    S::FILE,
                    receipt.to(),
                    receipt.safety_backup().path.display()
                );
                if log::log_enabled!(target: "nucleus::serve", log::Level::Warn) {
                    log::warn!(target: "nucleus::serve", "{message}");
                } else {
                    eprintln!("{} {message}", time::OffsetDateTime::now_utc());
                }
                Ok(())
            }
            Err(MigrationRewriteError::NotRequired) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

impl<S: SettingsValue> ConfigDomain for SettingsDomain<S> {
    type Value = S;

    fn descriptor(&self) -> &DomainDescriptor {
        &self.descriptor
    }

    fn default_value(&self) -> S {
        S::default()
    }

    fn decode(&self, value: Value) -> Result<S, DomainIssue> {
        serde_json::from_value(value).map_err(|error| DomainIssue::new("decode", error.to_string()))
    }

    fn encode(&self, value: &S) -> Result<Value, DomainIssue> {
        serde_json::to_value(value)
            .map_err(|_| DomainIssue::new("encode", "settings could not be encoded"))
    }

    fn validate(&self, value: &S) -> Result<(), DomainIssue> {
        value.validate()
    }

    fn validate_raw(&self, version: SchemaVersion, value: &Value) -> Result<(), DomainIssue> {
        if version == self.descriptor.schema_version() {
            self.validate(&self.decode(value.clone())?)?;
        }
        Ok(())
    }

    fn migrate_one(
        &self,
        from: SchemaVersion,
        mut value: Value,
    ) -> Result<Option<MigrationStep>, DomainIssue> {
        let Some(retired_keys) = self
            .retired_keys
            .as_ref()
            .filter(|_| from < self.descriptor.schema_version())
        else {
            return Ok(None);
        };
        // Later versions follow one step at a time.
        let next = SchemaVersion::new(from.get() + 1)
            .map_err(|_| DomainIssue::new("migration", "unknown settings version"))?;
        if S::FILE == DispatchSettings::FILE && from.get() == 2 {
            split_global_slots(&mut value)?;
            retired_keys.borrow_mut().insert("globalSlots");
            return Ok(Some(MigrationStep {
                schema_version: next,
                value,
            }));
        }
        if from.get() != 1 {
            return Ok(None);
        }
        let mut retired = BTreeSet::new();
        let mut rewrite = |object: &mut Value, key: &'static str, replacement: Option<&str>| {
            if let Some(fields) = object.as_object_mut()
                && replacement.is_none_or(|name| !fields.contains_key(name))
                && let Some(old) = fields.remove(key)
            {
                retired.insert(key);
                if let Some(name) = replacement {
                    fields.insert(name.into(), old);
                }
            }
        };
        match S::FILE {
            DispatchSettings::FILE => {
                for key in [
                    "maxLoad",
                    "max_load",
                    "allowanceMinutes",
                    "allowance_minutes",
                    "hostConcurrency",
                    "host_concurrency",
                    "legacyLimitsImported",
                    "providerLimitCooldownSeconds",
                    "provider_limit_cooldown_seconds",
                ] {
                    rewrite(&mut value, key, None);
                }
                rewrite(&mut value, "slots", Some("globalSlots"));
            }
            Profiles::FILE => {
                let profiles = value.get_mut("profiles").and_then(Value::as_array_mut);
                for profile in profiles.into_iter().flatten() {
                    rewrite(profile, "roles", None);
                    rewrite(profile, "scopes", None);
                    if let Some(selection) = profile.get_mut("selection") {
                        rewrite(selection, "thinkingOptionId", Some("effort"));
                    }
                }
            }
            Projects::FILE => {
                let projects = value.get_mut("projects").and_then(Value::as_object_mut);
                for project in projects.into_iter().flat_map(serde_json::Map::values_mut) {
                    rewrite(project, "slots", None);
                    let repositories = project
                        .get_mut("repositories")
                        .and_then(Value::as_array_mut);
                    for repository in repositories.into_iter().flatten() {
                        rewrite(repository, "requiredChecks", None);
                        rewrite(repository, "hungToolMinutes", None);
                    }
                }
            }
            _ => {}
        }
        retired_keys.borrow_mut().extend(retired);
        Ok(Some(MigrationStep {
            schema_version: next,
            value,
        }))
    }
}

/// Dispatch version 3 replaces the one global slot count with a count per task
/// weight, keeping their sum (ruling 63).
fn split_global_slots(value: &mut Value) -> Result<(), DomainIssue> {
    let invalid = || DomainIssue::new("dispatch", "the stored global slot count is not usable");
    let fields = value.as_object_mut().ok_or_else(invalid)?;
    let total = fields
        .remove("globalSlots")
        .as_ref()
        .and_then(Value::as_u64)
        .and_then(|total| u32::try_from(total).ok())
        .ok_or_else(invalid)?;
    let slots = Slots::split(total);
    for (key, count) in [
        ("heavySlots", slots.heavy),
        ("normalSlots", slots.normal),
        ("lightSlots", slots.light),
    ] {
        if fields.insert(key.into(), count.into()).is_some() {
            return Err(invalid());
        }
    }
    Ok(())
}

/// A durable store under a fresh portable root, for store-level tests.
#[cfg(test)]
pub(crate) fn test_store(home: &Path) -> crate::Store {
    let settings = EngineSettings {
        enabled: true,
        ..EngineSettings::default()
    };
    let storage = EngineStorage::resolve(&portable_layout(home).expect("layout"), home, &settings)
        .expect("storage");
    crate::Store::open(&storage).expect("open store")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[expect(clippy::too_many_lines, reason = "complete saved settings fixtures")]
    fn startup_upgrades_every_settings_domain_and_keeps_verified_originals() {
        use longhorn_config::inspect_backup_archive;
        use serde_json::json;

        let temporary = tempfile::tempdir().expect("fixture home");
        let home = temporary.path().canonicalize().expect("canonical home");
        let config = home.join("config");
        let state = home.join("state");
        std::fs::create_dir(&config).unwrap();
        std::fs::create_dir(&state).unwrap();

        let dispatch = json!({
            "usage": "high", "usageUntilMs": 1_800_000_000_000_u64,
            "heavySlots": 3, "normalSlots": 0, "lightSlots": 0,
            "projectDefaultSlots": 4, "projectSlotOverrides": {"alpha": 8, "beta": 0},
            "threadRetentionDays": 9, "threadRetentionIntervalHours": 24, "mode": "paused",
            "plannerModel": {"provider": "claude", "model": "claude-opus-5-5", "effort": "high"}
        });
        let legacy_dispatch = json!({
            "usage": "high", "usageUntilMs": 1_800_000_000_000_u64, "slots": 3,
            "projectDefaultSlots": 4, "projectSlotOverrides": {"alpha": 8, "beta": 0},
            "threadRetentionDays": 9, "threadRetentionIntervalHours": 24, "mode": "paused",
            "maxLoad": 18, "max_load": 18, "hostConcurrency": 8, "host_concurrency": 8,
            "allowanceMinutes": 30, "allowance_minutes": 30, "legacyLimitsImported": true,
            "providerLimitCooldownSeconds": 300, "provider_limit_cooldown_seconds": 300
        });
        let profiles = json!({
            "profiles": [{
                "name": "Fixture",
                "selection": {"id": "heavy", "capability": "heavyweight", "weight": "fewer",
                              "provider": "codex", "model": "fixture", "effort": "high"},
                "enabled": false, "group": "Fixture Team", "providerInstanceId": "codex-team",
                "modeId": "default", "featureValues": {"useFixture": true}, "notes": "Keep",
                "unrated": true
            }, {
                "name": "Alternate",
                "selection": {"id": "alternate", "capability": "heavyweight", "weight": "fewer",
                              "provider": "codex", "model": "fixture", "effort": null}
            }],
            "pausedGroups": ["Fixture Plus", "Fixture Team"]
        });
        let mut legacy_profiles = profiles.clone();
        legacy_profiles["pausedGroups"] = json!(["Fixture Team", "Fixture Plus"]);
        let profile = &mut legacy_profiles["profiles"][0];
        profile["roles"] = json!(["worker", "reviewer", "coordinator"]);
        profile["scopes"] = json!(["mechanical", "complex"]);
        profile["selection"]
            .as_object_mut()
            .unwrap()
            .remove("effort");
        profile["selection"]["thinkingOptionId"] = json!("high");
        legacy_profiles["profiles"][1]["enabled"] = json!(true);

        let projects = json!({
            "projects": {
                "alpha": {
                    "name": "Alpha", "archived": false,
                    "plannerClaim": {"thread": "planner", "occurrence": "claim", "replaced": "prior"},
                    "repositories": [{
                        "origin": "example/alpha", "path": "/fixture/alpha", "base": "trunk",
                        "hostProject": "host-project", "hostProjectTitle": "Alpha T3",
                        "plannerThreads": ["planner", "prior"]
                    }]
                },
                "beta": {"name": "Beta", "archived": true, "repositories": []}
            },
            "removed": {"old": {
                "repositories": [{"origin": "example/old", "path": "/fixture/old"}],
                "blockedOrigins": ["example/old"], "cleanupPending": true, "digest": "receipt",
                "reason": "Retired project", "removedAtMs": 42
            }}
        });
        let mut legacy_projects = projects.clone();
        let alpha = &mut legacy_projects["projects"]["alpha"];
        alpha["slots"] = json!(11);
        alpha["repositories"][0]["requiredChecks"] = json!(["CI", "lint"]);
        alpha["repositories"][0]["hungToolMinutes"] = json!(47);

        let github = json!({
            "accounts": [
                {"host": "github.com", "userId": "42", "login": "fixture-worker"},
                {"host": "github.com", "userId": "43", "login": "fixture-reviewer"}
            ],
            "workerAccountId": "github.com:42", "reviewerAccountId": "github.com:43"
        });
        let engine = json!({
            "enabled": true, "placement": "barge",
            "workRoot": "/fixture/work", "scratchRoot": "/fixture/scratch",
            "buildsRoot": "/fixture/builds", "logRoot": "/fixture/log",
            "retention": {"keepNewest": 17, "maxAgeDays": 45}
        });
        let hosts =
            json!({"t3": {"endpoint": "http://127.0.0.1:7777/", "credentialRef": "FIXTURE_T3"}});
        let cases = [
            (
                config.join(DispatchSettings::FILE),
                DispatchSettings::ID,
                legacy_dispatch,
                dispatch,
            ),
            (
                config.join(Profiles::FILE),
                Profiles::ID,
                legacy_profiles,
                profiles,
            ),
            (
                config.join(GitHubAccountSettings::FILE),
                GitHubAccountSettings::ID,
                github.clone(),
                github,
            ),
            (
                state.join(EngineSettings::FILE),
                EngineSettings::ID,
                engine.clone(),
                engine,
            ),
            (
                state.join(Projects::FILE),
                Projects::ID,
                legacy_projects,
                projects,
            ),
            (state.join(Hosts::FILE), Hosts::ID, hosts.clone(), hosts),
        ];
        let originals: Vec<_> = cases
            .iter()
            .map(|(path, domain, old, _)| {
                let bytes = json!({"domain": domain, "schemaVersion": 1, "value": old}).to_string();
                std::fs::write(path, &bytes).unwrap();
                bytes.into_bytes()
            })
            .collect();

        let file = SettingsFile::open(&home).expect("upgrade on startup");
        let rewritten: Vec<_> = cases
            .iter()
            .map(|(path, domain, _, expected)| {
                let bytes = std::fs::read(path).unwrap();
                let version = if *domain == DispatchSettings::ID {
                    DispatchSettings::VERSION
                } else {
                    2
                };
                assert_eq!(
                    serde_json::from_slice::<Value>(&bytes).unwrap(),
                    json!({"domain": domain, "schemaVersion": version, "value": expected}),
                    "{}",
                    path.display()
                );
                (bytes, std::fs::metadata(path).unwrap().modified().unwrap())
            })
            .collect();
        let backup_root = file.layout.storage_roots().backup();
        let archives = || {
            std::fs::read_dir(backup_root)
                .unwrap()
                .map(|entry| {
                    let archive = std::fs::read(entry.unwrap().path()).unwrap();
                    let verified =
                        inspect_backup_archive(&archive, BackupArchiveLimits::default()).unwrap();
                    assert_eq!(verified.payloads().len(), 1);
                    verified.payloads()[0].bytes().to_vec()
                })
                .collect::<BTreeSet<_>>()
        };
        assert_eq!(archives(), originals.iter().cloned().collect());
        assert_eq!(std::fs::read_dir(backup_root).unwrap().count(), cases.len());

        SettingsFile::open(&home).expect("reopen current files");
        for ((path, _, _, _), (bytes, modified)) in cases.iter().zip(rewritten) {
            assert_eq!(std::fs::read(path).unwrap(), bytes);
            assert_eq!(
                std::fs::metadata(path).unwrap().modified().unwrap(),
                modified
            );
        }
        assert_eq!(std::fs::read_dir(backup_root).unwrap().count(), cases.len());
    }

    #[test]
    fn dispatch_upgrade_splits_the_global_slot_count_by_weight_once() {
        use serde_json::json;

        for (global, heavy, normal, light) in [
            (18, 5, 8, 5),
            (32, 5, 22, 5),
            (11, 5, 1, 5),
            (10, 5, 0, 5),
            (7, 5, 0, 2),
            (5, 5, 0, 0),
            (1, 1, 0, 0),
        ] {
            let temporary = tempfile::tempdir().expect("fixture home");
            let home = temporary.path().canonicalize().expect("canonical home");
            std::fs::create_dir(home.join("config")).unwrap();
            let path = home.join("config").join(DispatchSettings::FILE);
            let stored = json!({
                "domain": DispatchSettings::ID, "schemaVersion": 2,
                "value": {
                    "usage": "high", "usageUntilMs": null, "globalSlots": global,
                    "projectDefaultSlots": 4, "projectSlotOverrides": {"alpha": 8},
                    "threadRetentionDays": 3, "threadRetentionIntervalHours": 12,
                    "mode": "running"
                }
            });
            std::fs::write(&path, stored.to_string()).unwrap();

            let file = SettingsFile::open(&home).expect("upgrade on startup");
            let upgraded = std::fs::read(&path).unwrap();
            let mut expected = stored.clone();
            expected["schemaVersion"] = json!(3);
            let value = expected["value"].as_object_mut().unwrap();
            value.remove("globalSlots");
            value.insert("heavySlots".into(), json!(heavy));
            value.insert("normalSlots".into(), json!(normal));
            value.insert("lightSlots".into(), json!(light));
            assert_eq!(
                serde_json::from_slice::<Value>(&upgraded).unwrap(),
                expected,
                "{global}"
            );
            let settings = file.read::<DispatchSettings>().unwrap().value;
            assert_eq!(settings.slots().total(), global);
            drop(file);

            // A current file is never split again.
            SettingsFile::open(&home).expect("reopen the current file");
            assert_eq!(std::fs::read(&path).unwrap(), upgraded);
        }
    }

    #[test]
    fn startup_rejects_unknown_current_keys_without_rewriting_the_file() {
        use serde_json::json;

        let temporary = tempfile::tempdir().expect("fixture home");
        let home = temporary.path().canonicalize().expect("canonical home");
        let config = home.join("config");
        std::fs::create_dir(&config).unwrap();
        let path = config.join(Profiles::FILE);
        let mut document = json!({
            "domain": Profiles::ID, "schemaVersion": 2,
            "value": {"profiles": [{
                "name": "Fixture", "selection": {"id": "fixture", "provider": "codex",
                "model": "fixture", "unknownFixtureKey": true}
            }]}
        });
        let assert_rejected = |bytes: String, key: &str| {
            std::fs::write(&path, &bytes).unwrap();
            let error = SettingsFile::open(&home)
                .err()
                .expect("strict startup rejection");
            let message = error.to_string();
            assert!(message.contains(Profiles::FILE), "{message}");
            assert!(message.contains(key), "{message}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), bytes);
        };
        assert_rejected(document.to_string(), "unknownFixtureKey");
        document["value"]["profiles"] = json!([]);
        document["unexpectedEnvelopeKey"] = json!(true);
        assert_rejected(document.to_string(), "unexpectedEnvelopeKey");
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
            EngineStorage::resolve(&portable_layout(&home).expect("layout"), &home, &settings),
            Err(StorageError::MissingVolume)
        ));
        assert!(!mount.exists());
    }

    #[test]
    fn default_profile_keeps_durable_storage_under_home_without_barge() {
        let temporary = tempfile::tempdir().expect("fixture home");
        let root = temporary.path().canonicalize().expect("canonical home");
        for platform in [TargetPlatform::MacOs, TargetPlatform::Linux] {
            let home = root.join(format!("{platform:?}")).join(".nucleus/engine");
            let facts = PlatformDirectoryFacts::new(platform)
                .with(PlatformDirectoryFact::Config, root.join("config"))
                .with(PlatformDirectoryFact::Data, root.join("data"))
                .with(PlatformDirectoryFact::State, root.join("state"))
                .with(PlatformDirectoryFact::Cache, root.join("cache"))
                .with(PlatformDirectoryFact::Log, root.join("log"));
            let settings = SettingsFile::open_account(&home, facts).expect("platform roots");
            settings
                .save(&EngineSettings {
                    enabled: true,
                    ..EngineSettings::default()
                })
                .expect("enable without a pin");
            let storage = settings.storage().expect("no volume is required");
            assert!(storage.scratch().path().starts_with(root.join("cache")));
            assert!(storage.work().path().starts_with(root.join("state")));
            assert!(storage.builds().path().starts_with(root.join("cache")));
            assert!(storage.log().path().starts_with(&home));
            assert!(storage.backup().path().starts_with(&home));
            assert!(storage.bin().path().starts_with(&home));
            assert!(storage.database().path().starts_with(&home));
            assert!(home.join("state/engine.json").is_file());
            crate::Store::open(&storage).expect("open native database");
        }
    }

    #[test]
    fn a_resolved_barge_class_does_not_write_to_a_replacement_directory() {
        let temporary = tempfile::tempdir().expect("fixture home");
        let root = temporary.path().canonicalize().expect("canonical home");
        let home = root.join("engine");
        let classes = root.join("volume");
        std::fs::create_dir_all(classes.join("worktrees")).expect("class directory");
        std::fs::create_dir_all(classes.join("scratch")).expect("class directory");
        let settings = EngineSettings {
            enabled: true,
            placement: StoragePlacement::Barge,
            builds_root: Some(home.join("my-builds")),
            ..EngineSettings::default()
        };
        let storage = EngineStorage::resolve_with(
            &portable_layout(&home).expect("layout"),
            &home,
            &settings,
            |class| Ok(classes.join(class).join("nucleus")),
        )
        .expect("resolve classes and the explicit override");
        assert_eq!(storage.builds().path(), home.join("my-builds"));
        assert_eq!(storage.work().path(), classes.join("worktrees/nucleus"));
        storage
            .work()
            .ensure()
            .expect("create project beneath the class");
        std::fs::rename(classes.join("worktrees"), classes.join("offline")).expect("lose class");
        std::fs::create_dir(classes.join("worktrees")).expect("replacement class directory");
        assert!(matches!(
            storage.work().ensure(),
            Err(StorageError::VolumeUnavailable)
        ));
        assert!(!storage.work().path().exists());
    }
}
