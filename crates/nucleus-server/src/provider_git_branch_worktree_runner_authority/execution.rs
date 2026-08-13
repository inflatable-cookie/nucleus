//! Gated Git branch/worktree runner execution.
//!
//! This is the execution path the branch/worktree runner authority chain
//! gates: `git worktree add <location> -b <branch>` (playbook convention)
//! invoked only when the chain reaches `ReadyForRunner` from a durable
//! operator-confirmed effect intent, an admitted execution handoff, and
//! policy-approved target refs. The resulting outcome record flips
//! `worktree_created: true` with a contract-020 runtime receipt.
//!
//! No intent, no handoff, no approved target, or an unconfirmed intent
//! blocks before any spawn: the named authority blockers are returned and
//! nothing runs. No other SCM mutation (checkout, switch, commit, push,
//! branch mutation) is reachable through this path.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use nucleus_core::RevisionId;
use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};
use nucleus_local_store::{LocalStoreBackend, LocalStoreError, RevisionExpectation};

use super::intent::{
    read_git_branch_worktree_runner_delivery_intent_by_confirmation,
    read_git_branch_worktree_runner_operator_effect_intent_by_confirmation,
    GitBranchWorktreeRunnerDeliveryIntentRecord, GitBranchWorktreeRunnerOperatorEffectIntentRecord,
};
use super::types::GitBranchWorktreeRunnerOperatorEffectIntent;
use crate::provider_no_effects::ForgeScmNoEffects;
use crate::runtime_receipt_state::write_runtime_receipt;
use crate::{
    git_branch_worktree_runner_authority, git_branch_worktree_runner_command_adapter,
    persist_git_branch_worktree_runner_outcomes, read_git_branch_worktree_runner_outcomes,
    GitBranchWorktreeExecutionHandoffSet, GitBranchWorktreeMode,
    GitBranchWorktreeRunnerAuthorityBlocker, GitBranchWorktreeRunnerAuthorityInput,
    GitBranchWorktreeRunnerAuthoritySet, GitBranchWorktreeRunnerCommandAdapterInput,
    GitBranchWorktreeRunnerCommandAdapterRecord, GitBranchWorktreeRunnerCommandAdapterStatus,
    GitBranchWorktreeRunnerDeliveryCommandAdapterInput,
    GitBranchWorktreeRunnerOutcomePersistenceSet, GitBranchWorktreeRunnerOutcomeStatus,
    GitBranchWorktreeRunnerTargetRef, ServerStateService,
};

/// One gated runner execution: one dispatch, one admitted handoff, one
/// isolated worktree target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreeRunnerExecutionInput {
    /// Durable operator effect intent lookup key written by the confirmation
    /// control command. Missing -> `OperatorEffectIntentMissing`, no spawn.
    pub confirmation_ref: String,
    /// Admitted execution handoff set (built from the handoff chain).
    pub handoffs: GitBranchWorktreeExecutionHandoffSet,
    /// Policy-approved target refs for the handoffs.
    pub target_refs: Vec<GitBranchWorktreeRunnerTargetRef>,
    /// Validated repository working directory the spawn runs in.
    pub repo_working_directory: PathBuf,
    /// Run dispatch identity for receipts and outcomes.
    pub run_id: String,
    /// Operator identity from the durable confirmation.
    pub operator_ref: String,
    /// Idempotency key; repeat dispatch replays instead of re-running git.
    pub idempotency_key: String,
    /// Spawn deadline.
    pub timeout: Duration,
    /// Bounded stdout capture.
    pub stdout_limit_bytes: usize,
    /// Bounded stderr capture.
    pub stderr_limit_bytes: usize,
}

/// Sanitized runner execution result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreeRunnerExecutionResult {
    pub authority: GitBranchWorktreeRunnerAuthoritySet,
    pub commands: crate::GitBranchWorktreeRunnerCommandAdapterSet,
    pub outcomes: GitBranchWorktreeRunnerOutcomePersistenceSet,
    pub replayed: bool,
    pub worktree_path: Option<PathBuf>,
    pub spawn: Option<GitBranchWorktreeRunnerSpawnSummary>,
}

/// Sanitized counts from the gated spawn: bounded capture, no raw output.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreeRunnerSpawnSummary {
    pub success: bool,
    pub exit_status: Option<i32>,
    pub stdout_captured_bytes: usize,
    pub stderr_captured_bytes: usize,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

/// Execution failures. `Blocked` carries the named authority blockers and is
/// the only path that returns before any spawn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitBranchWorktreeRunnerExecutionError {
    /// The chain did not reach `ReadyForRunner`; nothing spawned.
    Blocked {
        authority: GitBranchWorktreeRunnerAuthoritySet,
        blockers: Vec<GitBranchWorktreeRunnerAuthorityBlocker>,
        reason: String,
    },
    /// The adapter produced no executable argv for a ready authority.
    CommandNotReady { reason: String },
    /// The gated git spawn could not start or exceeded its deadline.
    SpawnFailed { reason: String },
    /// Sanitized outcome persistence failed after execution.
    Persistence(LocalStoreError),
}

/// Run the gated branch/worktree runner lane.
///
/// Invariant: a durable operator-confirmed intent plus an admitted handoff
/// plus approved target refs are all required before `git worktree add`
/// spawns. Everything else returns `Blocked` with the named blockers and a
/// `worktree_created: false` chain record.
pub fn run_git_branch_worktree_runner<B>(
    state: &ServerStateService<B>,
    input: GitBranchWorktreeRunnerExecutionInput,
) -> Result<GitBranchWorktreeRunnerExecutionResult, GitBranchWorktreeRunnerExecutionError>
where
    B: LocalStoreBackend,
{
    let intent = read_git_branch_worktree_runner_operator_effect_intent_by_confirmation(
        state,
        &input.confirmation_ref,
    )
    .map_err(GitBranchWorktreeRunnerExecutionError::Persistence)?
    .map(GitBranchWorktreeRunnerOperatorEffectIntentRecord::into_authority_intent)
    .unwrap_or(GitBranchWorktreeRunnerOperatorEffectIntent::Missing);

    let authority = git_branch_worktree_runner_authority(GitBranchWorktreeRunnerAuthorityInput {
        handoffs: input.handoffs.clone(),
        operator_effect_intent: intent,
        target_refs: input.target_refs.clone(),
        raw_output_retention_requested: false,
        commit_requested: false,
        push_requested: false,
        pull_request_requested: false,
        forge_effect_requested: false,
        provider_effect_requested: false,
        callback_effect_requested: false,
        interruption_effect_requested: false,
        recovery_effect_requested: false,
        task_mutation_requested: false,
    });
    if !authority.runner_invocation_permitted {
        let blockers = authority
            .authorities
            .iter()
            .flat_map(|record| record.blockers.iter().cloned())
            .collect::<Vec<_>>();
        return Err(GitBranchWorktreeRunnerExecutionError::Blocked {
            authority,
            blockers,
            reason: "branch/worktree runner authority did not reach ReadyForRunner".to_owned(),
        });
    }

    let commands =
        git_branch_worktree_runner_command_adapter(GitBranchWorktreeRunnerCommandAdapterInput {
            authorities: authority.clone(),
            executable: "git".to_owned(),
            repo_working_directory_ref: input.repo_working_directory.display().to_string(),
            stdout_limit_bytes: input.stdout_limit_bytes,
            stderr_limit_bytes: input.stderr_limit_bytes,
            shell_passthrough_requested: false,
            raw_output_retention_requested: false,
            commit_requested: false,
            push_requested: false,
            pull_request_requested: false,
            forge_effect_requested: false,
            provider_effect_requested: false,
            callback_effect_requested: false,
            interruption_effect_requested: false,
            recovery_effect_requested: false,
            task_mutation_requested: false,
        });
    if !commands.executable_argv_created {
        return Err(GitBranchWorktreeRunnerExecutionError::CommandNotReady {
            reason: "branch/worktree runner adapter built no executable argv".to_owned(),
        });
    }

    let ready = commands
        .commands
        .iter()
        .filter(|command| command.status == GitBranchWorktreeRunnerCommandAdapterStatus::Ready)
        .cloned()
        .collect::<Vec<_>>();

    // Idempotency: repeat dispatch with the same chain replays the persisted
    // outcome instead of re-running git (a second `worktree add` would fail).
    let existing = read_git_branch_worktree_runner_outcomes(state)
        .map_err(GitBranchWorktreeRunnerExecutionError::Persistence)?;
    let replayed_records = existing
        .iter()
        .filter(|record| {
            ready.iter().any(|command| {
                persisted_outcome_id(&command.command_id) == record.persisted_outcome_id
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    if !ready.is_empty() && replayed_records.len() == ready.len() {
        let command_set_id = commands.command_set_id.clone();
        let worktree_path = replayed_records
            .iter()
            .find(|record| record.worktree_created)
            .and_then(|record| {
                record
                    .worktree_location_ref
                    .as_deref()
                    .map(|location| normalize_path(&input.repo_working_directory.join(location)))
            });
        return Ok(GitBranchWorktreeRunnerExecutionResult {
            authority,
            commands,
            outcomes: replayed_outcome_set(&command_set_id, replayed_records),
            replayed: true,
            worktree_path,
            spawn: None,
        });
    }

    // Gated spawn: only Ready commands run, and only after the chain above.
    let mut shell_execution_performed = false;
    let mut worktree_created = false;
    let mut branch_created = false;
    let mut worktree_path = None;
    let mut spawn = None;
    for command in &ready {
        let outcome = spawn_git(&input, command)?;
        shell_execution_performed = true;
        spawn = Some(GitBranchWorktreeRunnerSpawnSummary {
            success: outcome.success,
            exit_status: outcome.exit_status,
            stdout_captured_bytes: outcome.stdout_captured_bytes,
            stderr_captured_bytes: outcome.stderr_captured_bytes,
            stdout_truncated: outcome.stdout_truncated,
            stderr_truncated: outcome.stderr_truncated,
        });
        let location = command.worktree_location_ref.clone().unwrap_or_default();
        let location_path = normalize_path(&input.repo_working_directory.join(&location));
        if outcome.success
            && command.worktree_mode == GitBranchWorktreeMode::IsolatedWorktree
            && location_path.is_dir()
        {
            worktree_created = true;
            branch_created = true;
            worktree_path = Some(location_path);
        }
        if !outcome.success {
            // A failing git command is a real outcome, not a system error.
            let persisted = persist_outcomes(
                state,
                &input,
                &commands,
                &existing,
                GitBranchWorktreeRunnerOutcomeStatus::Failed,
                false,
                false,
                false,
            )?;
            return Ok(GitBranchWorktreeRunnerExecutionResult {
                authority,
                commands,
                outcomes: persisted,
                replayed: false,
                worktree_path: None,
                spawn,
            });
        }
    }

    let outcomes = persist_outcomes(
        state,
        &input,
        &commands,
        &existing,
        GitBranchWorktreeRunnerOutcomeStatus::Completed,
        shell_execution_performed,
        branch_created,
        worktree_created,
    )?;

    if worktree_created {
        write_worktree_created_receipt(state, &input, &ready, worktree_path.as_ref())?;
    }

    Ok(GitBranchWorktreeRunnerExecutionResult {
        authority,
        commands,
        outcomes,
        replayed: false,
        worktree_path,
        spawn,
    })
}

fn persist_outcomes<B>(
    state: &ServerStateService<B>,
    input: &GitBranchWorktreeRunnerExecutionInput,
    commands: &crate::GitBranchWorktreeRunnerCommandAdapterSet,
    existing: &[crate::GitBranchWorktreeRunnerOutcomePersistenceRecord],
    requested_status: GitBranchWorktreeRunnerOutcomeStatus,
    shell_execution_performed: bool,
    branch_created: bool,
    worktree_created: bool,
) -> Result<GitBranchWorktreeRunnerOutcomePersistenceSet, GitBranchWorktreeRunnerExecutionError>
where
    B: LocalStoreBackend,
{
    persist_git_branch_worktree_runner_outcomes(
        state,
        crate::GitBranchWorktreeRunnerOutcomePersistenceInput {
            commands: commands.clone(),
            requested_status,
            inspected_path_count: 1,
            affected_path_count: 1,
            evidence_refs: vec![input.confirmation_ref.clone()],
            existing_outcome_ids: existing
                .iter()
                .map(|record| record.persisted_outcome_id.clone())
                .collect(),
            shell_execution_performed,
            checkout_executed: false,
            branch_created,
            worktree_created,
            commit_created: false,
            push_executed: false,
            raw_stdout_present: false,
            raw_stderr_present: false,
            provider_payload_present: false,
            raw_output_retention_requested: false,
            commit_requested: false,
            push_requested: false,
            delivery_authority_granted: false,
            pull_request_requested: false,
            forge_effect_requested: false,
            provider_effect_requested: false,
            callback_effect_requested: false,
            interruption_effect_requested: false,
            recovery_effect_requested: false,
            task_mutation_requested: false,
        },
    )
    .map_err(GitBranchWorktreeRunnerExecutionError::Persistence)
}

fn replayed_outcome_set(
    command_set_id: &str,
    records: Vec<crate::GitBranchWorktreeRunnerOutcomePersistenceRecord>,
) -> GitBranchWorktreeRunnerOutcomePersistenceSet {
    GitBranchWorktreeRunnerOutcomePersistenceSet {
        outcome_set_id: format!("git-branch-worktree-runner-outcomes:{command_set_id}"),
        shell_execution_performed: records
            .iter()
            .any(|record| record.shell_execution_performed),
        checkout_executed: records.iter().any(|record| record.checkout_executed),
        branch_created: records.iter().any(|record| record.branch_created),
        worktree_created: records.iter().any(|record| record.worktree_created),
        commit_created: records.iter().any(|record| record.commit_created),
        push_executed: records.iter().any(|record| record.push_executed),
        records,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn persisted_outcome_id(command_id: &str) -> String {
    format!("git-branch-worktree-runner-outcome:{command_id}")
}

/// Collapse `.`/`..` components lexically (no symlink resolution) so the
/// playbook's `../<repo>-wt/<slug>` location yields a stable absolute path.
fn normalize_path(path: &PathBuf) -> PathBuf {
    use std::path::Component;
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

struct SpawnOutcome {
    success: bool,
    exit_status: Option<i32>,
    stdout_captured_bytes: usize,
    stderr_captured_bytes: usize,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

/// Spawn `git --no-optional-locks <argv>` in the repo working directory with
/// bounded capture and a deadline. Mirrors the working-copy mutation pattern;
/// no shell, no PTY, no raw output retention.
fn spawn_git(
    input: &GitBranchWorktreeRunnerExecutionInput,
    command: &GitBranchWorktreeRunnerCommandAdapterRecord,
) -> Result<SpawnOutcome, GitBranchWorktreeRunnerExecutionError> {
    spawn_git_in(input, command, &input.repo_working_directory)
}

fn spawn_git_in(
    input: &GitBranchWorktreeRunnerExecutionInput,
    command: &GitBranchWorktreeRunnerCommandAdapterRecord,
    working_directory: &PathBuf,
) -> Result<SpawnOutcome, GitBranchWorktreeRunnerExecutionError> {
    let mut child = Command::new("git")
        .arg("--no-optional-locks")
        .args(&command.argv)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .current_dir(working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| GitBranchWorktreeRunnerExecutionError::SpawnFailed {
            reason: format!("Git branch/worktree runner could not start: {error}"),
        })?;

    let deadline = Instant::now() + input.timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                return Err(GitBranchWorktreeRunnerExecutionError::SpawnFailed {
                    reason: format!("Git branch/worktree runner wait failed: {error}"),
                })
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(GitBranchWorktreeRunnerExecutionError::SpawnFailed {
                reason: "Git branch/worktree runner exceeded its deadline".to_owned(),
            });
        }
        std::thread::sleep(Duration::from_millis(20));
    };

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(handle) = child.stdout.take() {
        let _ = handle
            .take((input.stdout_limit_bytes + 1) as u64)
            .read_to_end(&mut stdout);
    }
    if let Some(handle) = child.stderr.take() {
        let _ = handle
            .take((input.stderr_limit_bytes + 1) as u64)
            .read_to_end(&mut stderr);
    }

    Ok(SpawnOutcome {
        success: status.success(),
        exit_status: status.code(),
        stdout_captured_bytes: stdout.len(),
        stderr_captured_bytes: stderr.len(),
        stdout_truncated: stdout.len() > input.stdout_limit_bytes,
        stderr_truncated: stderr.len() > input.stderr_limit_bytes,
    })
}

fn write_worktree_created_receipt<B>(
    state: &ServerStateService<B>,
    input: &GitBranchWorktreeRunnerExecutionInput,
    ready: &[GitBranchWorktreeRunnerCommandAdapterRecord],
    worktree_path: Option<&PathBuf>,
) -> Result<(), GitBranchWorktreeRunnerExecutionError>
where
    B: LocalStoreBackend,
{
    let command_id = ready
        .iter()
        .find(|command| command.worktree_mode == GitBranchWorktreeMode::IsolatedWorktree)
        .map(|command| command.command_id.clone())
        .unwrap_or_else(|| "git-branch-worktree-runner-command:unknown".to_owned());
    let location = worktree_path
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "unknown".to_owned());
    let receipt = EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:git-branch-worktree-runner:{}:{}",
            input.run_id, input.idempotency_key
        )),
        family: EngineRuntimeReceiptEffectFamily::CommandExecution,
        status: EngineRuntimeReceiptStatus::Completed,
        command_ref: Some(EngineRuntimeReceiptRef::Custom(command_id)),
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(format!(
            "git-branch-worktree-runner:worktree-created:{}",
            input.run_id
        ))),
        evidence_refs: vec![EngineRuntimeReceiptRef::Custom(
            input.confirmation_ref.clone(),
        )],
        artifact_refs: Vec::new(),
        summary: Some(format!(
            "isolated worktree created for run {} at {}",
            input.run_id, location
        )),
    };
    write_runtime_receipt(
        state,
        &receipt,
        RevisionId(format!("rev:{}", receipt.receipt_id.0)),
        RevisionExpectation::MustNotExist,
    )
    .map(|_| ())
    .map_err(GitBranchWorktreeRunnerExecutionError::Persistence)
}

/// Delivery-time runner input. Its confirmation is separate from the
/// dispatch-time worktree intent and binds the commit message, own branch, and
/// remote target for exactly one delivery attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreeRunnerDeliveryExecutionInput {
    pub confirmation_ref: String,
    pub handoffs: GitBranchWorktreeExecutionHandoffSet,
    pub target_refs: Vec<GitBranchWorktreeRunnerTargetRef>,
    pub repo_working_directory: PathBuf,
    pub run_id: String,
    pub operator_ref: String,
    pub idempotency_key: String,
    pub timeout: Duration,
    pub stdout_limit_bytes: usize,
    pub stderr_limit_bytes: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreeRunnerDeliveryExecutionResult {
    pub authority: GitBranchWorktreeRunnerAuthoritySet,
    pub commands: crate::GitBranchWorktreeRunnerCommandAdapterSet,
    pub outcomes: GitBranchWorktreeRunnerOutcomePersistenceSet,
    pub replayed: bool,
    pub worktree_path: PathBuf,
    pub commit_created: bool,
    pub push_executed: bool,
    pub push_failed: bool,
    pub spawns: Vec<GitBranchWorktreeRunnerSpawnSummary>,
}

/// Execute delivery's `git add`, `git commit`, and `git push` in the run's
/// isolated worktree. Only a delivery-confirmed authority reaches spawn.
pub fn run_git_branch_worktree_runner_delivery<B>(
    state: &ServerStateService<B>,
    input: GitBranchWorktreeRunnerDeliveryExecutionInput,
) -> Result<GitBranchWorktreeRunnerDeliveryExecutionResult, GitBranchWorktreeRunnerExecutionError>
where
    B: LocalStoreBackend,
{
    let delivery_intent = read_git_branch_worktree_runner_delivery_intent_by_confirmation(
        state,
        &input.confirmation_ref,
    )
    .map_err(GitBranchWorktreeRunnerExecutionError::Persistence)?
    .ok_or_else(|| GitBranchWorktreeRunnerExecutionError::CommandNotReady {
        reason: "delivery intent disappeared before execution".to_owned(),
    })?;
    let push_requested = !delivery_intent.remote_target.trim().is_empty();

    let authority = git_branch_worktree_runner_authority(GitBranchWorktreeRunnerAuthorityInput {
        handoffs: input.handoffs.clone(),
        operator_effect_intent: delivery_intent.clone().into_authority_intent(),
        target_refs: input.target_refs.clone(),
        raw_output_retention_requested: false,
        commit_requested: true,
        push_requested,
        pull_request_requested: false,
        forge_effect_requested: false,
        provider_effect_requested: false,
        callback_effect_requested: false,
        interruption_effect_requested: false,
        recovery_effect_requested: false,
        task_mutation_requested: false,
    });
    if !authority.runner_invocation_permitted {
        let blockers = authority
            .authorities
            .iter()
            .flat_map(|record| record.blockers.iter().cloned())
            .collect::<Vec<_>>();
        return Err(GitBranchWorktreeRunnerExecutionError::Blocked {
            authority,
            blockers,
            reason: "delivery authority did not reach ReadyForRunner".to_owned(),
        });
    }

    let commands = crate::git_branch_worktree_runner_delivery_command_adapter(
        GitBranchWorktreeRunnerDeliveryCommandAdapterInput {
            authorities: authority.clone(),
            executable: "git".to_owned(),
            repo_working_directory_ref: input.repo_working_directory.display().to_string(),
            commit_message: delivery_intent.commit_message.clone(),
            remote_target: delivery_intent.remote_target.clone(),
            stdout_limit_bytes: input.stdout_limit_bytes,
            stderr_limit_bytes: input.stderr_limit_bytes,
        },
    );
    if !commands.executable_argv_created {
        return Err(GitBranchWorktreeRunnerExecutionError::CommandNotReady {
            reason: "delivery adapter built no executable argv".to_owned(),
        });
    }

    let ready = commands
        .commands
        .iter()
        .filter(|command| command.status == GitBranchWorktreeRunnerCommandAdapterStatus::Ready)
        .cloned()
        .collect::<Vec<_>>();
    let worktree_location = ready
        .first()
        .and_then(|command| command.worktree_location_ref.clone())
        .ok_or_else(|| GitBranchWorktreeRunnerExecutionError::CommandNotReady {
            reason: "delivery target has no isolated worktree location".to_owned(),
        })?;
    let worktree_path = normalize_path(&input.repo_working_directory.join(worktree_location));
    let repo_path = normalize_path(&input.repo_working_directory);
    if worktree_path == repo_path || !worktree_path.join(".git").exists() {
        return Err(GitBranchWorktreeRunnerExecutionError::CommandNotReady {
            reason: "delivery target is not an isolated Git worktree".to_owned(),
        });
    }
    if !worktree_path.is_dir() {
        return Err(GitBranchWorktreeRunnerExecutionError::CommandNotReady {
            reason: "delivery isolated worktree location is not a directory".to_owned(),
        });
    }

    let delivery_command_ids = ready
        .iter()
        .map(|command| persisted_outcome_id(&command.command_id))
        .collect::<Vec<_>>();
    let existing = read_git_branch_worktree_runner_outcomes(state)
        .map_err(GitBranchWorktreeRunnerExecutionError::Persistence)?;
    let existing_delivery = existing
        .iter()
        .filter(|record| delivery_command_ids.contains(&record.persisted_outcome_id))
        .cloned()
        .collect::<Vec<_>>();
    if existing_delivery.len() == ready.len() {
        let command_set_id = commands.command_set_id.clone();
        let commit_created = existing_delivery.iter().any(|record| record.commit_created);
        let push_executed = existing_delivery.iter().any(|record| record.push_executed);
        let push_failed = existing_delivery.iter().any(|record| {
            record.command_kind == crate::GitBranchWorktreeRunnerCommandKind::PushRunBranch
                && record.outcome_status == GitBranchWorktreeRunnerOutcomeStatus::Failed
        });
        return Ok(GitBranchWorktreeRunnerDeliveryExecutionResult {
            authority,
            commands,
            outcomes: replayed_outcome_set(&command_set_id, existing_delivery),
            replayed: true,
            worktree_path,
            commit_created,
            push_executed,
            push_failed,
            spawns: Vec::new(),
        });
    }

    let mut existing_ids = existing
        .iter()
        .map(|record| record.persisted_outcome_id.clone())
        .collect::<Vec<_>>();
    let mut spawns = Vec::new();
    let mut commit_created = existing_delivery.iter().any(|record| record.commit_created);
    let mut push_executed = existing_delivery.iter().any(|record| record.push_executed);
    let mut push_failed = existing_delivery.iter().any(|record| {
        record.command_kind == crate::GitBranchWorktreeRunnerCommandKind::PushRunBranch
            && record.outcome_status == GitBranchWorktreeRunnerOutcomeStatus::Failed
    });

    for command in ordered_delivery_commands(&ready) {
        if existing_ids.contains(&persisted_outcome_id(&command.command_id)) {
            continue;
        }
        let outcome = spawn_git_in(
            &GitBranchWorktreeRunnerExecutionInput {
                confirmation_ref: input.confirmation_ref.clone(),
                handoffs: input.handoffs.clone(),
                target_refs: input.target_refs.clone(),
                repo_working_directory: worktree_path.clone(),
                run_id: input.run_id.clone(),
                operator_ref: input.operator_ref.clone(),
                idempotency_key: input.idempotency_key.clone(),
                timeout: input.timeout,
                stdout_limit_bytes: input.stdout_limit_bytes,
                stderr_limit_bytes: input.stderr_limit_bytes,
            },
            &command,
            &worktree_path,
        )?;
        spawns.push(GitBranchWorktreeRunnerSpawnSummary {
            success: outcome.success,
            exit_status: outcome.exit_status,
            stdout_captured_bytes: outcome.stdout_captured_bytes,
            stderr_captured_bytes: outcome.stderr_captured_bytes,
            stdout_truncated: outcome.stdout_truncated,
            stderr_truncated: outcome.stderr_truncated,
        });
        let is_commit =
            command.command_kind == crate::GitBranchWorktreeRunnerCommandKind::CommitRunWorktree;
        let is_push =
            command.command_kind == crate::GitBranchWorktreeRunnerCommandKind::PushRunBranch;
        commit_created |= is_commit && outcome.success;
        push_executed |= is_push && outcome.success;
        push_failed |= is_push && !outcome.success;

        let status = if outcome.success {
            GitBranchWorktreeRunnerOutcomeStatus::Completed
        } else {
            GitBranchWorktreeRunnerOutcomeStatus::Failed
        };
        let command_set = crate::GitBranchWorktreeRunnerCommandAdapterSet {
            command_set_id: commands.command_set_id.clone(),
            commands: vec![command.clone()],
            skipped_authority_ids: Vec::new(),
            executable_argv_created: true,
            shell_passthrough_used: false,
            shell_execution_performed: false,
            checkout_executed: false,
            branch_created: false,
            worktree_created: false,
            commit_created,
            push_executed,
            no_effects: ForgeScmNoEffects::none(),
        };
        let persisted = persist_git_branch_worktree_runner_outcomes(
            state,
            crate::GitBranchWorktreeRunnerOutcomePersistenceInput {
                commands: command_set,
                requested_status: status,
                inspected_path_count: 1,
                affected_path_count: 1,
                evidence_refs: vec![input.confirmation_ref.clone()],
                existing_outcome_ids: existing_ids.clone(),
                shell_execution_performed: true,
                checkout_executed: false,
                branch_created: false,
                worktree_created: false,
                commit_created: is_commit && outcome.success,
                push_executed: is_push && outcome.success,
                raw_stdout_present: false,
                raw_stderr_present: false,
                provider_payload_present: false,
                raw_output_retention_requested: false,
                commit_requested: true,
                push_requested,
                delivery_authority_granted: true,
                pull_request_requested: false,
                forge_effect_requested: false,
                provider_effect_requested: false,
                callback_effect_requested: false,
                interruption_effect_requested: false,
                recovery_effect_requested: false,
                task_mutation_requested: false,
            },
        )
        .map_err(GitBranchWorktreeRunnerExecutionError::Persistence)?;
        existing_ids.extend(
            persisted
                .records
                .iter()
                .map(|record| record.persisted_outcome_id.clone()),
        );
        write_delivery_receipt(
            state,
            &input,
            &delivery_intent,
            &command,
            &outcome,
            commit_created,
            push_executed,
        )?;

        if !outcome.success {
            break;
        }
    }

    let all_outcomes = read_git_branch_worktree_runner_outcomes(state)
        .map_err(GitBranchWorktreeRunnerExecutionError::Persistence)?;
    let outcomes = all_outcomes
        .into_iter()
        .filter(|record| delivery_command_ids.contains(&record.persisted_outcome_id))
        .collect::<Vec<_>>();
    let command_set_id = commands.command_set_id.clone();
    Ok(GitBranchWorktreeRunnerDeliveryExecutionResult {
        authority,
        commands,
        outcomes: replayed_outcome_set(&command_set_id, outcomes),
        replayed: false,
        worktree_path,
        commit_created,
        push_executed,
        push_failed,
        spawns,
    })
}

fn ordered_delivery_commands(
    commands: &[GitBranchWorktreeRunnerCommandAdapterRecord],
) -> Vec<GitBranchWorktreeRunnerCommandAdapterRecord> {
    let order = |kind: &crate::GitBranchWorktreeRunnerCommandKind| match kind {
        crate::GitBranchWorktreeRunnerCommandKind::StageRunWorktree => 0,
        crate::GitBranchWorktreeRunnerCommandKind::CommitRunWorktree => 1,
        crate::GitBranchWorktreeRunnerCommandKind::PushRunBranch => 2,
        _ => 3,
    };
    let mut ordered = commands.to_vec();
    ordered.sort_by_key(|command| order(&command.command_kind));
    ordered
}

fn write_delivery_receipt<B>(
    state: &ServerStateService<B>,
    input: &GitBranchWorktreeRunnerDeliveryExecutionInput,
    intent: &GitBranchWorktreeRunnerDeliveryIntentRecord,
    command: &GitBranchWorktreeRunnerCommandAdapterRecord,
    outcome: &SpawnOutcome,
    commit_created: bool,
    push_executed: bool,
) -> Result<(), GitBranchWorktreeRunnerExecutionError>
where
    B: LocalStoreBackend,
{
    let (effect, status, summary) = match command.command_kind {
        crate::GitBranchWorktreeRunnerCommandKind::StageRunWorktree => (
            "staged",
            if outcome.success {
                EngineRuntimeReceiptStatus::Completed
            } else {
                EngineRuntimeReceiptStatus::Failed
            },
            format!("staged run {} worktree", input.run_id),
        ),
        crate::GitBranchWorktreeRunnerCommandKind::CommitRunWorktree => (
            "committed",
            if outcome.success {
                EngineRuntimeReceiptStatus::Completed
            } else {
                EngineRuntimeReceiptStatus::Failed
            },
            if outcome.success {
                format!(
                    "committed run {} locally with the operator-confirmed message",
                    input.run_id
                )
            } else {
                format!(
                    "commit failed for run {}; branch remains unpushed",
                    input.run_id
                )
            },
        ),
        crate::GitBranchWorktreeRunnerCommandKind::PushRunBranch => (
            "pushed",
            if outcome.success {
                EngineRuntimeReceiptStatus::Completed
            } else {
                EngineRuntimeReceiptStatus::Failed
            },
            if outcome.success {
                format!(
                    "pushed run {} branch {} to {}",
                    input.run_id, intent.branch_ref, intent.remote_target
                )
            } else {
                format!("run {} committed locally but push of {} to {} failed; delivery remains deliverable", input.run_id, intent.branch_ref, intent.remote_target)
            },
        ),
        _ => return Ok(()),
    };
    let receipt = EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:git-branch-worktree-runner-delivery:{}:{}:{}",
            input.run_id, input.idempotency_key, effect
        )),
        family: EngineRuntimeReceiptEffectFamily::CommandExecution,
        status,
        command_ref: Some(EngineRuntimeReceiptRef::Custom(command.command_id.clone())),
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(format!(
            "git-branch-worktree-runner:delivery-{effect}:{}",
            input.run_id
        ))),
        evidence_refs: vec![EngineRuntimeReceiptRef::Custom(input.confirmation_ref.clone())],
        artifact_refs: Vec::new(),
        summary: Some(format!("{summary} (commit_created={commit_created}, push_executed={push_executed}, exit_status={:?})", outcome.exit_status)),
    };
    write_runtime_receipt(
        state,
        &receipt,
        RevisionId(format!("rev:{}", receipt.receipt_id.0)),
        RevisionExpectation::MustNotExist,
    )
    .map(|_| ())
    .map_err(GitBranchWorktreeRunnerExecutionError::Persistence)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::process::Command as SystemCommand;
    use std::time::Duration;

    use nucleus_engine::EngineRuntimeReceiptRef;
    use nucleus_local_store::SqliteBackend;

    use super::*;
    use crate::provider_git_branch_worktree_runner_authority::intent::{
        write_git_branch_worktree_runner_delivery_intent,
        write_git_branch_worktree_runner_operator_effect_intent,
        GitBranchWorktreeRunnerDeliveryIntentStatus,
        GitBranchWorktreeRunnerOperatorEffectIntentRecord,
        GitBranchWorktreeRunnerOperatorEffectIntentStatus,
    };
    use crate::{
        git_branch_worktree_execution_handoff, read_runtime_receipts,
        GitBranchWorktreeAdmissionInput, GitBranchWorktreeCommandDescriptorsInput,
        GitBranchWorktreeExecutionHandoffInput, GitBranchWorktreePreflightInput,
        GitBranchWorktreeRunnerAuthorityBlocker, GitBranchWorktreeRunnerTargetRef,
    };

    const BRANCH_REF: &str = "run/run-1";
    const WORKTREE_LOCATION: &str = "../nucleus-wt/run-1";

    #[test]
    fn full_chain_creates_worktree_on_disk_with_worktree_created_and_receipt() {
        let (directory, repo) = temp_repo();
        let state = test_state(&directory);
        let handoffs = single_handoff(&handoffs(GitBranchWorktreeMode::IsolatedWorktree));
        let target_refs = target_refs(&handoffs);
        let wt_parent = directory.path().join("nucleus-wt");
        std::fs::create_dir_all(&wt_parent).expect("wt parent");

        write_git_branch_worktree_runner_operator_effect_intent(
            &state,
            confirmed_intent(&handoffs, "fixture-1"),
        )
        .expect("write");

        let result = run_git_branch_worktree_runner(
            &state,
            input(&repo, &handoffs, &target_refs, "fixture-1"),
        )
        .expect("run");

        assert!(!result.replayed);
        let worktree = result.worktree_path.expect("worktree path");
        assert_eq!(worktree, directory.path().join("nucleus-wt").join("run-1"));
        assert!(worktree.is_dir());
        assert!(worktree.join(".git").exists());
        assert_eq!(
            std::fs::read_to_string(worktree.join(".git")).expect("gitdir file"),
            format!(
                "gitdir: {}/.git/worktrees/run-1\n",
                std::fs::canonicalize(&repo)
                    .expect("canonical repo")
                    .display()
            )
        );
        assert!(result.outcomes.worktree_created);
        assert!(result.outcomes.shell_execution_performed);
        let record = &result.outcomes.records[0];
        assert!(record.worktree_created);
        assert!(record.branch_created);
        assert!(record.shell_execution_performed);
        assert_eq!(
            record.outcome_status,
            GitBranchWorktreeRunnerOutcomeStatus::Completed
        );
        assert_eq!(record.branch_ref.as_deref(), Some(BRANCH_REF));
        assert_eq!(
            record.worktree_location_ref.as_deref(),
            Some(WORKTREE_LOCATION)
        );
        let spawn = result.spawn.expect("spawn summary");
        assert!(spawn.success);
        assert_eq!(spawn.exit_status, Some(0));
        assert!(spawn.stdout_captured_bytes <= 4096);
        assert!(spawn.stderr_captured_bytes <= 4096);

        let receipts = read_runtime_receipts(&state).expect("receipts");
        assert!(receipts
            .iter()
            .any(
                |receipt| receipt.effect_ref.as_ref().is_some_and(|effect| effect
                    == &EngineRuntimeReceiptRef::Custom(
                        "git-branch-worktree-runner:worktree-created:run:1".to_owned()
                    ))
            ));
        let persisted = read_git_branch_worktree_runner_outcomes(&state).expect("outcomes");
        assert_eq!(persisted.len(), 1);
        assert!(persisted[0].worktree_created);

        // The branch exists in the worktree.
        let branch_check = SystemCommand::new("git")
            .args(["branch", "--show-current"])
            .current_dir(&worktree)
            .output()
            .expect("branch");
        assert_eq!(
            String::from_utf8(branch_check.stdout)
                .expect("branch name")
                .trim(),
            BRANCH_REF
        );
    }

    #[test]
    fn no_intent_blocks_before_spawn() {
        let (directory, repo) = temp_repo();
        let state = test_state(&directory);
        let handoffs = single_handoff(&handoffs(GitBranchWorktreeMode::IsolatedWorktree));
        let target_refs = target_refs(&handoffs);
        let wt_parent = directory.path().join("nucleus-wt");
        std::fs::create_dir_all(&wt_parent).expect("wt parent");

        let error = run_git_branch_worktree_runner(
            &state,
            input(&repo, &handoffs, &target_refs, "fixture-missing-intent"),
        )
        .expect_err("no intent must block");

        assert!(matches!(
            error,
            GitBranchWorktreeRunnerExecutionError::Blocked { ref blockers, .. }
                if blockers.contains(&GitBranchWorktreeRunnerAuthorityBlocker::OperatorEffectIntentMissing)
        ));
        assert!(!directory.path().join("nucleus-wt").join("run-1").exists());
        assert!(!result_authority_worktree_created(&error));
        assert!(read_git_branch_worktree_runner_outcomes(&state)
            .expect("outcomes")
            .is_empty());
        assert!(read_runtime_receipts(&state).expect("receipts").is_empty());
    }

    #[test]
    fn wrong_target_blocks_before_spawn() {
        let (directory, repo) = temp_repo();
        let state = test_state(&directory);
        let handoffs = single_handoff(&handoffs(GitBranchWorktreeMode::IsolatedWorktree));
        let wt_parent = directory.path().join("nucleus-wt");
        std::fs::create_dir_all(&wt_parent).expect("wt parent");

        // Missing worktree location ref on the approved target.
        write_git_branch_worktree_runner_operator_effect_intent(
            &state,
            confirmed_intent(&handoffs, "fixture-missing-location"),
        )
        .expect("write");
        let mut bad_targets = target_refs(&handoffs);
        bad_targets[0].worktree_location_ref = None;
        let missing_location = run_git_branch_worktree_runner(
            &state,
            input(&repo, &handoffs, &bad_targets, "fixture-missing-location"),
        )
        .expect_err("missing location must block");
        assert!(matches!(
            missing_location,
            GitBranchWorktreeRunnerExecutionError::Blocked { ref blockers, .. }
                if blockers.contains(&GitBranchWorktreeRunnerAuthorityBlocker::MissingIsolatedWorktreeLocationRef)
        ));

        // Target ref for a handoff that is not in the set.
        write_git_branch_worktree_runner_operator_effect_intent(
            &state,
            confirmed_intent(&handoffs, "fixture-stray-target"),
        )
        .expect("write");
        let stray_targets = vec![GitBranchWorktreeRunnerTargetRef {
            handoff_id: "git-branch-worktree-execution-handoff:stray".to_owned(),
            branch_ref: Some(BRANCH_REF.to_owned()),
            worktree_location_ref: Some(WORKTREE_LOCATION.to_owned()),
        }];
        let stray = run_git_branch_worktree_runner(
            &state,
            input(&repo, &handoffs, &stray_targets, "fixture-stray-target"),
        )
        .expect_err("stray target must block");
        assert!(matches!(
            stray,
            GitBranchWorktreeRunnerExecutionError::Blocked { ref blockers, .. }
                if blockers.contains(&GitBranchWorktreeRunnerAuthorityBlocker::MissingRunnerTarget)
        ));

        assert!(!directory.path().join("nucleus-wt").join("run-1").exists());
        assert!(read_git_branch_worktree_runner_outcomes(&state)
            .expect("outcomes")
            .is_empty());
        assert!(read_runtime_receipts(&state).expect("receipts").is_empty());
    }

    #[test]
    fn unconfirmed_intent_blocks_before_spawn() {
        let (directory, repo) = temp_repo();
        let state = test_state(&directory);
        let handoffs = single_handoff(&handoffs(GitBranchWorktreeMode::IsolatedWorktree));
        let target_refs = target_refs(&handoffs);
        let wt_parent = directory.path().join("nucleus-wt");
        std::fs::create_dir_all(&wt_parent).expect("wt parent");

        let mut intent = confirmed_intent(&handoffs, "fixture-unconfirmed");
        intent.allow_isolated_worktree_creation = false;
        write_git_branch_worktree_runner_operator_effect_intent(&state, intent).expect("write");

        let error = run_git_branch_worktree_runner(
            &state,
            input(&repo, &handoffs, &target_refs, "fixture-unconfirmed"),
        )
        .expect_err("unconfirmed intent must block");

        assert!(matches!(
            error,
            GitBranchWorktreeRunnerExecutionError::Blocked { ref blockers, .. }
                if blockers.contains(&GitBranchWorktreeRunnerAuthorityBlocker::IsolatedWorktreeCreationNotConfirmed)
        ));
        assert!(!directory.path().join("nucleus-wt").join("run-1").exists());
        assert!(read_git_branch_worktree_runner_outcomes(&state)
            .expect("outcomes")
            .is_empty());
    }

    #[test]
    fn repeat_dispatch_replays_without_second_spawn() {
        let (directory, repo) = temp_repo();
        let state = test_state(&directory);
        let handoffs = single_handoff(&handoffs(GitBranchWorktreeMode::IsolatedWorktree));
        let target_refs = target_refs(&handoffs);
        let wt_parent = directory.path().join("nucleus-wt");
        std::fs::create_dir_all(&wt_parent).expect("wt parent");
        write_git_branch_worktree_runner_operator_effect_intent(
            &state,
            confirmed_intent(&handoffs, "fixture-repeat"),
        )
        .expect("write");

        let first = run_git_branch_worktree_runner(
            &state,
            input(&repo, &handoffs, &target_refs, "fixture-repeat"),
        )
        .expect("first run");
        assert!(!first.replayed);
        assert!(first.outcomes.worktree_created);

        let second = run_git_branch_worktree_runner(
            &state,
            input(&repo, &handoffs, &target_refs, "fixture-repeat"),
        )
        .expect("second run");
        assert!(second.replayed);
        assert!(second.outcomes.worktree_created);
        assert!(second.spawn.is_none());
        assert_eq!(
            second.worktree_path,
            Some(directory.path().join("nucleus-wt").join("run-1"))
        );

        let persisted = read_git_branch_worktree_runner_outcomes(&state).expect("outcomes");
        assert_eq!(persisted.len(), 1);
        assert!(persisted[0].worktree_created);
        let receipts = read_runtime_receipts(&state).expect("receipts");
        assert_eq!(receipts.len(), 1);
    }

    #[test]
    fn delivery_commits_and_pushes_only_the_run_branch() {
        let (directory, repo) = temp_repo();
        let state = test_state(&directory);
        let remote = directory.path().join("remote.git");
        run_git(
            &directory.path().to_path_buf(),
            &["init", "--bare", "-q", remote.to_str().unwrap()],
        );
        run_git(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        let handoffs = single_handoff(&handoffs(GitBranchWorktreeMode::IsolatedWorktree));
        let targets = target_refs(&handoffs);
        std::fs::create_dir_all(directory.path().join("nucleus-wt")).expect("wt parent");
        write_git_branch_worktree_runner_operator_effect_intent(
            &state,
            confirmed_intent(&handoffs, "delivery-dispatch"),
        )
        .expect("dispatch intent");
        run_git_branch_worktree_runner(
            &state,
            input(&repo, &handoffs, &targets, "delivery-dispatch"),
        )
        .expect("worktree");
        let worktree = directory.path().join("nucleus-wt").join("run-1");
        std::fs::write(worktree.join("delivery.txt"), "delivered\n").expect("change");
        let delivery_key = "delivery-success";
        write_git_branch_worktree_runner_delivery_intent(
            &state,
            delivery_intent(&handoffs, delivery_key, "origin"),
        )
        .expect("delivery intent");

        let result = run_git_branch_worktree_runner_delivery(
            &state,
            delivery_input(&repo, &handoffs, &targets, delivery_key),
        )
        .expect("delivery");

        assert!(!result.replayed);
        assert!(result.commit_created);
        assert!(result.push_executed);
        assert!(!result.push_failed);
        assert_eq!(result.spawns.len(), 3);
        assert!(result.outcomes.commit_created);
        assert!(result.outcomes.push_executed);
        let branch = SystemCommand::new("git")
            .args(["ls-remote", remote.to_str().unwrap(), BRANCH_REF])
            .output()
            .expect("remote branch");
        assert!(branch.status.success());
        assert!(!branch.stdout.is_empty());
    }

    #[test]
    fn delivery_push_failure_keeps_local_commit_and_failed_receipt() {
        let (directory, repo) = temp_repo();
        let state = test_state(&directory);
        let handoffs = single_handoff(&handoffs(GitBranchWorktreeMode::IsolatedWorktree));
        let targets = target_refs(&handoffs);
        std::fs::create_dir_all(directory.path().join("nucleus-wt")).expect("wt parent");
        write_git_branch_worktree_runner_operator_effect_intent(
            &state,
            confirmed_intent(&handoffs, "delivery-failure-dispatch"),
        )
        .expect("dispatch intent");
        run_git_branch_worktree_runner(
            &state,
            input(&repo, &handoffs, &targets, "delivery-failure-dispatch"),
        )
        .expect("worktree");
        let worktree = directory.path().join("nucleus-wt").join("run-1");
        std::fs::write(worktree.join("delivery.txt"), "delivered\n").expect("change");
        let delivery_key = "delivery-push-failure";
        write_git_branch_worktree_runner_delivery_intent(
            &state,
            delivery_intent(&handoffs, delivery_key, "missing-remote"),
        )
        .expect("delivery intent");

        let result = run_git_branch_worktree_runner_delivery(
            &state,
            delivery_input(&repo, &handoffs, &targets, delivery_key),
        )
        .expect("delivery outcome");

        assert!(result.commit_created);
        assert!(!result.push_executed);
        assert!(result.push_failed);
        assert!(result.outcomes.commit_created);
        assert!(!result.outcomes.push_executed);
        let head = SystemCommand::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(worktree)
            .output()
            .expect("local head");
        assert!(head.status.success());
        let receipts = read_runtime_receipts(&state).expect("receipts");
        assert!(receipts.iter().any(|receipt| {
            receipt.status == EngineRuntimeReceiptStatus::Failed
                && receipt.summary.as_deref().is_some_and(|summary| {
                    summary.contains("committed locally")
                        && summary.contains("delivery remains deliverable")
                })
        }));
    }

    #[test]
    fn delivery_replays_without_second_spawn() {
        let (directory, repo) = temp_repo();
        let state = test_state(&directory);
        let remote = directory.path().join("remote.git");
        run_git(
            &directory.path().to_path_buf(),
            &["init", "--bare", "-q", remote.to_str().unwrap()],
        );
        run_git(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        let handoffs = single_handoff(&handoffs(GitBranchWorktreeMode::IsolatedWorktree));
        let targets = target_refs(&handoffs);
        std::fs::create_dir_all(directory.path().join("nucleus-wt")).expect("wt parent");
        write_git_branch_worktree_runner_operator_effect_intent(
            &state,
            confirmed_intent(&handoffs, "delivery-replay-dispatch"),
        )
        .expect("dispatch intent");
        run_git_branch_worktree_runner(
            &state,
            input(&repo, &handoffs, &targets, "delivery-replay-dispatch"),
        )
        .expect("worktree");
        std::fs::write(
            directory
                .path()
                .join("nucleus-wt")
                .join("run-1")
                .join("delivery.txt"),
            "delivered\n",
        )
        .expect("change");
        let delivery_key = "delivery-replay";
        write_git_branch_worktree_runner_delivery_intent(
            &state,
            delivery_intent(&handoffs, delivery_key, "origin"),
        )
        .expect("delivery intent");
        let first = run_git_branch_worktree_runner_delivery(
            &state,
            delivery_input(&repo, &handoffs, &targets, delivery_key),
        )
        .expect("first delivery");
        let second = run_git_branch_worktree_runner_delivery(
            &state,
            delivery_input(&repo, &handoffs, &targets, delivery_key),
        )
        .expect("replay delivery");
        assert!(!first.replayed);
        assert!(second.replayed);
        assert!(second.spawns.is_empty());
        assert!(second.commit_created);
        assert!(second.push_executed);
    }

    fn delivery_input(
        repo: &Path,
        handoffs: &GitBranchWorktreeExecutionHandoffSet,
        targets: &[GitBranchWorktreeRunnerTargetRef],
        idempotency_key: &str,
    ) -> GitBranchWorktreeRunnerDeliveryExecutionInput {
        GitBranchWorktreeRunnerDeliveryExecutionInput {
            confirmation_ref: format!(
                "operator-confirmation:git-branch-worktree-runner-delivery:{idempotency_key}"
            ),
            handoffs: handoffs.clone(),
            target_refs: targets.to_vec(),
            repo_working_directory: repo.to_path_buf(),
            run_id: "run:1".to_owned(),
            operator_ref: "operator:tom".to_owned(),
            idempotency_key: idempotency_key.to_owned(),
            timeout: Duration::from_secs(30),
            stdout_limit_bytes: 4096,
            stderr_limit_bytes: 4096,
        }
    }

    fn delivery_intent(
        handoffs: &GitBranchWorktreeExecutionHandoffSet,
        idempotency_key: &str,
        remote_target: &str,
    ) -> GitBranchWorktreeRunnerDeliveryIntentRecord {
        GitBranchWorktreeRunnerDeliveryIntentRecord {
            confirmation_ref: format!(
                "operator-confirmation:git-branch-worktree-runner-delivery:{idempotency_key}"
            ),
            run_id: "run:1".to_owned(),
            handoff_id: handoffs.handoffs[0].handoff_id.clone(),
            branch_ref: BRANCH_REF.to_owned(),
            worktree_location_ref: WORKTREE_LOCATION.to_owned(),
            commit_message: "deliver run 1".to_owned(),
            remote_target: remote_target.to_owned(),
            pull_request_creation: None,
            operator_ref: "operator:tom".to_owned(),
            idempotency_key: idempotency_key.to_owned(),
            status: GitBranchWorktreeRunnerDeliveryIntentStatus::Confirmed,
        }
    }

    fn result_authority_worktree_created(error: &GitBranchWorktreeRunnerExecutionError) -> bool {
        match error {
            GitBranchWorktreeRunnerExecutionError::Blocked { authority, .. } => {
                authority.worktree_created
            }
            _ => false,
        }
    }

    fn input(
        repo: &Path,
        handoffs: &GitBranchWorktreeExecutionHandoffSet,
        target_refs: &[GitBranchWorktreeRunnerTargetRef],
        idempotency_key: &str,
    ) -> GitBranchWorktreeRunnerExecutionInput {
        GitBranchWorktreeRunnerExecutionInput {
            confirmation_ref: format!(
                "operator-confirmation:git-branch-worktree-runner:{idempotency_key}"
            ),
            handoffs: handoffs.clone(),
            target_refs: target_refs.to_vec(),
            repo_working_directory: repo.to_path_buf(),
            run_id: "run:1".to_owned(),
            operator_ref: "operator:tom".to_owned(),
            idempotency_key: idempotency_key.to_owned(),
            timeout: Duration::from_secs(30),
            stdout_limit_bytes: 4096,
            stderr_limit_bytes: 4096,
        }
    }

    fn confirmed_intent(
        handoffs: &GitBranchWorktreeExecutionHandoffSet,
        idempotency_key: &str,
    ) -> GitBranchWorktreeRunnerOperatorEffectIntentRecord {
        GitBranchWorktreeRunnerOperatorEffectIntentRecord {
            confirmation_ref: format!(
                "operator-confirmation:git-branch-worktree-runner:{idempotency_key}"
            ),
            run_id: "run:1".to_owned(),
            handoff_id: handoffs.handoffs[0].handoff_id.clone(),
            branch_ref: BRANCH_REF.to_owned(),
            worktree_location_ref: WORKTREE_LOCATION.to_owned(),
            allow_primary_tree_checkout: false,
            allow_isolated_worktree_creation: true,
            operator_ref: "operator:tom".to_owned(),
            idempotency_key: idempotency_key.to_owned(),
            status: GitBranchWorktreeRunnerOperatorEffectIntentStatus::Confirmed,
        }
    }

    fn target_refs(
        handoffs: &GitBranchWorktreeExecutionHandoffSet,
    ) -> Vec<GitBranchWorktreeRunnerTargetRef> {
        handoffs
            .handoffs
            .iter()
            .map(|handoff| GitBranchWorktreeRunnerTargetRef {
                handoff_id: handoff.handoff_id.clone(),
                branch_ref: Some(BRANCH_REF.to_owned()),
                worktree_location_ref: Some(WORKTREE_LOCATION.to_owned()),
            })
            .collect()
    }

    fn handoffs(worktree_mode: GitBranchWorktreeMode) -> GitBranchWorktreeExecutionHandoffSet {
        git_branch_worktree_execution_handoff(GitBranchWorktreeExecutionHandoffInput {
            preflights: crate::git_branch_worktree_preflight_records(
                GitBranchWorktreePreflightInput {
                    descriptors: crate::git_branch_worktree_command_descriptors(
                        GitBranchWorktreeCommandDescriptorsInput {
                            admissions: crate::git_branch_worktree_admission_records(
                                GitBranchWorktreeAdmissionInput {
                                    evidence: evidence(),
                                    worktree_mode,
                                },
                            ),
                        },
                    ),
                    operator_confirmed: true,
                    working_tree_clean: true,
                    isolated_target_available: true,
                },
            ),
        })
    }

    /// One dispatch = one handoff. The generic change-request chain yields a
    /// branch and a commit preparation handoff; the run lane confirms a single
    /// isolated-worktree target, so fixtures trim the set to that handoff.
    fn single_handoff(
        handoffs: &GitBranchWorktreeExecutionHandoffSet,
    ) -> GitBranchWorktreeExecutionHandoffSet {
        GitBranchWorktreeExecutionHandoffSet {
            handoff_set_id: handoffs.handoff_set_id.clone(),
            handoffs: vec![handoffs.handoffs[0].clone()],
            skipped_preflight_ids: Vec::new(),
            shell_handoff_created: false,
            checkout_executed: false,
            branch_created: false,
            worktree_created: false,
            commit_created: false,
            push_executed: false,
            no_effects: crate::provider_no_effects::ForgeScmNoEffects::none(),
        }
    }

    fn evidence() -> crate::GitChangeRequestDryRunEvidenceSet {
        let handoffs =
            crate::git_change_request_dry_run_handoff(crate::GitChangeRequestDryRunHandoffInput {
                preflights: preflights(),
            });
        let outcomes = crate::git_change_request_dry_run_sanitized_outcomes(
            crate::GitChangeRequestDryRunSanitizedOutcomesInput {
                handoffs,
                requested_status: crate::GitChangeRequestDryRunOutcomeStatus::Completed,
                changed_path_count: 3,
                insertion_count: 10,
                deletion_count: 2,
            },
        );
        crate::git_change_request_dry_run_evidence(crate::GitChangeRequestDryRunEvidenceInput {
            outcomes,
        })
    }

    fn preflights() -> crate::GitChangeRequestPreflightSet {
        let adapter_plans = crate::scm_change_request_adapter_plan_records(
            crate::ScmChangeRequestAdapterPlanRecordsInput {
                preparations: vec![preparation()],
            },
        );
        let git_plans =
            crate::scm_change_request_git_like_plan(crate::ScmChangeRequestGitLikePlanInput {
                adapter_plans,
            });
        let authorities = crate::git_change_request_execution_authority(
            crate::GitChangeRequestExecutionAuthorityInput {
                git_plans,
                branch_authority_requested: true,
                commit_authority_requested: true,
                push_authority_requested: false,
                pull_request_authority_requested: false,
            },
        );
        let descriptors = crate::git_change_request_command_descriptors(
            crate::GitChangeRequestCommandDescriptorsInput { authorities },
        );
        let requests = crate::git_change_request_command_request_records(
            crate::GitChangeRequestCommandRequestRecordsInput { descriptors },
        );
        crate::git_change_request_preflight_records(crate::GitChangeRequestPreflightRecordsInput {
            requests,
            working_tree_available: true,
            operator_confirmed: true,
            dry_run_evidence_present: true,
        })
    }

    fn preparation() -> crate::ScmChangeRequestPrepPersistenceRecord {
        crate::ScmChangeRequestPrepPersistenceRecord {
            persisted_preparation_id: "prep:1".to_owned(),
            admission_id: "admission:1".to_owned(),
            decision_id: "decision:1".to_owned(),
            readiness_id: "readiness:1".to_owned(),
            workflow_id: "workflow:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: Some("work:1".to_owned()),
            completion_id: Some("completion:1".to_owned()),
            repo_id: "repo:1".to_owned(),
            operator_ref: "operator:tom".to_owned(),
            adapter_label: "git".to_owned(),
            workflow_label: "change-request".to_owned(),
            evidence_refs: vec!["evidence:1".to_owned()],
            admission_status: crate::ScmChangeRequestPrepAdmissionStatus::Admitted,
            admission_blockers: Vec::new(),
            status: crate::ScmChangeRequestPrepPersistenceStatus::Persisted,
            blockers: Vec::new(),
            duplicate_preparation_detected: false,
            branch_or_snapshot_authority_granted: false,
            commit_or_publish_authority_granted: false,
            push_or_remote_publish_authority_granted: false,
            forge_authority_granted: false,
            provider_authority_granted: false,
            callback_authority_granted: false,
            interruption_authority_granted: false,
            recovery_authority_granted: false,
            raw_output_retained: false,
        }
    }

    fn test_state(directory: &tempfile::TempDir) -> ServerStateService<SqliteBackend> {
        ServerStateService::new(SqliteBackend::new(directory.path().join("state.sqlite")))
    }

    fn temp_repo() -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().expect("directory");
        let repo = directory.path().join("repo");
        std::fs::create_dir(&repo).expect("repo");
        run_git(&repo, &["init", "-q"]);
        std::fs::write(repo.join("readme.md"), "# repo\n").expect("file");
        run_git(&repo, &["add", "readme.md"]);
        run_git(&repo, &["commit", "-q", "-m", "initial"]);
        (directory, repo)
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let status = SystemCommand::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?} failed");
    }
}
