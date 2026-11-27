use std::path::PathBuf;

use nix::fcntl::{FcntlArg, fcntl};
use rustix::fs::{Mode, OFlags, fstat, open};
use tokio::{task::JoinSet, time};

use super::DEADLINE;

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
