use std::{
    fs::File,
    os::fd::OwnedFd,
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex, PoisonError},
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
            root: DirectoryRoot::Pinned {
                volume: self.clone(),
                scratch: scratch.into(),
            },
            path,
            pin: None,
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
    root: DirectoryRoot,
    path: PathBuf,
    pin: Option<Arc<Mutex<Anchor>>>,
}

#[derive(Debug, Clone)]
enum DirectoryRoot {
    Native,
    Pinned {
        volume: PinnedVolume,
        scratch: PathBuf,
    },
    Barge {
        class_root: PathBuf,
        anchor: Arc<Mutex<Anchor>>,
    },
}

/// A directory the engine is using. A remount gives it a new device number,
/// accepted only on proof of the same volume.
#[derive(Debug)]
struct Anchor {
    // Held open so the inode cannot be reused while the engine runs.
    _directory: File,
    device: u64,
    inode: u64,
    volume_id: Option<String>,
    gone: bool,
    returns: u64,
}

impl Anchor {
    fn new(directory: File, volume_id: Option<String>) -> Result<Self, StorageError> {
        let found = directory.metadata()?;
        Ok(Self {
            _directory: directory,
            device: found.dev(),
            inode: found.ino(),
            volume_id,
            gone: false,
            returns: 0,
        })
    }

    /// Note whether the directory is there, counting each time it comes back.
    fn record(anchor: &Mutex<Self>, gone: bool) {
        let mut held = anchor.lock().unwrap_or_else(PoisonError::into_inner);
        held.returns += u64::from(held.gone && !gone);
        held.gone = gone;
    }

    fn hold(path: &Path, directory: OwnedFd) -> Result<Arc<Mutex<Self>>, StorageError> {
        // Without a volume ID a remounted directory stays unavailable until restart.
        let volume_id = PinnedVolume::detect(path)
            .ok()
            .map(|volume| volume.volume_id);
        let anchor = Self::new(directory.into(), volume_id)?;
        Ok(Arc::new(Mutex::new(anchor)))
    }

    /// Accept the directory just opened at the anchored path.
    fn admit(anchor: &Mutex<Self>, path: &Path, current: OwnedFd) -> Result<OwnedFd, StorageError> {
        let current = File::from(current);
        let found = current.metadata()?;
        let (device, inode, volume_id) = {
            let held = anchor.lock().unwrap_or_else(PoisonError::into_inner);
            (held.device, held.inode, held.volume_id.clone())
        };
        if (found.dev(), found.ino()) != (device, inode) {
            // Another directory at this path is never adopted.
            let expected = volume_id
                .filter(|_| found.ino() == inode)
                .ok_or(StorageError::VolumeUnavailable)?;
            if !PinnedVolume::detect(path)?
                .volume_id
                .eq_ignore_ascii_case(&expected)
            {
                return Err(StorageError::VolumeUnavailable);
            }
            let mut adopted = Self::new(current.try_clone()?, Some(expected))?;
            let mut held = anchor.lock().unwrap_or_else(PoisonError::into_inner);
            // A remount is a return even when nothing saw the volume missing.
            adopted.returns = held.returns + 1;
            *held = adopted;
        }
        Ok(current.into())
    }
}

impl StorageDirectory {
    pub(crate) fn native(path: PathBuf) -> Result<Self, StorageError> {
        relative(Path::new("/"), &path)?;
        Ok(Self {
            root: DirectoryRoot::Native,
            path,
            pin: None,
        })
    }

    pub(crate) fn barge(path: PathBuf) -> Result<Self, StorageError> {
        let class_root = path.parent().ok_or(StorageError::Layout)?;
        if class_root == Path::new("/") {
            return Err(StorageError::Layout);
        }
        let class = Self::native(class_root.to_path_buf())?;
        class.verify()?;
        let directory = open(class_root, DIRECTORY, Mode::empty())?;
        Ok(Self {
            root: DirectoryRoot::Barge {
                class_root: class_root.to_path_buf(),
                anchor: Anchor::hold(class_root, directory)?,
            },
            path,
            pin: None,
        })
    }

    /// Create this directory if it is missing and hold on to the one found.
    /// From then on a missing directory or a substitute at its path is
    /// unavailable, and nothing recreates it.
    ///
    /// # Errors
    /// Returns an error if the directory cannot be created or opened.
    pub fn pinned(mut self) -> Result<Self, StorageError> {
        self.ensure()?;
        let directory = self.walk_from(self.open_root()?, &self.path, false)?;
        self.pin = Some(Anchor::hold(&self.path, directory)?);
        Ok(self)
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
        self.walk_from(current, &self.path, false).map(drop)
    }

    fn walk(&self, path: &Path, create: bool) -> Result<(), StorageError> {
        // Checked before anything is created, so a substitute stays untouched.
        if let Some(pin) = &self.pin {
            match self.find_pinned(pin) {
                Ok(()) => Anchor::record(pin, false),
                Err(error @ (StorageError::VolumeUnavailable | StorageError::MissingVolume)) => {
                    Anchor::record(pin, true);
                    return Err(error);
                }
                Err(error) => return Err(error),
            }
        }
        self.walk_from(self.open_root()?, path, create).map(drop)
    }

    fn find_pinned(&self, pin: &Mutex<Anchor>) -> Result<(), StorageError> {
        let found = self
            .walk_from(self.open_root()?, &self.path, false)
            .map_err(|error| match error {
                StorageError::ConfinedDirectory(
                    rustix::io::Errno::NOENT | rustix::io::Errno::NOTDIR,
                )
                | StorageError::OutsideVolume => StorageError::VolumeUnavailable,
                error => error,
            })?;
        Anchor::admit(pin, &self.path, found).map(drop)
    }

    /// How often this pinned directory has come back after being found missing,
    /// substituted or remounted. A directory which is not pinned never counts.
    #[must_use]
    pub fn returns(&self) -> u64 {
        self.pin.as_ref().map_or(0, |pin| {
            pin.lock().unwrap_or_else(PoisonError::into_inner).returns
        })
    }

    fn open_root(&self) -> Result<OwnedFd, StorageError> {
        match &self.root {
            DirectoryRoot::Native => Ok(open(self.root(), DIRECTORY, Mode::empty())?),
            DirectoryRoot::Pinned { volume, scratch } => volume.open_mount(Some(scratch)),
            DirectoryRoot::Barge { class_root, anchor } => {
                let current = open(class_root, DIRECTORY, Mode::empty()).map_err(|error| {
                    if error == rustix::io::Errno::NOENT {
                        StorageError::VolumeUnavailable
                    } else {
                        error.into()
                    }
                })?;
                Anchor::admit(anchor, class_root, current)
            }
        }
    }

    fn root(&self) -> &Path {
        match &self.root {
            DirectoryRoot::Native => Path::new("/"),
            DirectoryRoot::Pinned { volume, .. } => &volume.mount,
            DirectoryRoot::Barge { class_root, .. } => class_root,
        }
    }

    fn walk_from(
        &self,
        mut directory: OwnedFd,
        path: &Path,
        create: bool,
    ) -> Result<OwnedFd, StorageError> {
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
            if !matches!(self.root, DirectoryRoot::Native) && fstat(&directory)?.st_dev != device {
                return Err(StorageError::OutsideVolume);
            }
        }
        Ok(directory)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn a_remounted_barge_class_is_adopted_and_a_replaced_one_is_refused() {
        let volume = tempfile::tempdir().unwrap();
        let root = volume.path().canonicalize().unwrap();
        let class = root.join("worktrees");
        std::fs::create_dir(&class).unwrap();
        let directory = StorageDirectory::barge(class.join("engine")).unwrap();
        directory.ensure().unwrap();
        let DirectoryRoot::Barge { anchor, .. } = &directory.root else {
            panic!("Barge directory");
        };

        // A remount keeps the inode and volume ID but changes the device number.
        let device = anchor.lock().unwrap().device;
        anchor.lock().unwrap().device = device + 1;
        directory.clone().verify().unwrap();
        assert_eq!(anchor.lock().unwrap().device, device);

        // A new device number on another volume is refused.
        let volume_id = anchor.lock().unwrap().volume_id.clone();
        anchor.lock().unwrap().device = device + 1;
        anchor.lock().unwrap().volume_id = Some("another-volume".into());
        assert!(matches!(
            directory.verify(),
            Err(StorageError::VolumeUnavailable)
        ));
        anchor.lock().unwrap().volume_id = volume_id;
        directory.verify().unwrap();

        // The root renamed away is unavailable, and returns without a restart.
        let away = root.join("away");
        std::fs::rename(&class, &away).unwrap();
        assert!(matches!(
            directory.verify(),
            Err(StorageError::VolumeUnavailable)
        ));
        std::fs::create_dir_all(class.join("engine")).unwrap();
        assert!(matches!(
            directory.ensure(),
            Err(StorageError::VolumeUnavailable)
        ));
        std::fs::remove_dir_all(&class).unwrap();
        std::fs::rename(&away, &class).unwrap();
        directory.verify().unwrap();
    }

    #[test]
    fn a_pinned_directory_refuses_a_substitute_and_is_never_recreated() {
        let volume = tempfile::tempdir().unwrap();
        let root = volume.path().canonicalize().unwrap();
        let path = root.join("work");
        let directory = StorageDirectory::native(path.clone())
            .unwrap()
            .pinned()
            .unwrap();
        directory.ensure_child(Path::new("bucket")).unwrap();

        let away = root.join("away");
        std::fs::rename(&path, &away).unwrap();
        for result in [directory.verify(), directory.ensure()] {
            assert!(matches!(result, Err(StorageError::VolumeUnavailable)));
        }
        assert!(!path.exists());
        std::fs::create_dir(&path).unwrap();
        for result in [
            directory.verify(),
            directory.clone().ensure_child(Path::new("bucket")),
        ] {
            assert!(matches!(result, Err(StorageError::VolumeUnavailable)));
        }
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 0);

        std::fs::remove_dir(&path).unwrap();
        std::fs::rename(&away, &path).unwrap();
        assert_eq!(directory.returns(), 0);
        directory.verify().unwrap();
        directory.verify().unwrap();
        assert_eq!(directory.returns(), 1);

        // A remount counts even if no check ran while the volume was away.
        #[cfg(target_os = "macos")]
        {
            let pin = directory.pin.as_ref().unwrap();
            pin.lock().unwrap().device += 1;
            directory.verify().unwrap();
            assert_eq!(directory.returns(), 2);
        }
    }
}
