//! Worker-finish delivery pipeline.
//!
//! This module keeps delivery orchestration separate from the run lifecycle
//! service. Validation runs first; the delivery intent is then durably recorded
//! before the existing branch/worktree runner is allowed to stage, commit, or
//! push. Only after those effects does the run transition to `delivered`.

use std::path::{Path, PathBuf};
use std::process::Command;

use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_engine::{
    decode_run_storage_record, EngineRunCloseout, EngineRunId, EngineRunLifecycleState,
};
use nucleus_local_store::LocalStoreBackend;

use super::git_branch_worktree_runner_commands::write_confirmed_delivery_effect_intent;
use super::handler::LocalControlRequestHandler;
use super::run_commands::handle_run_command;
use crate::commands::{
    RunCommand, RunDeliverCommand, RunDeliveryExecutionCommand, RunTransitionCommand,
};
use crate::control_api::{ServerCommandReceiptStatus, ServerControlError};
use crate::provider_git_branch_worktree_runner_authority::{
    run_dispatch_handoff_lane, run_dispatch_target_refs, run_git_branch_worktree_runner_delivery,
    GitBranchWorktreeRunnerDeliveryExecutionInput, GitBranchWorktreeRunnerExecutionError,
    RunDispatchLaneInput,
};
use crate::state::ServerStateService;

pub(crate) fn handle_run_delivery_execution<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: RunDeliveryExecutionCommand,
) -> ServerCommandReceiptStatus
where
    B: LocalStoreBackend + Clone,
{
    if command.operator_ref.trim().is_empty()
        || command.commit_message.trim().is_empty()
        || command.idempotency_key.trim().is_empty()
        || command.closeout_summary.trim().is_empty()
        || command.commit_message.contains('\0')
        || command.remote_target.starts_with('-')
        || command.remote_target.contains('\0')
    {
        return rejected(
            "run delivery requires closeout, operator, commit message, and idempotency key",
        );
    }

    let run = match load_run(
        handler.state(),
        &command.run_id,
        command.expected_revision.as_ref(),
    ) {
        Ok(run) => run,
        Err(error) => return ServerCommandReceiptStatus::Rejected(error),
    };
    if run.state != EngineRunLifecycleState::Running {
        return rejected(&format!(
            "run delivery requires a running run, not {:?}",
            run.state
        ));
    }
    let Some(worktree_ref) = run.worktree_ref.as_deref() else {
        return rejected("run delivery requires the realized isolated worktree");
    };
    let worktree = PathBuf::from(worktree_ref);
    if !worktree.is_dir() || !worktree.join(".git").exists() {
        return rejected("run delivery target is not an isolated Git worktree");
    }

    let validation = run_validation_hook(&worktree);
    let diff_summary = changed_file_summary(&worktree);
    let mut evidence_refs = command.closeout_evidence_refs.clone();
    evidence_refs.push(format!("validation:effigy-test-plan:{}", validation.status));
    evidence_refs.push(format!("changed-files:{}", diff_summary.changed_files));
    if !validation.passed {
        let reason = format!(
            "run delivery validation hook failed (exit_status={:?})",
            validation.exit_status
        );
        let _ = handle_run_command(
            handler,
            &format!("{command_id}:fail-validation"),
            RunCommand::Fail(RunTransitionCommand {
                run_id: command.run_id,
                operation_id: None,
                expected_revision: None,
                reason: Some(reason.clone()),
            }),
        );
        return rejected(&reason);
    }

    let Some(repo_root) = primary_repo_root(handler.state(), &run.project_id) else {
        return rejected("run delivery requires the project's primary repository");
    };
    let slug = run_slug(&command.run_id);
    let branch_ref = format!("run/{slug}");
    let worktree_location_ref = format!("../{}-wt/{slug}", repo_name(&repo_root));
    let lane = run_dispatch_handoff_lane(RunDispatchLaneInput {
        run_id: command.run_id.0.clone(),
        operator_ref: command.operator_ref.clone(),
    });
    let target_refs = run_dispatch_target_refs(&lane, &branch_ref, &worktree_location_ref);
    let confirmation_ref = delivery_confirmation_ref(&command.idempotency_key);

    // The durable per-delivery confirmation is written before the gated runner
    // sees any delivery command. This is the load-bearing authority boundary.
    let intent_status = write_confirmed_delivery_effect_intent(
        handler.state(),
        command_id,
        crate::provider_git_branch_worktree_runner_authority::GitBranchWorktreeRunnerDeliveryIntentRecord {
            confirmation_ref: confirmation_ref.clone(),
            run_id: command.run_id.0.clone(),
            handoff_id: lane.handoff_id.clone(),
            branch_ref: branch_ref.clone(),
            worktree_location_ref: worktree_location_ref.clone(),
            commit_message: command.commit_message.clone(),
            remote_target: command.remote_target.clone(),
            operator_ref: command.operator_ref.clone(),
            idempotency_key: command.idempotency_key.clone(),
            status: crate::provider_git_branch_worktree_runner_authority::GitBranchWorktreeRunnerDeliveryIntentStatus::Confirmed,
        },
    );
    if let ServerCommandReceiptStatus::Rejected(error) = intent_status {
        return ServerCommandReceiptStatus::Rejected(error);
    }

    let execution = run_git_branch_worktree_runner_delivery(
        handler.state(),
        GitBranchWorktreeRunnerDeliveryExecutionInput {
            confirmation_ref,
            handoffs: lane.handoffs,
            target_refs,
            repo_working_directory: repo_root,
            run_id: command.run_id.0.clone(),
            operator_ref: command.operator_ref,
            idempotency_key: command.idempotency_key,
            timeout: std::time::Duration::from_secs(60),
            stdout_limit_bytes: 4096,
            stderr_limit_bytes: 4096,
        },
    );
    let execution = match execution {
        Ok(execution) => execution,
        Err(error) => return rejected(&execution_error(error)),
    };
    if !execution.commit_created {
        return rejected("run delivery commit did not complete; run remains undelivered");
    }

    let mut closeout = EngineRunCloseout {
        summary: command.closeout_summary,
        evidence_refs,
        diff_ref: command.closeout_diff_ref,
    };
    closeout.evidence_refs.push(format!(
        "delivery:commit-created:{}",
        execution.commit_created
    ));
    closeout.evidence_refs.push(format!(
        "delivery:push-executed:{}",
        execution.push_executed
    ));

    handle_run_command(
        handler,
        &format!("{command_id}:delivered"),
        RunCommand::Deliver(RunDeliverCommand {
            run_id: command.run_id,
            closeout_summary: closeout.summary,
            closeout_evidence_refs: closeout.evidence_refs,
            closeout_diff_ref: closeout.diff_ref,
            expected_revision: None,
        }),
    )
}

struct ValidationResult {
    passed: bool,
    status: &'static str,
    exit_status: Option<i32>,
}

fn run_validation_hook(worktree: &Path) -> ValidationResult {
    match Command::new("effigy")
        .args(["test", "--plan"])
        .current_dir(worktree)
        .output()
    {
        Ok(output) => ValidationResult {
            passed: output.status.success(),
            status: if output.status.success() {
                "passed"
            } else {
                "failed"
            },
            exit_status: output.status.code(),
        },
        Err(_) => ValidationResult {
            passed: false,
            status: "unavailable",
            exit_status: None,
        },
    }
}

struct DiffSummary {
    changed_files: usize,
}

fn changed_file_summary(worktree: &Path) -> DiffSummary {
    let changed_files = Command::new("git")
        .args(["diff", "--name-only", "HEAD"])
        .current_dir(worktree)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter(|line| !line.trim().is_empty())
                .count()
        })
        .unwrap_or(0);
    DiffSummary { changed_files }
}

fn load_run<B>(
    state: &ServerStateService<B>,
    run_id: &EngineRunId,
    expected_revision: Option<&RevisionId>,
) -> Result<nucleus_engine::EngineRunStorageRecord, ServerControlError>
where
    B: LocalStoreBackend,
{
    let record = state
        .orchestration_runs()
        .get(&PersistenceRecordId(run_id.0.clone()))
        .map_err(|error| ServerControlError::StorageUnavailable {
            reason: format!("{error:?}"),
        })?
        .ok_or_else(|| ServerControlError::NotFound {
            reason: format!("run record not found: {}", run_id.0),
        })?;
    if let Some(expected_revision) = expected_revision {
        if &record.revision_id != expected_revision {
            return Err(ServerControlError::Conflict {
                reason: format!("run revision conflict for {}", run_id.0),
            });
        }
    }
    decode_run_storage_record(&record.payload.bytes).map_err(|error| {
        ServerControlError::InvalidRequest {
            reason: format!("run storage payload is invalid: {error:?}"),
        }
    })
}

fn primary_repo_root<B>(state: &ServerStateService<B>, project_id: &str) -> Option<PathBuf>
where
    B: LocalStoreBackend,
{
    let record = state
        .projects()
        .get(&PersistenceRecordId(project_id.to_owned()))
        .ok()??;
    let project = nucleus_projects::decode_project_storage_record(&record.payload.bytes).ok()?;
    project.primary_location().map(PathBuf::from)
}

fn repo_name(repo_root: &Path) -> String {
    repo_root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "repo".to_owned())
}

fn run_slug(run_id: &EngineRunId) -> String {
    run_id
        .0
        .strip_prefix("run:")
        .filter(|slug| !slug.is_empty())
        .unwrap_or(&run_id.0)
        .to_owned()
}

fn delivery_confirmation_ref(idempotency_key: &str) -> String {
    format!("operator-confirmation:git-branch-worktree-runner-delivery:{idempotency_key}")
}

fn execution_error(error: GitBranchWorktreeRunnerExecutionError) -> String {
    match error {
        GitBranchWorktreeRunnerExecutionError::Blocked {
            blockers, reason, ..
        } => format!("{reason}: {blockers:?}"),
        GitBranchWorktreeRunnerExecutionError::CommandNotReady { reason } => reason,
        GitBranchWorktreeRunnerExecutionError::SpawnFailed { reason } => reason,
        GitBranchWorktreeRunnerExecutionError::Persistence(error) => format!("{error:?}"),
    }
}

fn rejected(reason: &str) -> ServerCommandReceiptStatus {
    ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest {
        reason: reason.to_owned(),
    })
}
