use std::{
    fs::File,
    os::fd::OwnedFd,
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex, PoisonError},
};

use rustix::fs::{Mode, OFlags, fstat, mkdirat, open, openat};
use serde::Deserialize;

use crate::settings::StorageError;

const DIRECTORY: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);

#[derive(Debug, Clone)]
pub struct StorageDirectory {
    root: DirectoryRoot,
    path: PathBuf,
    pin: Option<Arc<Mutex<Anchor>>>,
}

#[derive(Debug, Clone)]
enum DirectoryRoot {
    Native,
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
}

impl Anchor {
    fn new(directory: File, volume_id: Option<String>) -> Result<Self, StorageError> {
        let found = directory.metadata()?;
        Ok(Self {
            _directory: directory,
            device: found.dev(),
            inode: found.ino(),
            volume_id,
        })
    }

    fn hold(path: &Path, directory: OwnedFd) -> Result<Arc<Mutex<Self>>, StorageError> {
        // Without a volume ID a remounted directory stays unavailable until restart.
        let volume_id = volume_id(path).ok();
        let anchor = Self::new(directory.into(), volume_id)?;
        Ok(Arc::new(Mutex::new(anchor)))
    }

    /// Accept the directory just opened at the anchored path.
    fn admit(anchor: &Mutex<Self>, path: &Path, current: OwnedFd) -> Result<OwnedFd, StorageError> {
        let current = File::from(current);
        let found = current.metadata()?;
        let (device, inode, known) = {
            let held = anchor.lock().unwrap_or_else(PoisonError::into_inner);
            (held.device, held.inode, held.volume_id.clone())
        };
        if (found.dev(), found.ino()) != (device, inode) {
            // Another directory at this path is never adopted.
            let expected = known
                .filter(|_| found.ino() == inode)
                .ok_or(StorageError::VolumeUnavailable)?;
            if !volume_id(path)?.eq_ignore_ascii_case(&expected) {
                return Err(StorageError::VolumeUnavailable);
            }
            let adopted = Self::new(current.try_clone()?, Some(expected))?;
            *anchor.lock().unwrap_or_else(PoisonError::into_inner) = adopted;
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

    /// Verify that the configured directory is present beneath its root.
    ///
    /// # Errors
    /// Returns an error for an unavailable mount, missing directory, or redirect.
    pub fn verify(&self) -> Result<(), StorageError> {
        self.walk(&self.path, false)
    }

    /// Create missing components relative to the root without following links.
    ///
    /// # Errors
    /// Returns an error if the root or any component cannot be verified.
    pub fn ensure(&self) -> Result<(), StorageError> {
        self.walk(&self.path, true)
    }

    /// Create a child directory beneath this root without following links.
    ///
    /// # Errors
    /// Returns an error on escape, link traversal, or an unavailable root.
    pub fn ensure_child(&self, child: &Path) -> Result<(), StorageError> {
        if !child
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err(StorageError::OutsideRoot);
        }
        self.walk(&self.path.join(child), true)
    }

    fn walk(&self, path: &Path, create: bool) -> Result<(), StorageError> {
        let root = self.open_root()?;
        // Checked before anything is created, so a substitute stays untouched.
        if let Some(pin) = &self.pin {
            let found = self
                .walk_from(root.try_clone()?, &self.path, false)
                .map_err(|_| StorageError::VolumeUnavailable)?;
            Anchor::admit(pin, &self.path, found)?;
        }
        self.walk_from(root, path, create).map(drop)
    }

    fn open_root(&self) -> Result<OwnedFd, StorageError> {
        match &self.root {
            DirectoryRoot::Native => Ok(open(self.root(), DIRECTORY, Mode::empty())?),
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
                return Err(StorageError::OutsideRoot);
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
                return Err(StorageError::OutsideRoot);
            }
        }
        Ok(directory)
    }
}

fn relative<'a>(root: &Path, path: &'a Path) -> Result<&'a Path, StorageError> {
    let path = path
        .strip_prefix(root)
        .map_err(|_| StorageError::OutsideRoot)?;
    if !path
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(StorageError::OutsideRoot);
    }
    Ok(path)
}

/// The identity of the writable volume holding `path`, as the system reports it.
#[cfg(target_os = "macos")]
fn volume_id(path: &Path) -> Result<String, StorageError> {
    #[derive(Deserialize)]
    struct Info {
        #[serde(rename = "VolumeUUID")]
        volume_id: String,
        #[serde(rename = "WritableVolume")]
        writable: bool,
    }
    // `diskutil` reads a mount point, so climb to the one holding the path.
    let mut mount = path.canonicalize()?;
    let device = mount.metadata()?.dev();
    while let Some(parent) = mount.parent() {
        if parent.metadata()?.dev() != device {
            break;
        }
        mount = parent.to_path_buf();
    }
    let result = Command::new("/usr/sbin/diskutil")
        .args(["info", "-plist"])
        .arg(mount)
        .output()?;
    if !result.status.success() {
        return Err(StorageError::VolumeUnavailable);
    }
    let info: Info =
        plist::from_bytes(&result.stdout).map_err(|_| StorageError::VolumeUnavailable)?;
    if !info.writable || info.volume_id.is_empty() {
        return Err(StorageError::VolumeUnavailable);
    }
    Ok(info.volume_id)
}

#[cfg(target_os = "linux")]
fn volume_id(path: &Path) -> Result<String, StorageError> {
    #[derive(Deserialize)]
    struct ResultSet {
        filesystems: Vec<Filesystem>,
    }
    #[derive(Deserialize)]
    struct Filesystem {
        uuid: Option<String>,
        options: String,
    }
    let result = Command::new("findmnt")
        .args(["--json", "--output", "UUID,OPTIONS", "--target"])
        .arg(path.canonicalize()?)
        .output()?;
    if !result.status.success() {
        return Err(StorageError::VolumeUnavailable);
    }
    let mut parsed: ResultSet =
        serde_json::from_slice(&result.stdout).map_err(|_| StorageError::VolumeUnavailable)?;
    parsed
        .filesystems
        .pop()
        .filter(|fs| fs.options.split(',').any(|option| option == "rw"))
        .and_then(|fs| fs.uuid)
        .filter(|uuid| !uuid.is_empty())
        .ok_or(StorageError::VolumeUnavailable)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn volume_id(_: &Path) -> Result<String, StorageError> {
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
        directory.verify().unwrap();
    }
}
