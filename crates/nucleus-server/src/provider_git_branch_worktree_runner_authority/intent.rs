//! Durable operator effect intent records for the Git branch/worktree runner.
//!
//! The operator confirmation control commands write one record per dispatch or
//! delivery here. Runner execution reads the matching record back by
//! confirmation ref; without a durable confirmed record the chain stays
//! blocked.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use super::types::GitBranchWorktreeRunnerOperatorEffectIntent;
use crate::ServerStateService;

/// Stable record id prefix for durable operator effect intents.
pub(super) const OPERATOR_EFFECT_INTENT_PREFIX: &str =
    "git-branch-worktree-runner-operator-effect-intent:";
pub(super) const DELIVERY_INTENT_PREFIX: &str = "git-branch-worktree-runner-delivery-intent:";

/// Durable operator effect intent confirming one dispatch's isolated worktree
/// creation through the branch/worktree runner authority chain.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitBranchWorktreeRunnerOperatorEffectIntentRecord {
    pub confirmation_ref: String,
    pub run_id: String,
    pub handoff_id: String,
    pub branch_ref: String,
    pub worktree_location_ref: String,
    pub allow_primary_tree_checkout: bool,
    pub allow_isolated_worktree_creation: bool,
    pub operator_ref: String,
    pub idempotency_key: String,
    pub status: GitBranchWorktreeRunnerOperatorEffectIntentStatus,
}

/// Durable operator effect intent for one delivery's local commit and own
/// branch push. This is intentionally separate from dispatch-time intent.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitBranchWorktreeRunnerDeliveryIntentRecord {
    pub confirmation_ref: String,
    pub run_id: String,
    pub handoff_id: String,
    pub branch_ref: String,
    pub worktree_location_ref: String,
    pub commit_message: String,
    pub remote_target: String,
    pub operator_ref: String,
    pub idempotency_key: String,
    pub status: GitBranchWorktreeRunnerDeliveryIntentStatus,
}

/// Lifecycle state of a durable operator effect intent record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeRunnerOperatorEffectIntentStatus {
    Confirmed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeRunnerDeliveryIntentStatus {
    Confirmed,
}

/// Outcome of one durable intent write.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitBranchWorktreeRunnerOperatorEffectIntentWriteOutcome {
    Created(GitBranchWorktreeRunnerOperatorEffectIntentRecord),
    Replayed(GitBranchWorktreeRunnerOperatorEffectIntentRecord),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitBranchWorktreeRunnerDeliveryIntentWriteOutcome {
    Created(GitBranchWorktreeRunnerDeliveryIntentRecord),
    Replayed(GitBranchWorktreeRunnerDeliveryIntentRecord),
}

/// Write failures that are not ordinary idempotent replays.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitBranchWorktreeRunnerOperatorEffectIntentWriteError {
    /// The idempotency key is already bound to a different confirmation.
    Conflict {
        reason: String,
    },
    Storage(LocalStoreError),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitBranchWorktreeRunnerDeliveryIntentWriteError {
    Conflict { reason: String },
    Storage(LocalStoreError),
}

impl GitBranchWorktreeRunnerOperatorEffectIntentRecord {
    /// Build the dispatch authority-chain intent value from the durable record.
    pub fn into_authority_intent(self) -> GitBranchWorktreeRunnerOperatorEffectIntent {
        GitBranchWorktreeRunnerOperatorEffectIntent::Confirmed {
            confirmation_ref: self.confirmation_ref,
            allow_primary_tree_checkout: self.allow_primary_tree_checkout,
            allow_isolated_worktree_creation: self.allow_isolated_worktree_creation,
        }
    }
}

impl GitBranchWorktreeRunnerDeliveryIntentRecord {
    pub fn into_authority_intent(self) -> GitBranchWorktreeRunnerOperatorEffectIntent {
        GitBranchWorktreeRunnerOperatorEffectIntent::DeliveryConfirmed {
            confirmation_ref: self.confirmation_ref,
            branch_ref: self.branch_ref,
            worktree_location_ref: self.worktree_location_ref,
            commit_message: self.commit_message,
            remote_target: self.remote_target,
        }
    }
}

/// Write one durable dispatch confirmation, idempotent per idempotency key.
pub fn write_git_branch_worktree_runner_operator_effect_intent<B>(
    state: &ServerStateService<B>,
    record: GitBranchWorktreeRunnerOperatorEffectIntentRecord,
) -> Result<
    GitBranchWorktreeRunnerOperatorEffectIntentWriteOutcome,
    GitBranchWorktreeRunnerOperatorEffectIntentWriteError,
>
where
    B: LocalStoreBackend,
{
    let record_id = intent_record_id(&record.confirmation_ref);
    let stored = LocalStoreRecord {
        id: record_id.clone(),
        domain: PersistenceDomain::ArtifactMetadata,
        kind: PersistenceRecordKind::ArtifactMetadata,
        revision_id: RevisionId(format!("rev:{}", record_id.0)),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: encode_record(&record)?,
        },
    };
    match state
        .artifact_metadata()
        .put(stored, RevisionExpectation::MustNotExist)
    {
        Ok(_) => Ok(GitBranchWorktreeRunnerOperatorEffectIntentWriteOutcome::Created(record)),
        Err(LocalStoreError::RevisionConflict(_)) => {
            let existing = read_intent_record(state, &record_id)
                .map_err(GitBranchWorktreeRunnerOperatorEffectIntentWriteError::Storage)?
                .ok_or_else(|| {
                    GitBranchWorktreeRunnerOperatorEffectIntentWriteError::Storage(
                        LocalStoreError::InvalidRecord {
                            reason: "conflicting intent write vanished".to_owned(),
                        },
                    )
                })?;
            replay_or_conflict(existing, &record)
        }
        Err(error) => Err(GitBranchWorktreeRunnerOperatorEffectIntentWriteError::Storage(error)),
    }
}

/// Write one durable delivery confirmation, idempotent per idempotency key.
pub fn write_git_branch_worktree_runner_delivery_intent<B>(
    state: &ServerStateService<B>,
    record: GitBranchWorktreeRunnerDeliveryIntentRecord,
) -> Result<
    GitBranchWorktreeRunnerDeliveryIntentWriteOutcome,
    GitBranchWorktreeRunnerDeliveryIntentWriteError,
>
where
    B: LocalStoreBackend,
{
    let record_id = delivery_intent_record_id(&record.confirmation_ref);
    let stored = LocalStoreRecord {
        id: record_id.clone(),
        domain: PersistenceDomain::ArtifactMetadata,
        kind: PersistenceRecordKind::ArtifactMetadata,
        revision_id: RevisionId(format!("rev:{}", record_id.0)),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: serde_json::to_vec(&record).map_err(|error| {
                GitBranchWorktreeRunnerDeliveryIntentWriteError::Storage(
                    LocalStoreError::InvalidRecord {
                        reason: error.to_string(),
                    },
                )
            })?,
        },
    };
    match state
        .artifact_metadata()
        .put(stored, RevisionExpectation::MustNotExist)
    {
        Ok(_) => Ok(GitBranchWorktreeRunnerDeliveryIntentWriteOutcome::Created(
            record,
        )),
        Err(LocalStoreError::RevisionConflict(_)) => {
            let existing = read_delivery_intent_record(state, &record_id)
                .map_err(GitBranchWorktreeRunnerDeliveryIntentWriteError::Storage)?
                .ok_or_else(|| {
                    GitBranchWorktreeRunnerDeliveryIntentWriteError::Storage(
                        LocalStoreError::InvalidRecord {
                            reason: "conflicting delivery intent write vanished".to_owned(),
                        },
                    )
                })?;
            if same_delivery_effect(&existing, &record) {
                Ok(GitBranchWorktreeRunnerDeliveryIntentWriteOutcome::Replayed(
                    existing,
                ))
            } else {
                Err(GitBranchWorktreeRunnerDeliveryIntentWriteError::Conflict {
                    reason: format!(
                        "delivery intent idempotency key {} is bound to run {} handoff {} -> {}@{}",
                        record.idempotency_key,
                        existing.run_id,
                        existing.handoff_id,
                        existing.branch_ref,
                        existing.worktree_location_ref
                    ),
                })
            }
        }
        Err(error) => Err(GitBranchWorktreeRunnerDeliveryIntentWriteError::Storage(
            error,
        )),
    }
}

/// Read one durable dispatch confirmation by its confirmation ref.
pub fn read_git_branch_worktree_runner_operator_effect_intent_by_confirmation<B>(
    state: &ServerStateService<B>,
    confirmation_ref: &str,
) -> LocalStoreResult<Option<GitBranchWorktreeRunnerOperatorEffectIntentRecord>>
where
    B: LocalStoreBackend,
{
    read_intent_record(state, &intent_record_id(confirmation_ref))
}

pub fn read_git_branch_worktree_runner_delivery_intent_by_confirmation<B>(
    state: &ServerStateService<B>,
    confirmation_ref: &str,
) -> LocalStoreResult<Option<GitBranchWorktreeRunnerDeliveryIntentRecord>>
where
    B: LocalStoreBackend,
{
    read_delivery_intent_record(state, &delivery_intent_record_id(confirmation_ref))
}

pub(super) fn intent_record_id(confirmation_ref: &str) -> PersistenceRecordId {
    PersistenceRecordId(format!("{OPERATOR_EFFECT_INTENT_PREFIX}{confirmation_ref}"))
}

fn delivery_intent_record_id(confirmation_ref: &str) -> PersistenceRecordId {
    PersistenceRecordId(format!("{DELIVERY_INTENT_PREFIX}{confirmation_ref}"))
}

fn replay_or_conflict(
    existing: GitBranchWorktreeRunnerOperatorEffectIntentRecord,
    incoming: &GitBranchWorktreeRunnerOperatorEffectIntentRecord,
) -> Result<
    GitBranchWorktreeRunnerOperatorEffectIntentWriteOutcome,
    GitBranchWorktreeRunnerOperatorEffectIntentWriteError,
> {
    if same_effect(&existing, incoming) {
        return Ok(GitBranchWorktreeRunnerOperatorEffectIntentWriteOutcome::Replayed(existing));
    }
    Err(
        GitBranchWorktreeRunnerOperatorEffectIntentWriteError::Conflict {
            reason: format!(
                "operator effect intent idempotency key {} is bound to run {} handoff {} -> {}@{}",
                incoming.idempotency_key,
                existing.run_id,
                existing.handoff_id,
                existing.branch_ref,
                existing.worktree_location_ref
            ),
        },
    )
}

fn same_effect(
    existing: &GitBranchWorktreeRunnerOperatorEffectIntentRecord,
    incoming: &GitBranchWorktreeRunnerOperatorEffectIntentRecord,
) -> bool {
    existing.confirmation_ref == incoming.confirmation_ref
        && existing.run_id == incoming.run_id
        && existing.handoff_id == incoming.handoff_id
        && existing.branch_ref == incoming.branch_ref
        && existing.worktree_location_ref == incoming.worktree_location_ref
        && existing.operator_ref == incoming.operator_ref
        && existing.allow_primary_tree_checkout == incoming.allow_primary_tree_checkout
        && existing.allow_isolated_worktree_creation == incoming.allow_isolated_worktree_creation
}

fn same_delivery_effect(
    existing: &GitBranchWorktreeRunnerDeliveryIntentRecord,
    incoming: &GitBranchWorktreeRunnerDeliveryIntentRecord,
) -> bool {
    existing.confirmation_ref == incoming.confirmation_ref
        && existing.run_id == incoming.run_id
        && existing.handoff_id == incoming.handoff_id
        && existing.branch_ref == incoming.branch_ref
        && existing.worktree_location_ref == incoming.worktree_location_ref
        && existing.commit_message == incoming.commit_message
        && existing.remote_target == incoming.remote_target
        && existing.operator_ref == incoming.operator_ref
}

fn read_intent_record<B>(
    state: &ServerStateService<B>,
    record_id: &PersistenceRecordId,
) -> LocalStoreResult<Option<GitBranchWorktreeRunnerOperatorEffectIntentRecord>>
where
    B: LocalStoreBackend,
{
    let Some(record) = state.artifact_metadata().get(record_id)? else {
        return Ok(None);
    };
    serde_json::from_slice(&record.payload.bytes)
        .map(Some)
        .map_err(json_error)
}

fn read_delivery_intent_record<B>(
    state: &ServerStateService<B>,
    record_id: &PersistenceRecordId,
) -> LocalStoreResult<Option<GitBranchWorktreeRunnerDeliveryIntentRecord>>
where
    B: LocalStoreBackend,
{
    let Some(record) = state.artifact_metadata().get(record_id)? else {
        return Ok(None);
    };
    serde_json::from_slice(&record.payload.bytes)
        .map(Some)
        .map_err(json_error)
}

fn encode_record(
    record: &GitBranchWorktreeRunnerOperatorEffectIntentRecord,
) -> Result<Vec<u8>, GitBranchWorktreeRunnerOperatorEffectIntentWriteError> {
    serde_json::to_vec(record).map_err(|error| {
        GitBranchWorktreeRunnerOperatorEffectIntentWriteError::Storage(
            LocalStoreError::InvalidRecord {
                reason: error.to_string(),
            },
        )
    })
}

fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use nucleus_local_store::SqliteBackend;

    use super::*;

    fn record(
        idempotency_key: &str,
        location: &str,
    ) -> GitBranchWorktreeRunnerOperatorEffectIntentRecord {
        GitBranchWorktreeRunnerOperatorEffectIntentRecord {
            confirmation_ref: format!(
                "operator-confirmation:git-branch-worktree-runner:{idempotency_key}"
            ),
            run_id: "run:1".to_owned(),
            handoff_id: "git-branch-worktree-execution-handoff:handoff:1".to_owned(),
            branch_ref: "run/run-1".to_owned(),
            worktree_location_ref: location.to_owned(),
            allow_primary_tree_checkout: false,
            allow_isolated_worktree_creation: true,
            operator_ref: "operator:tom".to_owned(),
            idempotency_key: idempotency_key.to_owned(),
            status: GitBranchWorktreeRunnerOperatorEffectIntentStatus::Confirmed,
        }
    }

    fn delivery_record(idempotency_key: &str) -> GitBranchWorktreeRunnerDeliveryIntentRecord {
        GitBranchWorktreeRunnerDeliveryIntentRecord {
            confirmation_ref: format!(
                "operator-confirmation:git-branch-worktree-runner-delivery:{idempotency_key}"
            ),
            run_id: "run:1".to_owned(),
            handoff_id: "git-branch-worktree-execution-handoff:handoff:1".to_owned(),
            branch_ref: "run/run-1".to_owned(),
            worktree_location_ref: "../nucleus-wt/run-1".to_owned(),
            commit_message: "deliver run 1".to_owned(),
            remote_target: "origin".to_owned(),
            operator_ref: "operator:tom".to_owned(),
            idempotency_key: idempotency_key.to_owned(),
            status: GitBranchWorktreeRunnerDeliveryIntentStatus::Confirmed,
        }
    }

    fn state() -> (tempfile::TempDir, ServerStateService<SqliteBackend>) {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        (temp_dir, ServerStateService::new(backend))
    }

    #[test]
    fn durable_intent_round_trips_and_replays_by_idempotency_key() {
        let (_temp_dir, state) = state();
        let first = write_git_branch_worktree_runner_operator_effect_intent(
            &state,
            record("confirm:1", "../nucleus-wt/run-1"),
        )
        .expect("write");
        assert!(matches!(
            first,
            GitBranchWorktreeRunnerOperatorEffectIntentWriteOutcome::Created(_)
        ));
        let replay = write_git_branch_worktree_runner_operator_effect_intent(
            &state,
            record("confirm:1", "../nucleus-wt/run-1"),
        )
        .expect("replay");
        assert!(matches!(
            replay,
            GitBranchWorktreeRunnerOperatorEffectIntentWriteOutcome::Replayed(_)
        ));

        let confirmation_ref = "operator-confirmation:git-branch-worktree-runner:confirm:1";
        let read_back = read_git_branch_worktree_runner_operator_effect_intent_by_confirmation(
            &state,
            confirmation_ref,
        )
        .expect("read");
        assert_eq!(
            read_back.unwrap().into_authority_intent(),
            GitBranchWorktreeRunnerOperatorEffectIntent::Confirmed {
                confirmation_ref: confirmation_ref.to_owned(),
                allow_primary_tree_checkout: false,
                allow_isolated_worktree_creation: true,
            }
        );
    }

    #[test]
    fn durable_intent_rejects_same_key_bound_to_different_effect() {
        let (_temp_dir, state) = state();
        write_git_branch_worktree_runner_operator_effect_intent(
            &state,
            record("confirm:1", "../nucleus-wt/run-1"),
        )
        .expect("write");
        let conflict = write_git_branch_worktree_runner_operator_effect_intent(
            &state,
            record("confirm:1", "../nucleus-wt/run-other"),
        )
        .expect_err("conflict");
        assert!(matches!(
            conflict,
            GitBranchWorktreeRunnerOperatorEffectIntentWriteError::Conflict { .. }
        ));
    }

    #[test]
    fn durable_intent_missing_confirmation_reads_none() {
        let (_temp_dir, state) = state();
        let read_back = read_git_branch_worktree_runner_operator_effect_intent_by_confirmation(
            &state,
            "operator-confirmation:git-branch-worktree-runner:never",
        )
        .expect("read");
        assert!(read_back.is_none());
    }

    #[test]
    fn delivery_intent_round_trips_and_replays() {
        let (_temp_dir, state) = state();
        let first =
            write_git_branch_worktree_runner_delivery_intent(&state, delivery_record("delivery:1"))
                .expect("write");
        assert!(matches!(
            first,
            GitBranchWorktreeRunnerDeliveryIntentWriteOutcome::Created(_)
        ));
        let replay =
            write_git_branch_worktree_runner_delivery_intent(&state, delivery_record("delivery:1"))
                .expect("replay");
        assert!(matches!(
            replay,
            GitBranchWorktreeRunnerDeliveryIntentWriteOutcome::Replayed(_)
        ));
        let read_back = read_git_branch_worktree_runner_delivery_intent_by_confirmation(
            &state,
            "operator-confirmation:git-branch-worktree-runner-delivery:delivery:1",
        )
        .expect("read")
        .expect("record");
        assert_eq!(read_back.commit_message, "deliver run 1");
        assert_eq!(read_back.remote_target, "origin");
        assert!(matches!(
            read_back.into_authority_intent(),
            GitBranchWorktreeRunnerOperatorEffectIntent::DeliveryConfirmed { .. }
        ));
    }
}
