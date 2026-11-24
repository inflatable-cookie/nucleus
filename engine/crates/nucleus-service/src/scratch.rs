//! Socket-sized scratch directories bound to the immutable run reservation.

use std::{
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};

use nucleus_core::PreparedLaunch;
use nucleus_store::StorageDirectory;
use sha2::{Digest, Sha256};

use crate::ServiceError;

pub(super) fn relative_path(instance: &str) -> PathBuf {
    let digest = Sha256::digest(instance.as_bytes());
    Path::new("r").join(hex::encode(&digest[..6]))
}

pub(super) fn bound_path(
    root: &Path,
    task: &str,
    instance: &str,
    recorded: Option<&Path>,
) -> PathBuf {
    if let Some(path) = recorded {
        return path.to_owned();
    }
    let path = root.join(task).join(instance);
    let legacy = root.join("run-scratch").join(instance);
    if path.exists() || !legacy.exists() {
        path
    } else {
        legacy
    }
}

pub(super) fn allocate(
    root: &StorageDirectory,
    launch: &PreparedLaunch,
) -> Result<(), ServiceError> {
    let relative = relative_path(&launch.instance);
    let directory = root.path().join(&relative);
    if launch.scratch.as_ref() != Some(&directory) {
        return Err(ServiceError::Ticket);
    }
    root.ensure_child(&relative)?;
    claim(&directory, &launch.instance)
}

// A short digest can collide. A no-clobber claim permits a retry of this
// reservation without ever handing the same directory to a different run.
fn claim(directory: &Path, instance: &str) -> Result<(), ServiceError> {
    let marker = directory.join(".nucleus-run");
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    file.write_all(instance.as_bytes())?;
    file.as_file().sync_all()?;
    match file.persist_noclobber(&marker) {
        Ok(_) => {
            fs::File::open(directory)?.sync_all()?;
            Ok(())
        }
        Err(error) if error.error.kind() == ErrorKind::AlreadyExists => {
            if fs::read(marker)? == instance.as_bytes() {
                Ok(())
            } else {
                Err(ServiceError::RunScratchConflict)
            }
        }
        Err(error) => Err(error.error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assigned_path_leaves_room_for_a_broker_socket() {
        // The fixture root has the same 30-byte length as the mounted Stash root.
        let root = Path::new("/fixture/store/scratch/nucleus");
        let instance = "task-t-0123456789abcdef0123456789abcdef-run-1";
        let relative = relative_path(instance);
        assert_eq!(relative.file_name().unwrap().len(), 12);
        assert_ne!(
            relative,
            relative_path("task-t-0123456789abcdef0123456789abcdef-run-2")
        );
        let socket = root.join(relative).join("oxide-broker-012345.sock");
        assert!(socket.as_os_str().as_encoded_bytes().len() <= 103);
    }

    #[test]
    fn a_recorded_directory_survives_a_root_change_and_legacy_runs_keep_their_layout() {
        let current = tempfile::tempdir().unwrap();
        let root = current.path();
        let instance = "task-example-run-1";
        let nested = root.join("example").join(instance);
        let legacy = root.join("run-scratch").join(instance);
        assert_eq!(bound_path(root, "example", instance, None), nested);
        fs::create_dir_all(&legacy).unwrap();
        assert_eq!(bound_path(root, "example", instance, None), legacy);
        fs::create_dir_all(&nested).unwrap();
        assert_eq!(bound_path(root, "example", instance, None), nested);
        let recorded = Path::new("/previous/scratch/r/abcdef001122");
        assert_eq!(
            bound_path(root, "example", instance, Some(recorded)),
            recorded
        );
    }

    #[test]
    fn a_colliding_run_cannot_take_over_claimed_scratch() {
        let scratch = tempfile::tempdir().unwrap();
        claim(scratch.path(), "task-example-run-1").unwrap();
        claim(scratch.path(), "task-example-run-1").unwrap();
        assert!(matches!(
            claim(scratch.path(), "task-other-run-1"),
            Err(ServiceError::RunScratchConflict)
        ));
    }
}
