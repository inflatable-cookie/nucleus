//! Server-owned read-only spawn helper.
//!
//! This module bridges the local spawn boundary to server state. It does not
//! define a general command API, expose raw command output, or bypass the
//! host-spawn readiness gate carried by the input.

use nucleus_core::RevisionId;
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreResult, RevisionExpectation,
};

use crate::local_read_only_spawn::{run_local_read_only_spawn, LocalReadOnlySpawnInput};
use crate::state::ServerStateService;
use crate::{write_command_evidence, LocalReadOnlySpawnResult};

/// Server request for one bounded read-only spawn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerReadOnlySpawnInput {
    pub spawn: LocalReadOnlySpawnInput,
    pub evidence_revision_id: RevisionId,
    pub evidence_revision: RevisionExpectation,
}

/// Server result after the spawn boundary and evidence persistence complete.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerReadOnlySpawnResult {
    pub spawn: LocalReadOnlySpawnResult,
    pub evidence_record: LocalStoreRecord,
}

/// Run a read-only local spawn and persist sanitized command evidence.
pub fn run_server_read_only_spawn<B>(
    state: &ServerStateService<B>,
    input: ServerReadOnlySpawnInput,
) -> LocalStoreResult<ServerReadOnlySpawnResult>
where
    B: LocalStoreBackend,
{
    let spawn = run_local_read_only_spawn(input.spawn);
    let evidence_record = write_command_evidence(
        state,
        &spawn.evidence,
        input.evidence_revision_id,
        input.evidence_revision,
    )?;

    Ok(ServerReadOnlySpawnResult {
        spawn,
        evidence_record,
    })
}

/// Convert a storage error into the compact CLI-facing shape used by smoke
/// callers.
pub fn read_only_spawn_store_error(error: LocalStoreError) -> String {
    format!("{error:?}")
}

#[cfg(test)]
mod tests {
    use nucleus_command_policy::CommandExecutionStatus;
    use nucleus_core::RevisionId;
    use nucleus_local_store::{RevisionExpectation, SqliteBackend};

    use super::*;
    use crate::local_read_only_spawn_smoke::build_local_read_only_spawn_smoke_input;

    #[test]
    fn server_read_only_spawn_helper_persists_sanitized_evidence() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let input = build_local_read_only_spawn_smoke_input(crate::LocalReadOnlySpawnSmokeInput {
            project_id: nucleus_projects::ProjectId("project:smoke".to_owned()),
            execution_host_id: crate::EngineHostId("host:local".to_owned()),
            working_directory: std::env::current_dir().expect("current dir"),
            artifact_store_root: temp_dir.path().join("artifacts"),
            first_sequence: crate::ServerEventSequence(300),
            evidence_revision_id: RevisionId("rev:spawn-smoke:1".to_owned()),
            evidence_revision: RevisionExpectation::MustNotExist,
        })
        .expect("build smoke input");

        let result = run_server_read_only_spawn(&state, input).expect("run spawn");
        let json = String::from_utf8(result.evidence_record.payload.bytes).expect("json");

        assert_eq!(
            result.spawn.evidence.status,
            CommandExecutionStatus::Succeeded
        );
        assert!(json.contains("summary"));
        assert!(!json.contains("nucleus-read-only-spawn-smoke"));
        assert!(!json.contains("raw_stdout"));
        assert!(!json.contains("raw_stderr"));
    }
}
