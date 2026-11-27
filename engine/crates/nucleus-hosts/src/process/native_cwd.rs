use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Instant,
};

use nix::fcntl::{FcntlArg, fcntl};
use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags, fstat, open, openat, stat, statat};
use tokio::{task::JoinSet, time};

use super::DEADLINE;

const DIRECTORY: OFlags = OFlags::RDONLY
    .union(OFlags::CLOEXEC)
    .union(OFlags::DIRECTORY)
    .union(OFlags::NONBLOCK)
    .union(OFlags::NOFOLLOW);
const MAX_ENTRIES: usize = 100_000;

pub(super) async fn directory_devices(root: &Path) -> Option<HashSet<u32>> {
    let root = root.to_path_buf();
    let deadline = Instant::now() + DEADLINE;
    let walk = tokio::task::spawn_blocking(move || devices_below(&root, deadline));
    time::timeout(DEADLINE, walk).await.ok()?.ok()?
}

fn devices_below(root: &Path, deadline: Instant) -> Option<HashSet<u32>> {
    let fd = open(root, DIRECTORY, Mode::empty()).ok()?;
    let initial = fstat(&fd).ok()?;
    let mut devices = HashSet::from([u32::from_ne_bytes(initial.st_dev.to_ne_bytes())]);
    let mut stack = vec![Dir::new(fd).ok()?];
    let mut remaining = MAX_ENTRIES;
    // Include nested mounts. A root's device alone says nothing about them.
    // Directory descriptors keep the walk inside the root without symlinks.
    while let Some(dir) = stack.last_mut() {
        let Some(entry) = dir.next() else {
            stack.pop();
            continue;
        };
        remaining = remaining.checked_sub(1)?;
        if Instant::now() >= deadline {
            return None;
        }
        let entry = entry.ok()?;
        let name = entry.file_name();
        if matches!(name.to_bytes(), b"." | b"..") {
            continue;
        }
        let kind = match entry.file_type() {
            FileType::Unknown => FileType::from_raw_mode(
                statat(dir.fd().ok()?, name, AtFlags::SYMLINK_NOFOLLOW)
                    .ok()?
                    .st_mode,
            ),
            kind => kind,
        };
        if kind == FileType::Directory {
            let child = openat(dir.fd().ok()?, name, DIRECTORY, Mode::empty()).ok()?;
            devices.insert(u32::from_ne_bytes(fstat(&child).ok()?.st_dev.to_ne_bytes()));
            stack.push(Dir::new(child).ok()?);
        }
    }
    let final_root = stat(root).ok()?;
    (final_root.st_dev == initial.st_dev && final_root.st_ino == initial.st_ino).then_some(devices)
}

pub(super) async fn recover(cwds: Vec<(u32, u32, u64)>) -> Vec<(u32, PathBuf)> {
    let mut reads = JoinSet::new();
    for (pid, dev, inode) in cwds {
        reads.spawn_blocking(move || Some((pid, directory_path(dev, inode)?)));
    }
    let deadline = time::Instant::now() + DEADLINE;
    let mut paths = Vec::new();
    while let Ok(Some(result)) = time::timeout_at(deadline, reads.join_next()).await {
        if let Ok(Some(path)) = result {
            paths.push(path);
        }
    }
    paths
}

fn directory_path(dev: u32, inode: u64) -> Option<PathBuf> {
    // Resolve the same directory independently of lsof's path rendering.
    let dir = open(
        format!("/.vol/{dev}/{inode}"),
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::DIRECTORY | OFlags::NONBLOCK,
        Mode::empty(),
    )
    .ok()?;
    let found = fstat(&dir).ok()?;
    if (u32::from_ne_bytes(found.st_dev.to_ne_bytes()), found.st_ino) != (dev, inode) {
        return None;
    }
    let mut path = PathBuf::new();
    fcntl(&dir, FcntlArg::F_GETPATH(&mut path)).ok()?;
    path.is_absolute().then_some(path)
}
