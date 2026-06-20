//! Persistence for sanitized Git dry-run command execution records.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::{GitDryRunEvidenceCaptureRecord, GitDryRunEvidenceCaptureStatus, ServerStateService};

const GIT_DRY_RUN_EXECUTION_PREFIX: &str = "git-dry-run-execution:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitDryRunExecutionPersistenceInput {
    pub capture: GitDryRunEvidenceCaptureRecord,
    pub existing_execution_ids: Vec<String>,
    pub raw_stdout_present: bool,
    pub raw_stderr_present: bool,
    pub raw_diff_present: bool,
    pub checkout_requested: bool,
    pub branch_mutation_requested: bool,
    pub commit_requested: bool,
    pub push_requested: bool,
    pub forge_requested: bool,
    pub provider_write_requested: bool,
    pub callback_response_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitDryRunExecutionPersistenceRecord {
    pub persisted_execution_id: String,
    pub capture_id: String,
    pub handoff_id: String,
    pub request_id: String,
    pub descriptor_id: String,
    pub repo_id: String,
    pub capture_status: GitDryRunEvidenceCaptureStatus,
    pub capture_blockers: Vec<crate::GitDryRunEvidenceCaptureBlocker>,
    pub persistence_status: GitDryRunExecutionPersistenceStatus,
    pub persistence_blockers: Vec<GitDryRunExecutionPersistenceBlocker>,
    pub duplicate_execution_detected: bool,
    pub exit_code: Option<i32>,
    pub changed_path_count: usize,
    pub staged_path_count: usize,
    pub unstaged_path_count: usize,
    pub untracked_path_count: usize,
    pub insertion_count: usize,
    pub deletion_count: usize,
    pub evidence_refs: Vec<String>,
    pub git_dry_run_executed: bool,
    pub checkout_executed: bool,
    pub branch_mutation_executed: bool,
    pub commit_executed: bool,
    pub push_executed: bool,
    pub forge_effect_executed: bool,
    pub provider_write_executed: bool,
    pub callback_response_executed: bool,
    pub interruption_executed: bool,
    pub recovery_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitDryRunExecutionPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitDryRunExecutionPersistenceBlocker {
    MissingEvidenceRef,
    RawStdoutPresent,
    RawStderrPresent,
    RawDiffPresent,
    CheckoutRequested,
    BranchMutationRequested,
    CommitRequested,
    PushRequested,
    ForgeRequested,
    ProviderWriteRequested,
    CallbackResponseRequested,
    InterruptionRequested,
    RecoveryRequested,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitDryRunExecutionDiagnosticsRecord {
    pub diagnostics_id: String,
    pub execution_count: usize,
    pub completed_count: usize,
    pub failed_count: usize,
    pub timed_out_count: usize,
    pub blocked_count: usize,
    pub repair_required_count: usize,
    pub duplicate_noop_count: usize,
    pub blocker_count: usize,
    pub dry_run_executed_count: usize,
    pub checkout_executed: bool,
    pub branch_mutation_executed: bool,
    pub commit_executed: bool,
    pub push_executed: bool,
    pub forge_effect_executed: bool,
    pub provider_write_executed: bool,
    pub callback_response_executed: bool,
    pub interruption_executed: bool,
    pub recovery_executed: bool,
    pub raw_output_retained: bool,
}

pub fn persist_git_dry_run_execution<B>(
    state: &ServerStateService<B>,
    input: GitDryRunExecutionPersistenceInput,
) -> LocalStoreResult<GitDryRunExecutionPersistenceRecord>
where
    B: LocalStoreBackend,
{
    let persisted_execution_id = persisted_execution_id(&input.capture.capture_id);
    if input
        .existing_execution_ids
        .contains(&persisted_execution_id)
    {
        return Ok(persistence_record(
            input,
            persisted_execution_id,
            GitDryRunExecutionPersistenceStatus::DuplicateNoop,
            Vec::new(),
            true,
        ));
    }

    let blockers = blockers(&input);
    let status = if blockers.is_empty() {
        GitDryRunExecutionPersistenceStatus::Persisted
    } else {
        GitDryRunExecutionPersistenceStatus::Blocked
    };
    let record = persistence_record(input, persisted_execution_id, status, blockers, false);

    if record.persistence_status == GitDryRunExecutionPersistenceStatus::Persisted {
        state.artifact_metadata().put(
            LocalStoreRecord {
                id: PersistenceRecordId(record.persisted_execution_id.clone()),
                domain: PersistenceDomain::ArtifactMetadata,
                kind: PersistenceRecordKind::ArtifactMetadata,
                revision_id: RevisionId(format!("rev:{}", record.persisted_execution_id)),
                payload: json_payload(serde_json::to_vec(&record).map_err(json_error)?),
            },
            RevisionExpectation::MustNotExist,
        )?;
    }

    Ok(record)
}

pub fn read_git_dry_run_executions<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<GitDryRunExecutionPersistenceRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(GIT_DRY_RUN_EXECUTION_PREFIX))
        .map(|record| {
            serde_json::from_slice::<GitDryRunExecutionPersistenceRecord>(&record.payload.bytes)
                .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| {
        left.persisted_execution_id
            .cmp(&right.persisted_execution_id)
    });
    Ok(records)
}

pub fn git_dry_run_execution_diagnostics_from_persisted_records(
    records: Vec<GitDryRunExecutionPersistenceRecord>,
) -> GitDryRunExecutionDiagnosticsRecord {
    GitDryRunExecutionDiagnosticsRecord {
        diagnostics_id: "git-dry-run-execution-diagnostics-from-persistence".to_owned(),
        execution_count: records.len(),
        completed_count: capture_status_count(&records, GitDryRunEvidenceCaptureStatus::Completed),
        failed_count: capture_status_count(&records, GitDryRunEvidenceCaptureStatus::Failed),
        timed_out_count: capture_status_count(&records, GitDryRunEvidenceCaptureStatus::TimedOut),
        blocked_count: capture_status_count(&records, GitDryRunEvidenceCaptureStatus::Blocked),
        repair_required_count: capture_status_count(
            &records,
            GitDryRunEvidenceCaptureStatus::RepairRequired,
        ),
        duplicate_noop_count: records
            .iter()
            .filter(|record| {
                record.persistence_status == GitDryRunExecutionPersistenceStatus::DuplicateNoop
            })
            .count(),
        blocker_count: records
            .iter()
            .map(|record| record.capture_blockers.len() + record.persistence_blockers.len())
            .sum(),
        dry_run_executed_count: records
            .iter()
            .filter(|record| record.git_dry_run_executed)
            .count(),
        checkout_executed: false,
        branch_mutation_executed: false,
        commit_executed: false,
        push_executed: false,
        forge_effect_executed: false,
        provider_write_executed: false,
        callback_response_executed: false,
        interruption_executed: false,
        recovery_executed: false,
        raw_output_retained: false,
    }
}

fn persistence_record(
    input: GitDryRunExecutionPersistenceInput,
    persisted_execution_id: String,
    persistence_status: GitDryRunExecutionPersistenceStatus,
    persistence_blockers: Vec<GitDryRunExecutionPersistenceBlocker>,
    duplicate_execution_detected: bool,
) -> GitDryRunExecutionPersistenceRecord {
    GitDryRunExecutionPersistenceRecord {
        persisted_execution_id,
        capture_id: input.capture.capture_id,
        handoff_id: input.capture.handoff_id,
        request_id: input.capture.request_id,
        descriptor_id: input.capture.descriptor_id,
        repo_id: input.capture.repo_id,
        capture_status: input.capture.status,
        capture_blockers: input.capture.blockers,
        persistence_status,
        persistence_blockers,
        duplicate_execution_detected,
        exit_code: input.capture.exit_code,
        changed_path_count: input.capture.changed_path_count,
        staged_path_count: input.capture.staged_path_count,
        unstaged_path_count: input.capture.unstaged_path_count,
        untracked_path_count: input.capture.untracked_path_count,
        insertion_count: input.capture.insertion_count,
        deletion_count: input.capture.deletion_count,
        evidence_refs: unique_sorted(input.capture.evidence_refs),
        git_dry_run_executed: input.capture.git_dry_run_executed,
        checkout_executed: false,
        branch_mutation_executed: false,
        commit_executed: false,
        push_executed: false,
        forge_effect_executed: false,
        provider_write_executed: false,
        callback_response_executed: false,
        interruption_executed: false,
        recovery_executed: false,
        raw_output_retained: false,
    }
}

fn blockers(
    input: &GitDryRunExecutionPersistenceInput,
) -> Vec<GitDryRunExecutionPersistenceBlocker> {
    let mut blockers = Vec::new();
    if input.capture.evidence_refs.is_empty() {
        blockers.push(GitDryRunExecutionPersistenceBlocker::MissingEvidenceRef);
    }
    if input.raw_stdout_present {
        blockers.push(GitDryRunExecutionPersistenceBlocker::RawStdoutPresent);
    }
    if input.raw_stderr_present {
        blockers.push(GitDryRunExecutionPersistenceBlocker::RawStderrPresent);
    }
    if input.raw_diff_present {
        blockers.push(GitDryRunExecutionPersistenceBlocker::RawDiffPresent);
    }
    if input.checkout_requested {
        blockers.push(GitDryRunExecutionPersistenceBlocker::CheckoutRequested);
    }
    if input.branch_mutation_requested {
        blockers.push(GitDryRunExecutionPersistenceBlocker::BranchMutationRequested);
    }
    if input.commit_requested {
        blockers.push(GitDryRunExecutionPersistenceBlocker::CommitRequested);
    }
    if input.push_requested {
        blockers.push(GitDryRunExecutionPersistenceBlocker::PushRequested);
    }
    if input.forge_requested {
        blockers.push(GitDryRunExecutionPersistenceBlocker::ForgeRequested);
    }
    if input.provider_write_requested {
        blockers.push(GitDryRunExecutionPersistenceBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested {
        blockers.push(GitDryRunExecutionPersistenceBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested {
        blockers.push(GitDryRunExecutionPersistenceBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(GitDryRunExecutionPersistenceBlocker::RecoveryRequested);
    }
    blockers
}

fn capture_status_count(
    records: &[GitDryRunExecutionPersistenceRecord],
    status: GitDryRunEvidenceCaptureStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.capture_status == status)
        .count()
}

fn persisted_execution_id(capture_id: &str) -> String {
    format!("{GIT_DRY_RUN_EXECUTION_PREFIX}{capture_id}")
}

fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_local_store::SqliteBackend;

    #[test]
    fn git_dry_run_execution_persistence_records_round_trip_sanitized_record() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(db.clone()));

        let record =
            persist_git_dry_run_execution(&state, input(capture("1", true))).expect("persist");

        let reopened = ServerStateService::new(SqliteBackend::new(db));
        let records = read_git_dry_run_executions(&reopened).expect("read");

        assert_eq!(records, vec![record]);
        assert_eq!(records[0].changed_path_count, 3);
        assert_eq!(records[0].insertion_count, 12);
        assert_eq!(records[0].evidence_refs, vec!["evidence:capture"]);
        assert!(records[0].git_dry_run_executed);
        assert!(!records[0].commit_executed);
        assert!(!records[0].raw_output_retained);
    }

    #[test]
    fn git_dry_run_execution_state_api_reads_records_in_stable_order() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

        persist_git_dry_run_execution(&state, input(capture("b", false))).expect("persist b");
        persist_git_dry_run_execution(&state, input(capture("a", false))).expect("persist a");

        let records = read_git_dry_run_executions(&state).expect("read");

        assert_eq!(records[0].capture_id, "capture:a");
        assert_eq!(records[1].capture_id, "capture:b");
    }

    #[test]
    fn git_dry_run_execution_duplicate_blocked_preserves_terminal_outcomes() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

        let failed = persist_git_dry_run_execution(
            &state,
            input(capture_with_status(
                "failed",
                GitDryRunEvidenceCaptureStatus::Failed,
            )),
        )
        .expect("persist failed");
        let repair = persist_git_dry_run_execution(
            &state,
            input(capture_with_status(
                "repair",
                GitDryRunEvidenceCaptureStatus::RepairRequired,
            )),
        )
        .expect("persist repair");
        let duplicate = persist_git_dry_run_execution(
            &state,
            GitDryRunExecutionPersistenceInput {
                existing_execution_ids: vec![failed.persisted_execution_id.clone()],
                ..input(capture_with_status(
                    "failed",
                    GitDryRunEvidenceCaptureStatus::Completed,
                ))
            },
        )
        .expect("duplicate");

        assert_eq!(
            failed.capture_status,
            GitDryRunEvidenceCaptureStatus::Failed
        );
        assert_eq!(
            repair.capture_status,
            GitDryRunEvidenceCaptureStatus::RepairRequired
        );
        assert_eq!(
            duplicate.persistence_status,
            GitDryRunExecutionPersistenceStatus::DuplicateNoop
        );
        assert!(duplicate.duplicate_execution_detected);
    }

    #[test]
    fn git_dry_run_execution_duplicate_blocked_blocks_raw_or_external_requests() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
        let mut input = input(capture("blocked", true));
        input.raw_stdout_present = true;
        input.raw_diff_present = true;
        input.commit_requested = true;
        input.forge_requested = true;

        let record = persist_git_dry_run_execution(&state, input).expect("blocked");

        assert_eq!(
            record.persistence_status,
            GitDryRunExecutionPersistenceStatus::Blocked
        );
        assert!(record
            .persistence_blockers
            .contains(&GitDryRunExecutionPersistenceBlocker::RawStdoutPresent));
        assert!(record
            .persistence_blockers
            .contains(&GitDryRunExecutionPersistenceBlocker::CommitRequested));
        assert!(!record.commit_executed);
        assert!(!record.raw_output_retained);
    }

    #[test]
    fn git_dry_run_execution_diagnostics_source_summarizes_persisted_records() {
        let diagnostics = git_dry_run_execution_diagnostics_from_persisted_records(vec![
            persisted("completed", GitDryRunEvidenceCaptureStatus::Completed, true),
            persisted("failed", GitDryRunEvidenceCaptureStatus::Failed, false),
            persisted("timeout", GitDryRunEvidenceCaptureStatus::TimedOut, false),
            persisted("blocked", GitDryRunEvidenceCaptureStatus::Blocked, false),
            persisted(
                "repair",
                GitDryRunEvidenceCaptureStatus::RepairRequired,
                false,
            ),
        ]);

        assert_eq!(diagnostics.execution_count, 5);
        assert_eq!(diagnostics.completed_count, 1);
        assert_eq!(diagnostics.failed_count, 1);
        assert_eq!(diagnostics.timed_out_count, 1);
        assert_eq!(diagnostics.blocked_count, 1);
        assert_eq!(diagnostics.repair_required_count, 1);
        assert_eq!(diagnostics.dry_run_executed_count, 1);
        assert!(!diagnostics.commit_executed);
        assert!(!diagnostics.raw_output_retained);
    }

    fn input(capture: GitDryRunEvidenceCaptureRecord) -> GitDryRunExecutionPersistenceInput {
        GitDryRunExecutionPersistenceInput {
            capture,
            existing_execution_ids: Vec::new(),
            raw_stdout_present: false,
            raw_stderr_present: false,
            raw_diff_present: false,
            checkout_requested: false,
            branch_mutation_requested: false,
            commit_requested: false,
            push_requested: false,
            forge_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        }
    }

    fn capture(id: &str, git_dry_run_executed: bool) -> GitDryRunEvidenceCaptureRecord {
        capture_with_status_and_execution(
            id,
            GitDryRunEvidenceCaptureStatus::Completed,
            git_dry_run_executed,
        )
    }

    fn capture_with_status(
        id: &str,
        status: GitDryRunEvidenceCaptureStatus,
    ) -> GitDryRunEvidenceCaptureRecord {
        capture_with_status_and_execution(id, status, false)
    }

    fn capture_with_status_and_execution(
        id: &str,
        status: GitDryRunEvidenceCaptureStatus,
        git_dry_run_executed: bool,
    ) -> GitDryRunEvidenceCaptureRecord {
        GitDryRunEvidenceCaptureRecord {
            capture_id: format!("capture:{id}"),
            handoff_id: format!("handoff:{id}"),
            request_id: format!("request:{id}"),
            descriptor_id: "git-dry-run-diff-stat".to_owned(),
            repo_id: "repo:1".to_owned(),
            status,
            blockers: Vec::new(),
            exit_code: Some(0),
            changed_path_count: 3,
            staged_path_count: 1,
            unstaged_path_count: 1,
            untracked_path_count: 1,
            insertion_count: 12,
            deletion_count: 4,
            evidence_refs: vec!["evidence:capture".to_owned(), "evidence:capture".to_owned()],
            git_dry_run_executed,
            git_mutation_executed: false,
            forge_effect_executed: false,
            provider_write_executed: false,
            callback_response_executed: false,
            interruption_executed: false,
            recovery_executed: false,
            raw_output_retained: false,
        }
    }

    fn persisted(
        id: &str,
        status: GitDryRunEvidenceCaptureStatus,
        git_dry_run_executed: bool,
    ) -> GitDryRunExecutionPersistenceRecord {
        GitDryRunExecutionPersistenceRecord {
            persisted_execution_id: format!("persisted:{id}"),
            capture_id: format!("capture:{id}"),
            handoff_id: format!("handoff:{id}"),
            request_id: format!("request:{id}"),
            descriptor_id: "git-dry-run-diff-stat".to_owned(),
            repo_id: "repo:1".to_owned(),
            capture_status: status,
            capture_blockers: Vec::new(),
            persistence_status: GitDryRunExecutionPersistenceStatus::Persisted,
            persistence_blockers: Vec::new(),
            duplicate_execution_detected: false,
            exit_code: Some(0),
            changed_path_count: 1,
            staged_path_count: 0,
            unstaged_path_count: 1,
            untracked_path_count: 0,
            insertion_count: 0,
            deletion_count: 0,
            evidence_refs: vec!["evidence:capture".to_owned()],
            git_dry_run_executed,
            checkout_executed: false,
            branch_mutation_executed: false,
            commit_executed: false,
            push_executed: false,
            forge_effect_executed: false,
            provider_write_executed: false,
            callback_response_executed: false,
            interruption_executed: false,
            recovery_executed: false,
            raw_output_retained: false,
        }
    }
}
