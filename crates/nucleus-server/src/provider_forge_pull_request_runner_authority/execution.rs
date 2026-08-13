//! Gated forge pull-request creation execution.
//!
//! This is the execution path the forge pull-request runner authority chain
//! gates: one operator-confirmed per-delivery PR-creation intent plus an
//! admitted forge preflight reaches `ReadyForCreation`, and only then may the
//! admitted forge adapter open one pull request for the run's own pushed
//! branch. Idempotency reconciles against provider state before any open: a
//! persisted completed or reconciled outcome replays without a provider call,
//! and an existing pull request for the head branch is adopted (reconciled
//! outcome) before a new open is attempted.
//!
//! Fallbacks keep the branch-only delivery standing with an explaining
//! receipt: no remote, no ready credential (preflight blocked), or a PR API
//! failure records a failed/blocked outcome and a contract-020 receipt, and
//! the run stays delivered on its pushed branch. Nothing executes without the
//! durable confirmed intent; a duplicate or uncertain write never opens a
//! second PR blindly.

use std::time::Duration;

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use super::forge_adapter::{
    ForgePullRequestCreationAdapter, ForgePullRequestCreationError,
    ForgePullRequestCreationReference, ForgePullRequestCreationRequest,
    ForgePullRequestCreationTestDouble,
};
use super::types::{
    ForgePullRequestCreationScope, ForgePullRequestRunnerAuthorityInput,
    ForgePullRequestRunnerAuthorityRecord, ForgePullRequestRunnerAuthoritySet,
    ForgePullRequestRunnerOperatorEffectIntent,
};
use crate::provider_git_branch_worktree_runner_authority::{
    read_git_branch_worktree_runner_delivery_intent_by_confirmation,
    GitBranchWorktreeRunnerDeliveryIntentRecord,
};
use crate::runtime_receipt_state::write_runtime_receipt;
use crate::{
    forge_pull_request_runner_authority, ForgePullRequestExecutionPreflightSet,
    ForgePullRequestProvider, ForgePullRequestTextSource, ServerStateService,
};

/// One gated PR-creation execution: one operator-confirmed per-delivery
/// intent, one admitted forge preflight set, one admitted adapter route.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgePullRequestCreationExecutionInput<A> {
    /// Durable delivery intent lookup key written by the confirmation control
    /// command. Missing intent or missing PR-creation scope -> `CommandNotReady`,
    /// no forge call.
    pub confirmation_ref: String,
    /// Admitted forge preflight set: credential readiness, remote-branch
    /// visibility, and target refs matching the prepared evidence.
    pub preflights: ForgePullRequestExecutionPreflightSet,
    /// Run identity for outcomes and receipts.
    pub run_id: String,
    /// Operator identity from the durable confirmation.
    pub operator_ref: String,
    /// Idempotency key from the durable confirmation.
    pub idempotency_key: String,
    /// Deadline bound for the admitted adapter route.
    pub timeout: Duration,
    /// Admitted forge adapter executing the PR-open write (the forge test
    /// double in the first implementation).
    pub adapter: A,
}

/// Sanitized PR-creation execution result. The run stays delivered on its
/// pushed branch regardless of `pull_request_failed`; the receipt explains
/// the fallback.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgePullRequestCreationExecutionResult {
    pub authority: ForgePullRequestRunnerAuthoritySet,
    pub outcome: ForgePullRequestCreationOutcomeRecord,
    pub replayed: bool,
    pub reconciled: bool,
    pub pull_request_created: bool,
    pub pull_request_failed: bool,
    pub pull_request_reference: Option<String>,
    pub pull_request_url: Option<String>,
}

/// Execution failures that are not delivery fallbacks: missing intent or
/// missing scope (caller error), or storage failure. Everything else records
/// an outcome and an explaining receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ForgePullRequestCreationExecutionError {
    CommandNotReady { reason: String },
    Persistence(LocalStoreError),
}

/// Run the gated forge pull-request creation lane.
///
/// Invariant: a durable operator-confirmed per-delivery intent carrying
/// PR-creation scope plus an admitted forge preflight are both required
/// before the adapter may open a pull request. Idempotency replays a
/// persisted completed/reconciled outcome without any provider call, then
/// reconciles against provider state (adopt an existing PR for the head
/// branch) before the admitted open. Fallbacks — no remote, preflight
/// blocked, reconciliation failure, or PR API failure — persist an explaining
/// outcome and receipt; the branch-only delivery stands.
pub fn run_forge_pull_request_creation<B, A>(
    state: &ServerStateService<B>,
    input: ForgePullRequestCreationExecutionInput<A>,
) -> Result<ForgePullRequestCreationExecutionResult, ForgePullRequestCreationExecutionError>
where
    B: LocalStoreBackend,
    A: ForgePullRequestCreationAdapter,
{
    let delivery_intent = read_git_branch_worktree_runner_delivery_intent_by_confirmation(
        state,
        &input.confirmation_ref,
    )
    .map_err(ForgePullRequestCreationExecutionError::Persistence)?
    .ok_or_else(|| ForgePullRequestCreationExecutionError::CommandNotReady {
        reason: "delivery intent disappeared before pull-request creation".to_owned(),
    })?;
    let Some(scope) = delivery_intent.pull_request_creation.clone() else {
        return Err(ForgePullRequestCreationExecutionError::CommandNotReady {
            reason: "delivery intent carries no confirmed pull-request creation scope".to_owned(),
        });
    };

    let authority = forge_pull_request_runner_authority(ForgePullRequestRunnerAuthorityInput {
        preflights: input.preflights.clone(),
        operator_effect_intent:
            ForgePullRequestRunnerOperatorEffectIntent::PullRequestCreationConfirmed {
                confirmation_ref: delivery_intent.confirmation_ref.clone(),
                scope: scope.clone(),
            },
        raw_output_retention_requested: false,
        pull_request_creation_requested: true,
        forge_effect_requested: true,
        provider_effect_requested: false,
        callback_effect_requested: false,
        interruption_effect_requested: false,
        recovery_effect_requested: false,
        task_mutation_requested: false,
    });

    // Idempotency replay: a persisted completed or reconciled outcome is the
    // effect. Never open a second PR and never call the provider again.
    let existing = read_forge_pull_request_creation_outcome_by_confirmation(
        state,
        &input.confirmation_ref,
    )
    .map_err(ForgePullRequestCreationExecutionError::Persistence)?;
    if let Some(existing) = &existing {
        if matches!(
            existing.outcome_status,
            ForgePullRequestCreationOutcomeStatus::Completed
                | ForgePullRequestCreationOutcomeStatus::Reconciled
        ) {
            return Ok(ForgePullRequestCreationExecutionResult {
                authority,
                outcome: existing.clone(),
                replayed: true,
                reconciled: existing.reconciled,
                pull_request_created: existing.pull_request_created,
                pull_request_failed: false,
                pull_request_reference: existing.pull_request_reference.clone(),
                pull_request_url: existing.pull_request_url.clone(),
            });
        }
    }

    let authority_record = authority
        .authorities
        .iter()
        .find(|record| record.pull_request_creation_permitted)
        .or_else(|| authority.authorities.first())
        .cloned();

    let request = ForgePullRequestCreationRequest {
        run_id: input.run_id.clone(),
        remote_target: delivery_intent.remote_target.clone(),
        forge_provider: scope.forge_provider.clone(),
        base_branch: scope.base_branch.clone(),
        head_branch: scope.head_branch.clone(),
        title_source: scope.title_source.clone(),
        body_source: scope.body_source.clone(),
    };

    // Fallback: no confirmed remote keeps the branch-only delivery with an
    // explaining receipt. No adapter call.
    if delivery_intent.remote_target.trim().is_empty() {
        let outcome = outcome_record(
            authority_record.as_ref(),
            &input,
            &delivery_intent,
            &scope,
            ForgePullRequestCreationOutcomeStatus::Failed,
            false,
            true,
            false,
            None,
            "no confirmed remote; branch-only delivery preserved".to_owned(),
        );
        persist_and_receipt(state, &input, &outcome)?;
        return Ok(result_from_outcome(authority, outcome));
    }

    // Authority gate: preflight failures (no ready credential, remote branch
    // not visible) and scope drift block before any adapter call and are
    // recorded as a Blocked outcome with an explaining receipt.
    if !authority.pull_request_creation_permitted {
        let explanation = blocked_explanation(&authority, &input.preflights);
        let outcome = outcome_record(
            authority_record.as_ref(),
            &input,
            &delivery_intent,
            &scope,
            ForgePullRequestCreationOutcomeStatus::Blocked,
            false,
            true,
            false,
            None,
            explanation,
        );
        persist_and_receipt(state, &input, &outcome)?;
        return Ok(result_from_outcome(authority, outcome));
    }

    // Idempotency reconciliation against provider state: adopt an existing
    // pull request for the head branch before any new open. A reconciliation
    // failure blocks the open (a blind open could duplicate); the explaining
    // receipt keeps the branch-only delivery standing.
    let reconciled_reference = match input.adapter.find_existing_pull_request(&request) {
        Ok(Some(reference)) => Some(reference),
        Ok(None) => None,
        Err(error) => {
            let outcome = outcome_record(
                authority_record.as_ref(),
                &input,
                &delivery_intent,
                &scope,
                ForgePullRequestCreationOutcomeStatus::Failed,
                false,
                true,
                false,
                None,
                format!("provider-state reconciliation failed: {}", error.reason()),
            );
            persist_and_receipt(state, &input, &outcome)?;
            return Ok(result_from_outcome(authority, outcome));
        }
    };
    if let Some(reference) = &reconciled_reference {
        let outcome = outcome_record(
            authority_record.as_ref(),
            &input,
            &delivery_intent,
            &scope,
            ForgePullRequestCreationOutcomeStatus::Reconciled,
            false,
            false,
            true,
            Some(reference),
            "existing pull request adopted; no duplicate opened".to_owned(),
        );
        persist_and_receipt(state, &input, &outcome)?;
        return Ok(result_from_outcome(authority, outcome));
    }

    // The admitted open call, only after reconciliation found no existing PR.
    match input.adapter.open_pull_request(&request) {
        Ok(reference) => {
            let outcome = outcome_record(
                authority_record.as_ref(),
                &input,
                &delivery_intent,
                &scope,
                ForgePullRequestCreationOutcomeStatus::Completed,
                true,
                false,
                false,
                Some(&reference),
                "pull request opened".to_owned(),
            );
            persist_and_receipt(state, &input, &outcome)?;
            Ok(result_from_outcome(authority, outcome))
        }
        Err(error) => {
            let outcome = outcome_record(
                authority_record.as_ref(),
                &input,
                &delivery_intent,
                &scope,
                ForgePullRequestCreationOutcomeStatus::Failed,
                false,
                true,
                false,
                None,
                format!("pull-request API failure: {}", error.reason()),
            );
            persist_and_receipt(state, &input, &outcome)?;
            Ok(result_from_outcome(authority, outcome))
        }
    }
}

impl ForgePullRequestCreationError {
    fn reason(&self) -> &str {
        match self {
            Self::ApiFailure { reason } | Self::ProviderUnavailable { reason } => reason,
        }
    }
}

fn blocked_explanation(
    authority: &ForgePullRequestRunnerAuthoritySet,
    preflights: &ForgePullRequestExecutionPreflightSet,
) -> String {
    let mut parts = authority
        .authorities
        .iter()
        .flat_map(|record| record.blockers.iter().map(|blocker| format!("{blocker:?}")))
        .collect::<Vec<_>>();
    for preflight in &preflights.preflights {
        if preflight.status != crate::ForgePullRequestExecutionPreflightStatus::Ready {
            parts.extend(
                preflight
                    .blockers
                    .iter()
                    .map(|blocker| format!("{blocker:?}")),
            );
        }
    }
    parts.sort();
    parts.dedup();
    if parts.is_empty() {
        "forge pull-request creation did not reach ReadyForCreation".to_owned()
    } else {
        format!(
            "forge pull-request creation blocked: {}; branch-only delivery preserved",
            parts.join(", ")
        )
    }
}

/// Durable sanitized outcome of one PR-creation execution attempt. This
/// record admits the effect it observed: `pull_request_created` and
/// `forge_effect_executed` flip only when the adapter open succeeded. It
/// never embeds a no-effects claim.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgePullRequestCreationOutcomeRecord {
    pub persisted_outcome_id: String,
    pub confirmation_ref: String,
    pub authority_id: String,
    pub preflight_id: String,
    pub admission_id: String,
    pub run_id: String,
    pub operator_ref: String,
    pub operator_confirmation_ref: String,
    pub remote_target: String,
    pub forge_provider: Option<ForgePullRequestProvider>,
    pub base_branch: Option<String>,
    pub head_branch: Option<String>,
    pub title_source: Option<ForgePullRequestTextSource>,
    pub body_source: Option<ForgePullRequestTextSource>,
    pub outcome_status: ForgePullRequestCreationOutcomeStatus,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub pull_request_failed: bool,
    pub reconciled: bool,
    pub pull_request_reference: Option<String>,
    pub pull_request_url: Option<String>,
    /// Explaining reason for failed/blocked outcomes (sanitized; no raw
    /// provider payloads). `None` for completed/reconciled outcomes.
    pub explanation: Option<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgePullRequestCreationOutcomeStatus {
    /// The admitted open call succeeded.
    Completed,
    /// An existing pull request for the head branch was adopted; no open ran.
    Reconciled,
    /// The open (or reconciliation) failed; branch-only delivery stands.
    Failed,
    /// Preflight or scope blockers; branch-only delivery stands.
    Blocked,
}

fn outcome_record(
    record: Option<&ForgePullRequestRunnerAuthorityRecord>,
    input: &ForgePullRequestCreationExecutionInput<impl ForgePullRequestCreationAdapter>,
    intent: &GitBranchWorktreeRunnerDeliveryIntentRecord,
    scope: &ForgePullRequestCreationScope,
    outcome_status: ForgePullRequestCreationOutcomeStatus,
    pull_request_created: bool,
    pull_request_failed: bool,
    reconciled: bool,
    reference: Option<&ForgePullRequestCreationReference>,
    explanation: String,
) -> ForgePullRequestCreationOutcomeRecord {
    ForgePullRequestCreationOutcomeRecord {
        persisted_outcome_id: persisted_outcome_id(&input.confirmation_ref),
        confirmation_ref: input.confirmation_ref.clone(),
        authority_id: record
            .map(|record| record.authority_id.clone())
            .unwrap_or_else(|| "forge-pull-request-runner-authority:blocked".to_owned()),
        preflight_id: record
            .map(|record| record.preflight_id.clone())
            .unwrap_or_default(),
        admission_id: record
            .map(|record| record.admission_id.clone())
            .unwrap_or_default(),
        run_id: input.run_id.clone(),
        operator_ref: input.operator_ref.clone(),
        operator_confirmation_ref: intent.confirmation_ref.clone(),
        remote_target: intent.remote_target.clone(),
        forge_provider: Some(scope.forge_provider.clone()),
        base_branch: Some(scope.base_branch.clone()),
        head_branch: Some(scope.head_branch.clone()),
        title_source: Some(scope.title_source.clone()),
        body_source: Some(scope.body_source.clone()),
        outcome_status,
        pull_request_created,
        forge_effect_executed: pull_request_created,
        provider_effect_executed: false,
        pull_request_failed,
        reconciled,
        pull_request_reference: reference.as_ref().map(|reference| reference.pr_reference.clone()),
        pull_request_url: reference.as_ref().and_then(|reference| reference.pr_url.clone()),
        explanation: if explanation.is_empty() {
            None
        } else {
            Some(explanation)
        },
        evidence_refs: vec![
            format!("run:{}", input.run_id),
            intent.confirmation_ref.clone(),
        ],
    }
}

fn result_from_outcome(
    authority: ForgePullRequestRunnerAuthoritySet,
    outcome: ForgePullRequestCreationOutcomeRecord,
) -> ForgePullRequestCreationExecutionResult {
    ForgePullRequestCreationExecutionResult {
        reconciled: outcome.reconciled,
        pull_request_created: outcome.pull_request_created,
        pull_request_failed: outcome.pull_request_failed,
        pull_request_reference: outcome.pull_request_reference.clone(),
        pull_request_url: outcome.pull_request_url.clone(),
        authority,
        outcome,
        replayed: false,
    }
}

fn persist_and_receipt<B>(
    state: &ServerStateService<B>,
    input: &ForgePullRequestCreationExecutionInput<impl ForgePullRequestCreationAdapter>,
    outcome: &ForgePullRequestCreationOutcomeRecord,
) -> Result<(), ForgePullRequestCreationExecutionError>
where
    B: LocalStoreBackend,
{
    persist_forge_pull_request_creation_outcome(state, outcome)
        .map_err(ForgePullRequestCreationExecutionError::Persistence)?;
    write_creation_receipt(state, input, outcome)
}

/// Idempotent outcome persistence: the first write creates the record; a
/// repeat of a completed/reconciled outcome replays the existing record; a
/// failed/blocked record may be superseded by a later attempt (recovery
/// keeps the idempotency key and reconciles before any retry).
fn persist_forge_pull_request_creation_outcome<B>(
    state: &ServerStateService<B>,
    record: &ForgePullRequestCreationOutcomeRecord,
) -> LocalStoreResult<ForgePullRequestCreationOutcomeRecord>
where
    B: LocalStoreBackend,
{
    let record_id = PersistenceRecordId(record.persisted_outcome_id.clone());
    let stored = LocalStoreRecord {
        id: record_id.clone(),
        domain: PersistenceDomain::ArtifactMetadata,
        kind: PersistenceRecordKind::ArtifactMetadata,
        revision_id: RevisionId(format!("rev:{}", record.persisted_outcome_id)),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: serde_json::to_vec(record)
                .map_err(|error| LocalStoreError::InvalidRecord {
                    reason: error.to_string(),
                })?,
        },
    };
    match state.artifact_metadata().put(stored.clone(), RevisionExpectation::MustNotExist) {
        Ok(_) => Ok(record.clone()),
        Err(LocalStoreError::RevisionConflict(_)) => {
            let existing = read_forge_pull_request_creation_outcome_by_confirmation(
                state,
                &record.confirmation_ref,
            )?
            .ok_or_else(|| LocalStoreError::InvalidRecord {
                reason: "conflicting pull-request creation outcome write vanished".to_owned(),
            })?;
            match existing.outcome_status {
                ForgePullRequestCreationOutcomeStatus::Completed
                | ForgePullRequestCreationOutcomeStatus::Reconciled => Ok(existing),
                ForgePullRequestCreationOutcomeStatus::Failed
                | ForgePullRequestCreationOutcomeStatus::Blocked => {
                    let revision = RevisionId(format!("rev:{}", record.persisted_outcome_id));
                    state
                        .artifact_metadata()
                        .put(stored, RevisionExpectation::Exact(revision))?;
                    Ok(record.clone())
                }
            }
        }
        Err(error) => Err(error),
    }
}

/// Read one durable PR-creation outcome by its confirmation ref.
pub fn read_forge_pull_request_creation_outcome_by_confirmation<B>(
    state: &ServerStateService<B>,
    confirmation_ref: &str,
) -> LocalStoreResult<Option<ForgePullRequestCreationOutcomeRecord>>
where
    B: LocalStoreBackend,
{
    let Some(record) = state
        .artifact_metadata()
        .get(&PersistenceRecordId(persisted_outcome_id(confirmation_ref)))?
    else {
        return Ok(None);
    };
    serde_json::from_slice(&record.payload.bytes)
        .map(Some)
        .map_err(|error| LocalStoreError::InvalidRecord {
            reason: error.to_string(),
        })
}

fn persisted_outcome_id(confirmation_ref: &str) -> String {
    format!("forge-pull-request-creation-outcome:{confirmation_ref}")
}

/// Contract-020 receipt for one PR-creation outcome. Receipt replay must not
/// re-run provider calls: a replayed outcome writes no new receipt. The
/// receipt id carries the outcome status so a later retry after a
/// failed/blocked attempt keeps a distinct audit entry.
fn write_creation_receipt<B>(
    state: &ServerStateService<B>,
    input: &ForgePullRequestCreationExecutionInput<impl ForgePullRequestCreationAdapter>,
    outcome: &ForgePullRequestCreationOutcomeRecord,
) -> Result<(), ForgePullRequestCreationExecutionError>
where
    B: LocalStoreBackend,
{
    let (status, status_slug, summary) = match outcome.outcome_status {
        ForgePullRequestCreationOutcomeStatus::Completed => (
            EngineRuntimeReceiptStatus::Completed,
            "completed",
            format!(
                "opened pull request {} for run {} ({})",
                outcome.pull_request_reference.as_deref().unwrap_or("unknown"),
                input.run_id,
                outcome.pull_request_url.as_deref().unwrap_or("no link")
            ),
        ),
        ForgePullRequestCreationOutcomeStatus::Reconciled => (
            EngineRuntimeReceiptStatus::Completed,
            "reconciled",
            format!(
                "adopted existing pull request {} for run {} head branch {}; no duplicate opened",
                outcome.pull_request_reference.as_deref().unwrap_or("unknown"),
                input.run_id,
                outcome.head_branch.as_deref().unwrap_or("unknown")
            ),
        ),
        ForgePullRequestCreationOutcomeStatus::Failed => (
            EngineRuntimeReceiptStatus::Failed,
            "failed",
            format!(
                "pull-request creation failed for run {}: {}; branch-only delivery preserved",
                input.run_id,
                outcome.explanation.as_deref().unwrap_or("no explanation")
            ),
        ),
        ForgePullRequestCreationOutcomeStatus::Blocked => (
            EngineRuntimeReceiptStatus::Failed,
            "blocked",
            format!(
                "pull-request creation blocked for run {}: {}; branch-only delivery preserved",
                input.run_id,
                outcome.explanation.as_deref().unwrap_or("no explanation")
            ),
        ),
    };
    let receipt = EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:forge-pull-request-creation:{}:{status_slug}",
            input.confirmation_ref
        )),
        family: EngineRuntimeReceiptEffectFamily::CommandExecution,
        status,
        command_ref: None,
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(format!(
            "forge-pull-request-creation:{}",
            input.run_id
        ))),
        evidence_refs: vec![EngineRuntimeReceiptRef::Custom(input.confirmation_ref.clone())],
        artifact_refs: Vec::new(),
        summary: Some(summary),
    };
    write_runtime_receipt(
        state,
        &receipt,
        RevisionId(format!("rev:{}", receipt.receipt_id.0)),
        RevisionExpectation::MustNotExist,
    )
    .map(|_| ())
    .map_err(ForgePullRequestCreationExecutionError::Persistence)
}

impl ForgePullRequestCreationOutcomeStatus {
    fn as_slug(&self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Reconciled => "reconciled",
            Self::Failed => "failed",
            Self::Blocked => "blocked",
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use nucleus_core::PersistenceRecordId;
    use nucleus_engine::{
        decode_run_storage_record, EngineRunBudgetEnvelope, EngineRunCloseout, EngineRunCommand,
        EngineRunCommandService, EngineRunDeliverCommand, EngineRunDispatchCommand, EngineRunId,
        EngineRunLifecycleState, EngineRunObjective, EngineRunProposeCommand, EngineRunRecord,
        EngineRunRepository, EngineRunTransitionCommand, EngineRevisionExpectation,
    };
    use nucleus_local_store::{
        LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation,
        SqliteBackend,
    };
    use nucleus_projects::ProjectId;
    use tempfile::TempDir;

    use super::*;
    use crate::provider_git_branch_worktree_runner_authority::{
        write_git_branch_worktree_runner_delivery_intent,
        GitBranchWorktreeRunnerDeliveryIntentStatus,
    };
    use crate::{
        read_runtime_receipts, ForgePullRequestExecutionPreflightBlocker,
        ForgePullRequestExecutionPreflightRecord, ForgePullRequestExecutionPreflightSet,
        ForgePullRequestExecutionPreflightStatus, ForgePullRequestRunnerAuthorityBlocker,
        ForgePullRequestRunnerAuthorityStatus,
    };

    const CONFIRMATION_PREFIX: &str = "operator-confirmation:git-branch-worktree-runner-delivery:";
    const RUN_ID: &str = "run:pr-fixture";
    const HEAD_BRANCH: &str = "run/pr-fixture";
    const REMOTE: &str = "origin";

    #[test]
    fn happy_path_opens_pull_request_persists_reference_and_receipt() {
        let (directory, state) = test_state();
        let reference = reference("pr:42", Some("https://forge.example/pr/42"));
        let double = double(None, Ok(reference.clone()));
        write_delivery_intent(&state, "fixture-happy", REMOTE, Some(scope()));

        let result = run_forge_pull_request_creation(
            &state,
            execution_input("fixture-happy", double.clone()),
        )
        .expect("happy path");

        assert!(!result.replayed);
        assert!(!result.reconciled);
        assert!(result.pull_request_created);
        assert!(!result.pull_request_failed);
        assert_eq!(result.pull_request_reference.as_deref(), Some("pr:42"));
        assert_eq!(
            result.pull_request_url.as_deref(),
            Some("https://forge.example/pr/42")
        );
        assert!(result.authority.pull_request_creation_permitted);
        assert_eq!(
            result.authority.authorities[0].status,
            ForgePullRequestRunnerAuthorityStatus::ReadyForCreation
        );
        assert_eq!(result.outcome.outcome_status, ForgePullRequestCreationOutcomeStatus::Completed);
        assert!(result.outcome.pull_request_created);
        assert!(result.outcome.forge_effect_executed);
        assert!(!result.outcome.provider_effect_executed);
        assert_eq!(result.outcome.run_id, RUN_ID);
        assert_eq!(result.outcome.head_branch.as_deref(), Some(HEAD_BRANCH));

        let persisted = read_forge_pull_request_creation_outcome_by_confirmation(
            &state,
            &confirmation_ref("fixture-happy"),
        )
        .expect("read outcome")
        .expect("outcome record");
        assert_eq!(persisted.outcome_status, ForgePullRequestCreationOutcomeStatus::Completed);
        assert_eq!(persisted.pull_request_reference.as_deref(), Some("pr:42"));

        let receipts = read_runtime_receipts(&state).expect("receipts");
        assert!(receipts.iter().any(|receipt| {
            receipt.status == EngineRuntimeReceiptStatus::Completed
                && receipt.summary.as_deref().is_some_and(|summary| {
                    summary.contains("opened pull request pr:42")
                        && summary.contains("https://forge.example/pr/42")
                })
        }));

        // The double saw exactly one reconciliation and one open.
        assert_eq!(double.reconcile_call_count(), 1);
        assert_eq!(double.open_call_count(), 1);
    }

    #[test]
    fn reference_lands_on_the_run_record_closeout_evidence() {
        let (directory, state) = test_state();
        let reference = reference("pr:7", Some("https://forge.example/pr/7"));
        let double = double(None, Ok(reference.clone()));
        write_delivery_intent(&state, "fixture-run-record", REMOTE, Some(scope()));

        let result = run_forge_pull_request_creation(
            &state,
            execution_input("fixture-run-record", double),
        )
        .expect("happy path");

        // Delivery evidence: the reference and the link ride the run's
        // closeout evidence refs exactly like commit/push evidence today.
        let mut evidence = vec![
            format!("delivery:pr-reference:{}", result.pull_request_reference.as_deref().unwrap()),
            format!("delivery:pr-url:{}", result.pull_request_url.as_deref().unwrap()),
        ];
        evidence.push(format!("delivery:pr-created:{}", result.pull_request_created));

        let service = EngineRunCommandService::new(TestRunRepository { state: &state });
        service
            .execute(
                "command:run:propose:fixture",
                EngineRunCommand::Propose(EngineRunProposeCommand {
                    run_id: EngineRunId(RUN_ID.to_owned()),
                    project_id: ProjectId("project:pr-fixture".to_owned()),
                    objective: EngineRunObjective {
                        scope: "deliver fixture".to_owned(),
                        acceptance: vec!["PR opened".to_owned()],
                        stop_conditions: Vec::new(),
                    },
                    worktree_ref: Some("../repo-wt/pr-fixture".to_owned()),
                    provider_instance: "provider:test".to_owned(),
                    provider_model: "model:test".to_owned(),
                    orchestrator_designation: None,
                    budget: EngineRunBudgetEnvelope::default(),
                }),
            )
            .expect("propose");
        service
            .execute(
                "command:run:dispatch:fixture",
                EngineRunCommand::Dispatch(EngineRunDispatchCommand {
                    run_id: EngineRunId(RUN_ID.to_owned()),
                    operation_id: None,
                    conversation_id: Some(format!("conversation:run:{RUN_ID}")),
                    worktree_ref: Some("../repo-wt/pr-fixture".to_owned()),
                    expected_revision: None,
                }),
            )
            .expect("dispatch");
        service
            .execute(
                "command:run:running:fixture",
                EngineRunCommand::MarkRunning(EngineRunTransitionCommand {
                    run_id: EngineRunId(RUN_ID.to_owned()),
                    operation_id: Some("operation:fixture".to_owned()),
                    expected_revision: None,
                    reason: None,
                }),
            )
            .expect("running");
        service
            .execute(
                "command:run:deliver:fixture",
                EngineRunCommand::Deliver(EngineRunDeliverCommand {
                    run_id: EngineRunId(RUN_ID.to_owned()),
                    closeout: EngineRunCloseout {
                        summary: "delivered run with PR".to_owned(),
                        evidence_refs: evidence.clone(),
                        diff_ref: None,
                    },
                    expected_revision: None,
                }),
            )
            .expect("deliver");

        let stored = state
            .orchestration_runs()
            .get(&PersistenceRecordId(RUN_ID.to_owned()))
            .expect("run get")
            .expect("run record");
        let run = decode_run_storage_record(&stored.payload.bytes).expect("decode run");
        assert_eq!(run.state, EngineRunLifecycleState::Delivered);
        let closeout = run.closeout.expect("closeout");
        assert!(closeout.evidence_refs.contains(&evidence[0]));
        assert!(closeout.evidence_refs.contains(&evidence[1]));
    }

    #[test]
    fn idempotent_re_delivery_replays_without_duplicate_pr() {
        let (directory, state) = test_state();
        let reference = reference("pr:42", Some("https://forge.example/pr/42"));
        let double = double(None, Ok(reference.clone()));
        write_delivery_intent(&state, "fixture-replay", REMOTE, Some(scope()));

        let first = run_forge_pull_request_creation(
            &state,
            execution_input("fixture-replay", double.clone()),
        )
        .expect("first");
        assert!(!first.replayed);
        assert!(first.pull_request_created);

        let second = run_forge_pull_request_creation(
            &state,
            execution_input("fixture-replay", double.clone()),
        )
        .expect("replay");
        assert!(second.replayed);
        assert!(second.pull_request_created);
        assert_eq!(second.pull_request_reference.as_deref(), Some("pr:42"));

        // No second open: exactly one reconciliation + one open across both
        // executions, and only one persisted outcome record.
        assert_eq!(double.reconcile_call_count(), 1);
        assert_eq!(double.open_call_count(), 1);
        let persisted = read_forge_pull_request_creation_outcome_by_confirmation(
            &state,
            &confirmation_ref("fixture-replay"),
        )
        .expect("read outcome")
        .expect("outcome record");
        assert_eq!(persisted.outcome_status, ForgePullRequestCreationOutcomeStatus::Completed);

        // Replay writes no duplicate receipt.
        let receipts = read_runtime_receipts(&state).expect("receipts");
        assert_eq!(receipts.len(), 1);
    }

    #[test]
    fn reconciliation_adopts_existing_pr_without_open() {
        let (directory, state) = test_state();
        let reference = reference("pr:99", Some("https://forge.example/pr/99"));
        let double = double(Some(reference.clone()), Ok(reference.clone()));
        write_delivery_intent(&state, "fixture-reconcile", REMOTE, Some(scope()));

        let result = run_forge_pull_request_creation(
            &state,
            execution_input("fixture-reconcile", double.clone()),
        )
        .expect("reconciled");

        assert!(result.reconciled);
        assert!(!result.pull_request_created);
        assert!(!result.pull_request_failed);
        assert_eq!(result.outcome.outcome_status, ForgePullRequestCreationOutcomeStatus::Reconciled);
        assert_eq!(result.outcome.pull_request_reference.as_deref(), Some("pr:99"));
        assert_eq!(double.reconcile_call_count(), 1);
        assert_eq!(double.open_call_count(), 0);
    }

    #[test]
    fn no_remote_fallback_keeps_branch_only_delivery_with_receipt() {
        let (directory, state) = test_state();
        let double = double(None, Ok(reference("pr:1", None)));
        write_delivery_intent(&state, "fixture-no-remote", "", Some(scope()));

        let result = run_forge_pull_request_creation(
            &state,
            execution_input("fixture-no-remote", double.clone()),
        )
        .expect("fallback");

        assert!(result.pull_request_failed);
        assert!(!result.pull_request_created);
        assert_eq!(result.outcome.outcome_status, ForgePullRequestCreationOutcomeStatus::Failed);
        assert_eq!(double.reconcile_call_count(), 0);
        assert_eq!(double.open_call_count(), 0);
        let receipts = read_runtime_receipts(&state).expect("receipts");
        assert!(receipts.iter().any(|receipt| {
            receipt.status == EngineRuntimeReceiptStatus::Failed
                && receipt.summary.as_deref().is_some_and(|summary| {
                    summary.contains("no confirmed remote")
                        && summary.contains("branch-only delivery preserved")
                })
        }));
    }

    #[test]
    fn no_credential_preflight_fallback_blocks_with_explaining_receipt() {
        let (directory, state) = test_state();
        let double = double(None, Ok(reference("pr:1", None)));
        write_delivery_intent(&state, "fixture-no-credential", REMOTE, Some(scope()));
        let set = preflight_set("fixture-no-credential", false);

        let result = run_forge_pull_request_creation(
            &state,
            execution_input_with("fixture-no-credential", double.clone(), set),
        )
        .expect("fallback");

        assert!(result.pull_request_failed);
        assert!(!result.pull_request_created);
        assert_eq!(result.outcome.outcome_status, ForgePullRequestCreationOutcomeStatus::Blocked);
        assert!(!result.authority.pull_request_creation_permitted);
        assert!(result.authority.authorities[0]
            .blockers
            .contains(&ForgePullRequestRunnerAuthorityBlocker::PreflightNotReady));
        assert_eq!(double.reconcile_call_count(), 0);
        assert_eq!(double.open_call_count(), 0);
        let receipts = read_runtime_receipts(&state).expect("receipts");
        assert!(receipts.iter().any(|receipt| {
            receipt.status == EngineRuntimeReceiptStatus::Failed
                && receipt.summary.as_deref().is_some_and(|summary| {
                    summary.contains("ForgeCredentialNotReady")
                        && summary.contains("branch-only delivery preserved")
                })
        }));
    }

    #[test]
    fn pr_api_failure_fallback_keeps_branch_only_delivery_with_receipt() {
        let (directory, state) = test_state();
        let double = double(
            None,
            Err(ForgePullRequestCreationError::ApiFailure {
                reason: "422 validation failed".to_owned(),
            }),
        );
        write_delivery_intent(&state, "fixture-api-failure", REMOTE, Some(scope()));

        let result = run_forge_pull_request_creation(
            &state,
            execution_input("fixture-api-failure", double.clone()),
        )
        .expect("fallback");

        assert!(result.pull_request_failed);
        assert!(!result.pull_request_created);
        assert_eq!(result.outcome.outcome_status, ForgePullRequestCreationOutcomeStatus::Failed);
        assert_eq!(double.reconcile_call_count(), 1);
        assert_eq!(double.open_call_count(), 1);
        let receipts = read_runtime_receipts(&state).expect("receipts");
        assert!(receipts.iter().any(|receipt| {
            receipt.status == EngineRuntimeReceiptStatus::Failed
                && receipt.summary.as_deref().is_some_and(|summary| {
                    summary.contains("422 validation failed")
                        && summary.contains("branch-only delivery preserved")
                })
        }));
    }

    #[test]
    fn missing_intent_blocks_before_any_call() {
        let (directory, state) = test_state();
        let double = double(None, Ok(reference("pr:1", None)));

        let error = run_forge_pull_request_creation(
            &state,
            execution_input("fixture-missing-intent", double.clone()),
        )
        .expect_err("missing intent must block");

        assert!(matches!(
            error,
            ForgePullRequestCreationExecutionError::CommandNotReady { .. }
        ));
        assert_eq!(double.reconcile_call_count(), 0);
        assert_eq!(double.open_call_count(), 0);
        assert!(read_runtime_receipts(&state).expect("receipts").is_empty());
        assert!(read_forge_pull_request_creation_outcome_by_confirmation(
            &state,
            &confirmation_ref("fixture-missing-intent"),
        )
        .expect("outcomes")
        .is_none());
    }

    #[test]
    fn intent_without_pr_scope_blocks_before_any_call() {
        let (directory, state) = test_state();
        let double = double(None, Ok(reference("pr:1", None)));
        write_delivery_intent(&state, "fixture-no-scope", REMOTE, None);

        let error = run_forge_pull_request_creation(
            &state,
            execution_input("fixture-no-scope", double.clone()),
        )
        .expect_err("no scope must block");

        assert!(matches!(
            error,
            ForgePullRequestCreationExecutionError::CommandNotReady { .. }
        ));
        assert_eq!(double.reconcile_call_count(), 0);
        assert_eq!(double.open_call_count(), 0);
    }

    #[test]
    fn scope_drift_blocks_with_explaining_receipt() {
        let (directory, state) = test_state();
        let double = double(None, Ok(reference("pr:1", None)));
        write_delivery_intent(&state, "fixture-scope-drift", REMOTE, Some(scope()));
        // Preflight evidence drifted from the confirmed scope: base differs.
        let mut set = preflight_set("fixture-scope-drift", true);
        set.preflights[0].base_branch = Some("develop".to_owned());

        let result = run_forge_pull_request_creation(
            &state,
            execution_input_with("fixture-scope-drift", double.clone(), set),
        )
        .expect("fallback");

        assert!(result.pull_request_failed);
        assert_eq!(result.outcome.outcome_status, ForgePullRequestCreationOutcomeStatus::Blocked);
        assert!(result.authority.authorities[0]
            .blockers
            .contains(&ForgePullRequestRunnerAuthorityBlocker::PullRequestCreationScopeMismatch));
        assert_eq!(double.reconcile_call_count(), 0);
        assert_eq!(double.open_call_count(), 0);
        let receipts = read_runtime_receipts(&state).expect("receipts");
        assert!(receipts.iter().any(|receipt| {
            receipt.status == EngineRuntimeReceiptStatus::Failed
                && receipt.summary.as_deref().is_some_and(|summary| {
                    summary.contains("PullRequestCreationScopeMismatch")
                        && summary.contains("branch-only delivery preserved")
                })
        }));
    }

    #[test]
    fn failed_attempt_may_be_retried_after_reconciliation() {
        let (directory, state) = test_state();
        // First attempt: API failure.
        let failing = double(
            None,
            Err(ForgePullRequestCreationError::ApiFailure {
                reason: "temporary outage".to_owned(),
            }),
        );
        write_delivery_intent(&state, "fixture-retry", REMOTE, Some(scope()));
        let first = run_forge_pull_request_creation(
            &state,
            execution_input("fixture-retry", failing.clone()),
        )
        .expect("first attempt");
        assert!(first.pull_request_failed);

        // Retry: provider now has an existing PR (the uncertain write
        // reconciled), so the retry adopts it instead of opening a second.
        let adopting = double(
            Some(reference("pr:50", Some("https://forge.example/pr/50"))),
            Ok(reference("pr:50", Some("https://forge.example/pr/50"))),
        );
        let retry = run_forge_pull_request_creation(
            &state,
            execution_input("fixture-retry", adopting),
        )
        .expect("retry");
        assert!(retry.reconciled);
        assert!(!retry.pull_request_created);
        assert_eq!(retry.pull_request_reference.as_deref(), Some("pr:50"));

        // The failed outcome was superseded by the reconciled outcome; both
        // receipts exist with distinct ids.
        let persisted = read_forge_pull_request_creation_outcome_by_confirmation(
            &state,
            &confirmation_ref("fixture-retry"),
        )
        .expect("read outcome")
        .expect("outcome record");
        assert_eq!(persisted.outcome_status, ForgePullRequestCreationOutcomeStatus::Reconciled);
        let receipts = read_runtime_receipts(&state).expect("receipts");
        assert_eq!(receipts.len(), 2);
        assert!(receipts.iter().any(|receipt| {
            receipt.receipt_id.0.ends_with(":failed")
                || receipt.receipt_id.0.ends_with(":reconciled")
        }));
    }

    fn scope() -> ForgePullRequestCreationScope {
        ForgePullRequestCreationScope {
            forge_provider: ForgePullRequestProvider::GitHub,
            base_branch: "main".to_owned(),
            head_branch: HEAD_BRANCH.to_owned(),
            title_source: ForgePullRequestTextSource::GeneratedFromEvidence,
            body_source: ForgePullRequestTextSource::GeneratedFromEvidence,
        }
    }

    fn reference(reference: &str, url: Option<&str>) -> ForgePullRequestCreationReference {
        ForgePullRequestCreationReference {
            pr_reference: reference.to_owned(),
            pr_url: url.map(str::to_owned),
        }
    }

    fn double(
        existing: Option<ForgePullRequestCreationReference>,
        open: Result<ForgePullRequestCreationReference, ForgePullRequestCreationError>,
    ) -> ForgePullRequestCreationTestDouble {
        ForgePullRequestCreationTestDouble::new(existing, open)
    }

    fn confirmation_ref(idempotency_key: &str) -> String {
        format!("{CONFIRMATION_PREFIX}{idempotency_key}")
    }

    fn execution_input(
        idempotency_key: &str,
        adapter: ForgePullRequestCreationTestDouble,
    ) -> ForgePullRequestCreationExecutionInput<ForgePullRequestCreationTestDouble> {
        execution_input_with(
            idempotency_key,
            adapter,
            preflight_set(idempotency_key, true),
        )
    }

    fn execution_input_with(
        idempotency_key: &str,
        adapter: ForgePullRequestCreationTestDouble,
        preflights: ForgePullRequestExecutionPreflightSet,
    ) -> ForgePullRequestCreationExecutionInput<ForgePullRequestCreationTestDouble> {
        ForgePullRequestCreationExecutionInput {
            confirmation_ref: confirmation_ref(idempotency_key),
            preflights,
            run_id: RUN_ID.to_owned(),
            operator_ref: "operator:tom".to_owned(),
            idempotency_key: idempotency_key.to_owned(),
            timeout: Duration::from_secs(30),
            adapter,
        }
    }

    fn write_delivery_intent(
        state: &ServerStateService<SqliteBackend>,
        idempotency_key: &str,
        remote_target: &str,
        scope: Option<ForgePullRequestCreationScope>,
    ) {
        write_git_branch_worktree_runner_delivery_intent(
            state,
            GitBranchWorktreeRunnerDeliveryIntentRecord {
                confirmation_ref: confirmation_ref(idempotency_key),
                run_id: RUN_ID.to_owned(),
                handoff_id: "git-branch-worktree-execution-handoff:handoff:1".to_owned(),
                branch_ref: HEAD_BRANCH.to_owned(),
                worktree_location_ref: "../nucleus-wt/pr-fixture".to_owned(),
                commit_message: "deliver run".to_owned(),
                remote_target: remote_target.to_owned(),
                pull_request_creation: scope,
                operator_ref: "operator:tom".to_owned(),
                idempotency_key: idempotency_key.to_owned(),
                status: GitBranchWorktreeRunnerDeliveryIntentStatus::Confirmed,
            },
        )
        .expect("delivery intent");
    }

    fn preflight_set(
        idempotency_key: &str,
        forge_credential_ready: bool,
    ) -> ForgePullRequestExecutionPreflightSet {
        ForgePullRequestExecutionPreflightSet {
            preflight_set_id: format!("preflight-set:{idempotency_key}"),
            preflights: vec![ForgePullRequestExecutionPreflightRecord {
                preflight_id: format!("preflight:{idempotency_key}"),
                admission_id: format!("admission:{idempotency_key}"),
                pr_evidence_id: format!("pr-evidence:{idempotency_key}"),
                pr_descriptor_id: format!("pr-descriptor:{idempotency_key}"),
                push_preflight_id: format!("push-preflight:{idempotency_key}"),
                request_id: format!("request:{idempotency_key}"),
                authority_id: format!("upstream-authority:{idempotency_key}"),
                git_plan_id: format!("git-plan:{idempotency_key}"),
                task_id: format!("task:{idempotency_key}"),
                repo_id: format!("repo:{idempotency_key}"),
                operator_ref: "operator:tom".to_owned(),
                remote_target: None,
                forge_provider: Some(ForgePullRequestProvider::GitHub),
                base_branch: Some("main".to_owned()),
                head_branch: Some(HEAD_BRANCH.to_owned()),
                title_source: Some(ForgePullRequestTextSource::GeneratedFromEvidence),
                body_source: Some(ForgePullRequestTextSource::GeneratedFromEvidence),
                status: if forge_credential_ready {
                    ForgePullRequestExecutionPreflightStatus::Ready
                } else {
                    ForgePullRequestExecutionPreflightStatus::Blocked
                },
                blockers: if forge_credential_ready {
                    Vec::new()
                } else {
                    vec![ForgePullRequestExecutionPreflightBlocker::ForgeCredentialNotReady]
                },
                pull_request_created: false,
                forge_effect_executed: false,
                provider_effect_executed: false,
                raw_output_retained: false,
            }],
            skipped_admission_ids: Vec::new(),
            pull_request_created: false,
            forge_effect_executed: false,
            provider_effect_executed: false,
            raw_output_retained: false,
        }
    }

    fn test_state() -> (TempDir, ServerStateService<SqliteBackend>) {
        let directory = tempfile::tempdir().expect("directory");
        let state = ServerStateService::new(SqliteBackend::new(directory.path().join("state.sqlite")));
        (directory, state)
    }

    struct TestRunRepository<'a> {
        state: &'a ServerStateService<SqliteBackend>,
    }

    impl EngineRunRepository for TestRunRepository<'_> {
        type Error = LocalStoreError;

        fn get_run(
            &self,
            run_id: &PersistenceRecordId,
        ) -> Result<Option<EngineRunRecord>, Self::Error> {
            self.state
                .orchestration_runs()
                .get(run_id)
                .map(|record| {
                    record.map(|record| EngineRunRecord {
                        id: record.id,
                        domain: record.domain,
                        kind: record.kind,
                        revision_id: record.revision_id,
                        payload: record.payload.bytes,
                    })
                })
        }

        fn put_run(
            &self,
            record: EngineRunRecord,
            revision: EngineRevisionExpectation,
        ) -> Result<(), Self::Error> {
            let expectation = match revision {
                EngineRevisionExpectation::MustNotExist => RevisionExpectation::MustNotExist,
                EngineRevisionExpectation::MustExist => RevisionExpectation::MustExist,
                EngineRevisionExpectation::Exact(revision) => RevisionExpectation::Exact(revision),
            };
            self.state.orchestration_runs().put(
                LocalStoreRecord {
                    id: record.id,
                    domain: record.domain,
                    kind: record.kind,
                    revision_id: record.revision_id,
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: record.payload,
                    },
                },
                expectation,
            )?;
            Ok(())
        }
    }
}
