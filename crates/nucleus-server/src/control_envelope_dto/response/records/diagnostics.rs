use serde::{Deserialize, Serialize};

use crate::control_api::{ServerDiagnosticsQueryResult, ServerDiagnosticsSnapshot};
use crate::diagnostics_read_models::{
    CodexProviderDiagnosticsDto, EffigyDiagnosticsDto, ScmSessionDiagnosticsDto,
    StewardDiagnosticsDto, SyncDiagnosticsDto, TaskAgentDiagnosticsDto,
};

/// Serializable diagnostics query result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "domain", content = "record", rename_all = "snake_case")]
pub enum ControlDiagnosticsResultDto {
    Steward(StewardDiagnosticsDto),
    Effigy(EffigyDiagnosticsDto),
    ManagementSync(SyncDiagnosticsDto),
    ScmSession(ScmSessionDiagnosticsDto),
    TaskAgent(TaskAgentDiagnosticsDto),
    CodexProvider(CodexProviderDiagnosticsDto),
    All(ControlDiagnosticsSnapshotDto),
}

/// Serializable combined diagnostics snapshot.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlDiagnosticsSnapshotDto {
    pub steward: StewardDiagnosticsDto,
    pub effigy: EffigyDiagnosticsDto,
    pub management_sync: SyncDiagnosticsDto,
    pub scm_session: ScmSessionDiagnosticsDto,
    pub task_agent: TaskAgentDiagnosticsDto,
    pub codex_provider: CodexProviderDiagnosticsDto,
}

impl From<&ServerDiagnosticsQueryResult> for ControlDiagnosticsResultDto {
    fn from(result: &ServerDiagnosticsQueryResult) -> Self {
        match result {
            ServerDiagnosticsQueryResult::Steward(record) => Self::Steward(record.clone()),
            ServerDiagnosticsQueryResult::Effigy(record) => Self::Effigy(record.clone()),
            ServerDiagnosticsQueryResult::ManagementSync(record) => {
                Self::ManagementSync(record.clone())
            }
            ServerDiagnosticsQueryResult::ScmSession(record) => Self::ScmSession(record.clone()),
            ServerDiagnosticsQueryResult::TaskAgent(record) => Self::TaskAgent(record.clone()),
            ServerDiagnosticsQueryResult::CodexProvider(record) => {
                Self::CodexProvider(record.clone())
            }
            ServerDiagnosticsQueryResult::All(snapshot) => {
                Self::All(ControlDiagnosticsSnapshotDto::from(snapshot))
            }
        }
    }
}

impl From<&ServerDiagnosticsSnapshot> for ControlDiagnosticsSnapshotDto {
    fn from(snapshot: &ServerDiagnosticsSnapshot) -> Self {
        Self {
            steward: snapshot.steward.clone(),
            effigy: snapshot.effigy.clone(),
            management_sync: snapshot.management_sync.clone(),
            scm_session: snapshot.scm_session.clone(),
            task_agent: snapshot.task_agent.clone(),
            codex_provider: snapshot.codex_provider.clone(),
        }
    }
}
