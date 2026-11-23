//! The local binding exchanged between the service and the ACP client.

use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Owner-only connection details for one task session.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub session_id: String,
    pub task_id: String,
    pub endpoint: SocketAddr,
    pub credential: [u8; 32],
    pub command_credential: Option<[u8; 32]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scratch_dir: Option<PathBuf>,
}

#[must_use]
pub fn session_id(checkout: &Path) -> String {
    format!(
        "nucleus-{:x}",
        Sha256::digest(checkout.as_os_str().as_encoded_bytes())
    )
}
