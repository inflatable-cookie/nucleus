//! The local binding exchanged between the service and the ACP client.

use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// A scheduler-owned refresh of the current row, without a held turn.
pub const REFRESH_TASK_ROW: &str = "Nucleus refreshes the current task row.";
/// The scheduler keeps a parent turn available while it prepares a child.
#[must_use]
pub fn parent_hold_prompt(command: &str) -> String {
    format!("Nucleus keeps this task thread open for its next role. [{command}]")
}

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

/// Owner-only connection details for the service's Inbox on its configured host.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxBinding {
    pub session_id: String,
    pub endpoint: SocketAddr,
    pub inbox_credential: [u8; 32],
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum SessionBinding {
    Task(Binding),
    Inbox(InboxBinding),
}

impl SessionBinding {
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            Self::Task(binding) => &binding.session_id,
            Self::Inbox(binding) => &binding.session_id,
        }
    }

    #[must_use]
    pub const fn endpoint(&self) -> SocketAddr {
        match self {
            Self::Task(binding) => binding.endpoint,
            Self::Inbox(binding) => binding.endpoint,
        }
    }
}

/// A transient Inbox projection. The planning store owns the actual decision.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxSnapshot {
    pub pending: Vec<InboxForm>,
    #[serde(default)]
    pub replies_ready: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxForm {
    pub field: String,
    pub question: String,
    pub choices: Vec<InboxChoice>,
    pub offer: bool,
}

#[derive(Serialize, Deserialize)]
pub struct InboxChoice {
    pub id: String,
    pub label: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxAnswer {
    pub field: String,
    pub option_id: String,
}

/// The same immutable form identity is used in the host's pending request list.
#[must_use]
pub fn inbox_field(project: &str, id: &str) -> String {
    let digest = Sha256::new()
        .chain_update(project.as_bytes())
        .chain_update([0])
        .chain_update(id.as_bytes())
        .finalize();
    format!("nucleus_inbox_{digest:x}")
}

#[must_use]
pub fn is_inbox_field(field: &str) -> bool {
    field.strip_prefix("nucleus_inbox_").is_some_and(|digest| {
        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

#[must_use]
pub fn session_id(checkout: &Path) -> String {
    format!(
        "nucleus-{:x}",
        Sha256::digest(checkout.as_os_str().as_encoded_bytes())
    )
}
