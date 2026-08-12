//! Terminal wire types: open request, session snapshot, and runtime events.
//!
//! Split from the terminal_runtime god file; behavior unchanged.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

pub type TerminalEventSink = Arc<dyn Fn(TerminalEvent) + Send + Sync + 'static>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenRequest {
    pub project_id: String,
    pub panel_id: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionSnapshot {
    pub session_id: String,
    pub project_id: String,
    pub panel_id: String,
    pub resource_id: Option<String>,
    pub authoritative_host_id: String,
    pub rows: u16,
    pub cols: u16,
    pub attached: bool,
    pub exited: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output {
        session_id: String,
        sequence: u64,
        data: Vec<u8>,
    },
    Exited {
        session_id: String,
        exit_code: Option<u32>,
        signal: Option<String>,
    },
    Diagnostic {
        session_id: String,
        message: String,
    },
}
