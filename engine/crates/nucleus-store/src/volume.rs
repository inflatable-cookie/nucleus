use std::{
    os::fd::OwnedFd,
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
    process::Command,
};

use rustix::fs::{Mode, OFlags, fstat, mkdirat, open, openat};
use serde::{Deserialize, Serialize};

use crate::settings::StorageError;

const DIRECTORY: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinnedVolume {
    pub mount: PathBuf,
    pub volume_id: String,
}

impl PinnedVolume {
    /// Read the mounted volume under an existing path for explicit configuration.
    ///
    /// # Errors
    /// Returns an error if the native volume ID cannot be read.
    pub fn detect(path: &Path) -> Result<Self, StorageError> {
        Self::detect_using(path, None)
    }

    pub(crate) fn detect_using(path: &Path, scratch: Option<&Path>) -> Result<Self, StorageError> {
        let mut mount = path.canonicalize()?;
        let device = mount.metadata()?.dev();
        while let Some(parent) = mount.parent() {
            if parent.metadata()?.dev() != device {
                break;
            }
            mount = parent.to_path_buf();
        }
        detect_volume(&mount, scratch)
    }

    pub(crate) fn dir(
        &self,
        path: PathBuf,
        scratch: &Path,
    ) -> Result<StorageDirectory, StorageError> {
        relative(&self.mount, &path)?;
        Ok(StorageDirectory {
            volume: Some(self.clone()),
            path,
            scratch: Some(scratch.into()),
        })
    }

    pub(crate) fn open_mount(&self, scratch: Option<&Path>) -> Result<OwnedFd, StorageError> {
        if self.volume_id.is_empty() || !self.mount.is_absolute() {
            return Err(StorageError::VolumeUnavailable);
        }
        let canonical = self.mount.canonicalize().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                StorageError::MissingVolume
            } else {
                StorageError::VolumeUnavailable
            }
        })?;
        if canonical != self.mount {
            return Err(StorageError::VolumeUnavailable);
        }
        let fd = open(&self.mount, DIRECTORY, Mode::empty())?;
        let reported = Self::detect_using(&self.mount, scratch)?;
        if reported.mount != self.mount || !reported.volume_id.eq_ignore_ascii_case(&self.volume_id)
        {
            return Err(StorageError::VolumeUnavailable);
        }
        let current = open(&self.mount, DIRECTORY, Mode::empty())?;
        let opened = fstat(&fd)?;
        let mounted = fstat(&current)?;
        if (opened.st_dev, opened.st_ino) != (mounted.st_dev, mounted.st_ino) {
            return Err(StorageError::VolumeUnavailable);
        }
        Ok(fd)
    }
}

#[derive(Debug, Clone)]
pub struct StorageDirectory {
    volume: Option<PinnedVolume>,
    path: PathBuf,
    scratch: Option<PathBuf>,
}

impl StorageDirectory {
    pub(crate) fn native(path: PathBuf) -> Result<Self, StorageError> {
        relative(Path::new("/"), &path)?;
        Ok(Self {
            volume: None,
            path,
            scratch: None,
        })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Verify that the configured directory is present on the pinned volume.
    ///
    /// # Errors
    /// Returns an error for an unavailable mount, missing directory, or redirect.
    pub fn verify(&self) -> Result<(), StorageError> {
        self.walk(&self.path, false)
    }

    /// Create missing components relative to the pinned mount without following links.
    ///
    /// # Errors
    /// Returns an error if the volume or any component cannot be verified.
    pub fn ensure(&self) -> Result<(), StorageError> {
        self.walk(&self.path, true)
    }

    /// Create a child directory beneath this root without following links.
    ///
    /// # Errors
    /// Returns an error on escape, link traversal, or an unavailable volume.
    pub fn ensure_child(&self, child: &Path) -> Result<(), StorageError> {
        if !child
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err(StorageError::OutsideVolume);
        }
        self.walk(&self.path.join(child), true)
    }

    // Verify against the already checked mount held open by the running engine.
    // Reopening the path detects a dismount or replacement without a process.
    pub(crate) fn verify_from_mount(&self, mount: &OwnedFd) -> Result<(), StorageError> {
        let current = open(self.root(), DIRECTORY, Mode::empty())?;
        let expected = fstat(mount)?;
        let found = fstat(&current)?;
        if (expected.st_dev, expected.st_ino) != (found.st_dev, found.st_ino) {
            return Err(StorageError::VolumeUnavailable);
        }
        self.walk_from(current, &self.path, false)
    }

    fn walk(&self, path: &Path, create: bool) -> Result<(), StorageError> {
        let root = match &self.volume {
            Some(volume) => volume.open_mount(self.scratch.as_deref())?,
            None => open(self.root(), DIRECTORY, Mode::empty())?,
        };
        self.walk_from(root, path, create)
    }

    fn root(&self) -> &Path {
        self.volume
            .as_ref()
            .map_or(Path::new("/"), |volume| volume.mount.as_path())
    }

    fn walk_from(
        &self,
        mut directory: OwnedFd,
        path: &Path,
        create: bool,
    ) -> Result<(), StorageError> {
        let device = fstat(&directory)?.st_dev;
        for component in relative(self.root(), path)?.components() {
            let Component::Normal(name) = component else {
                return Err(StorageError::OutsideVolume);
            };
            directory = match openat(&directory, name, DIRECTORY, Mode::empty()) {
                Err(rustix::io::Errno::NOENT) if create => {
                    match mkdirat(&directory, name, Mode::RUSR | Mode::WUSR | Mode::XUSR) {
                        Ok(()) | Err(rustix::io::Errno::EXIST) => {}
                        Err(error) => return Err(error.into()),
                    }
                    openat(&directory, name, DIRECTORY, Mode::empty())?
                }
                answer => answer?,
            };
            if self.volume.is_some() && fstat(&directory)?.st_dev != device {
                return Err(StorageError::OutsideVolume);
            }
        }
        Ok(())
    }
}

fn relative<'a>(mount: &Path, path: &'a Path) -> Result<&'a Path, StorageError> {
    let path = path
        .strip_prefix(mount)
        .map_err(|_| StorageError::OutsideVolume)?;
    if !path
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(StorageError::OutsideVolume);
    }
    Ok(path)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn volume_probe(executable: &str, scratch: Option<&Path>) -> Command {
    let mut command = Command::new(executable);
    if let Some(scratch) = scratch {
        command.envs(["TMPDIR", "TMP", "TEMP"].map(|name| (name, scratch)));
    }
    command
}

#[cfg(target_os = "macos")]
fn detect_volume(path: &Path, scratch: Option<&Path>) -> Result<PinnedVolume, StorageError> {
    #[derive(Deserialize)]
    struct Info {
        #[serde(rename = "MountPoint")]
        mount: PathBuf,
        #[serde(rename = "VolumeUUID")]
        volume_id: String,
        #[serde(rename = "WritableVolume")]
        writable: bool,
    }
    let result = volume_probe("/usr/sbin/diskutil", scratch)
        .args(["info", "-plist"])
        .arg(path)
        .output()?;
    if !result.status.success() {
        return Err(StorageError::VolumeUnavailable);
    }
    let info: Info =
        plist::from_bytes(&result.stdout).map_err(|_| StorageError::VolumeUnavailable)?;
    if !info.writable || info.volume_id.is_empty() {
        return Err(StorageError::VolumeUnavailable);
    }
    Ok(PinnedVolume {
        mount: info.mount,
        volume_id: info.volume_id,
    })
}

#[cfg(target_os = "linux")]
fn detect_volume(path: &Path, scratch: Option<&Path>) -> Result<PinnedVolume, StorageError> {
    #[derive(Deserialize)]
    struct ResultSet {
        filesystems: Vec<Filesystem>,
    }
    #[derive(Deserialize)]
    struct Filesystem {
        target: PathBuf,
        uuid: Option<String>,
        options: String,
    }
    let result = volume_probe("findmnt", scratch)
        .args(["--json", "--output", "TARGET,UUID,OPTIONS", "--target"])
        .arg(path)
        .output()?;
    if !result.status.success() {
        return Err(StorageError::VolumeUnavailable);
    }
    let mut parsed: ResultSet =
        serde_json::from_slice(&result.stdout).map_err(|_| StorageError::VolumeUnavailable)?;
    let info = parsed
        .filesystems
        .pop()
        .filter(|fs| fs.options.split(',').any(|option| option == "rw"))
        .ok_or(StorageError::VolumeUnavailable)?;
    let volume_id = info
        .uuid
        .filter(|uuid| !uuid.is_empty())
        .ok_or(StorageError::VolumeUnavailable)?;
    Ok(PinnedVolume {
        mount: info.target,
        volume_id,
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn detect_volume(_: &Path, _: Option<&Path>) -> Result<PinnedVolume, StorageError> {
    Err(StorageError::VolumeUnavailable)
}
