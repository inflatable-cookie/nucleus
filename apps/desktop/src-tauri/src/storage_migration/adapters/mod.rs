mod sqlite;
mod tree;
mod ui;

use longhorn_config::{BackupAdapterError, Sha256Digest};

pub(super) use sqlite::SqliteTransitionAdapter;
pub(super) use tree::TreeTransitionAdapter;
pub(super) use ui::UiTransitionAdapter;

fn payload_digest(entries: &[(String, Vec<u8>)]) -> Sha256Digest {
    let mut evidence = b"nucleus-storage-payload-v1\0".to_vec();
    for (path, bytes) in entries {
        evidence.extend_from_slice(&(path.len() as u64).to_be_bytes());
        evidence.extend_from_slice(path.as_bytes());
        evidence.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
        evidence.extend_from_slice(bytes);
    }
    Sha256Digest::from_bytes(&evidence)
}

fn failure(code: &str) -> BackupAdapterError {
    BackupAdapterError::failed(code).expect("static adapter failure code")
}
