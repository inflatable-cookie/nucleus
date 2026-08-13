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
use crate::provider_forge_pull_request_runner_authority::{
    run_forge_pull_request_creation, ForgePullRequestCreationAdapter,
    ForgePullRequestCreationExecutionError, ForgePullRequestCreationExecutionInput,
    ForgePullRequestCreationExecutionResult,
};
use crate::provider_git_branch_worktree_runner_authority::{
    run_dispatch_handoff_lane, run_dispatch_target_refs, run_git_branch_worktree_runner_delivery,
    GitBranchWorktreeRunnerDeliveryExecutionInput, GitBranchWorktreeRunnerExecutionError,
    RunDispatchLaneInput,
};
use crate::state::ServerStateService;

pub(crate) fn handle_run_delivery_execution<B, A>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: RunDeliveryExecutionCommand,
    forge_pr_creation_adapter: A,
) -> ServerCommandReceiptStatus
where
    B: LocalStoreBackend + Clone,
    A: ForgePullRequestCreationAdapter,
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

    // The confirmed PR-creation scope, when present, must be complete and
    // target the run's own pushed branch against a different base — the same
    // validation the standalone delivery confirmation command enforces.
    if let Some(scope) = command.pull_request_creation.as_ref() {
        if !scope.is_complete() {
            return rejected(
                "delivery PR-creation scope requires a complete forge provider, base branch, head branch, title source, and body source",
            );
        }
        if scope.head_branch != branch_ref {
            return rejected(
                "delivery PR-creation head branch must be the run's own branch",
            );
        }
        if scope.base_branch == branch_ref {
            return rejected(
                "delivery PR-creation base branch must differ from the run's own branch",
            );
        }
    }

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
            pull_request_creation: command.pull_request_creation.clone(),
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
            confirmation_ref: confirmation_ref.clone(),
            handoffs: lane.handoffs,
            target_refs,
            repo_working_directory: repo_root,
            run_id: command.run_id.0.clone(),
            operator_ref: command.operator_ref.clone(),
            idempotency_key: command.idempotency_key.clone(),
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

    // Forge PR creation after the gated push: only under the confirmed
    // delivery intent carrying PR-creation scope, through the forge
    // pull-request runner authority chain. Never a bare forge call. A
    // failed/blocked lane keeps the pushed-branch delivery standing with its
    // explaining receipt (the 101 packet) and the failure recorded on the
    // run closeout.
    if let Some(scope) = command.pull_request_creation.clone() {
        let pr = run_forge_pull_request_creation(
            handler.state(),
            ForgePullRequestCreationExecutionInput {
                confirmation_ref: confirmation_ref.clone(),
                preflights: crate::delivery_pull_request_creation_preflights(
                    &command.operator_ref,
                    &command.idempotency_key,
                    &scope,
                    execution.push_executed,
                    forge_credential_ready(handler.state()),
                ),
                run_id: command.run_id.0.clone(),
                operator_ref: command.operator_ref.clone(),
                idempotency_key: command.idempotency_key.clone(),
                timeout: std::time::Duration::from_secs(60),
                adapter: forge_pr_creation_adapter,
            },
        );
        match pr {
            Ok(result) => append_pr_creation_evidence(&mut closeout, &result),
            Err(error) => closeout
                .evidence_refs
                .push(format!("delivery:pr-lane-failed:{}", pr_lane_error(error))),
        }
    }

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

/// Append the PR-creation lane's evidence to the run closeout, mirroring the
/// forge PR-creation authority's fixture shape: created flag plus the
/// reference and link when the open (or adoption) produced them.
fn append_pr_creation_evidence(
    closeout: &mut EngineRunCloseout,
    result: &ForgePullRequestCreationExecutionResult,
) {
    closeout
        .evidence_refs
        .push(format!("delivery:pr-created:{}", result.pull_request_created));
    if let Some(reference) = result.pull_request_reference.as_deref() {
        closeout
            .evidence_refs
            .push(format!("delivery:pr-reference:{reference}"));
    }
    if let Some(url) = result.pull_request_url.as_deref() {
        closeout.evidence_refs.push(format!("delivery:pr-url:{url}"));
    }
}

fn pr_lane_error(error: ForgePullRequestCreationExecutionError) -> String {
    match error {
        ForgePullRequestCreationExecutionError::CommandNotReady { reason } => reason,
        ForgePullRequestCreationExecutionError::Persistence(error) => format!("{error:?}"),
    }
}

/// The pipeline's forge-credential readiness check: a persisted forge
/// credential-status refresh record with a ready status class is the
/// credential evidence (host-provider credential boundary). No record means
/// no ready credential and the PR lane records a blocked preflight.
fn forge_credential_ready<B>(state: &ServerStateService<B>) -> bool
where
    B: LocalStoreBackend,
{
    crate::read_forge_credential_status_refreshes(state)
        .map(|records| {
            records
                .iter()
                .any(|record| record.status_class == crate::ForgeCredentialStatusClass::Ready)
        })
        .unwrap_or(false)
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

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::process::Command as SystemCommand;

    use nucleus_engine::{decode_run_storage_record, EngineRunId, EngineRunLifecycleState};
    use nucleus_local_store::SqliteBackend;
    use nucleus_projects::ProjectId;

    use super::*;
    use crate::commands::{RunDispatchExecutionCommand, RunProposeCommand, RunTransitionCommand};
    use crate::project_seed::{seed_local_project_with_resource_root, LocalProjectSeed};
    use crate::provider_forge_pull_request_runner_authority::{
        admitted_delivery_forge_adapter, ForgePullRequestCreationError,
        ForgePullRequestCreationReference, ForgePullRequestCreationTestDouble,
    };
    use crate::request_handler::run_commands::handle_run_dispatch_execution;
    use crate::{
        persist_forge_credential_status_refreshes, read_runtime_receipts,
        ForgeCredentialStatusRefreshInput, ForgeCredentialStatusRefreshPersistenceInput,
        ForgeNetworkCredentialKind, ForgeNetworkCredentialResolutionBoundary,
        ForgeNetworkCredentialStatus, ForgeNetworkExecutionCredentialRef,
        ForgeNetworkExecutionOperationFamily, ForgePullRequestCreationScope,
        ForgePullRequestProvider, ForgePullRequestTextSource,
    };

    const RUN_ID: &str = "run:fixture";
    const SLUG: &str = "fixture";
    const BRANCH_REF: &str = "run/fixture";
    const PROJECT_ID: &str = "project:nucleus-local";

    #[test]
    fn pipeline_opens_pull_request_after_gated_push_and_records_reference() {
        let fixture = pipeline_fixture();
        seed_ready_forge_credential(&fixture.handler);
        let reference = reference("pr:42", Some("https://forge.example/pr/42"));
        let double = double(None, Ok(reference));

        let status = handle_run_delivery_execution(
            &fixture.handler,
            "command:run:delivery:fixture",
            delivery_command(Some(scope())),
            double.clone(),
        );

        assert!(matches!(
            status,
            ServerCommandReceiptStatus::AcceptedForStateMutation
        ));
        let closeout = delivered_closeout(&fixture.handler);
        assert!(closeout.evidence_refs.contains(&"delivery:commit-created:true".to_owned()));
        assert!(closeout.evidence_refs.contains(&"delivery:push-executed:true".to_owned()));
        assert!(closeout.evidence_refs.contains(&"delivery:pr-created:true".to_owned()));
        assert!(closeout.evidence_refs.contains(&"delivery:pr-reference:pr:42".to_owned()));
        assert!(closeout
            .evidence_refs
            .contains(&"delivery:pr-url:https://forge.example/pr/42".to_owned()));

        // One reconciliation and one admitted open; the receipt carries the link.
        assert_eq!(double.reconcile_call_count(), 1);
        assert_eq!(double.open_call_count(), 1);
        let receipts = read_runtime_receipts(&fixture.handler.state()).expect("receipts");
        assert!(receipts.iter().any(|receipt| {
            receipt.status == nucleus_engine::EngineRuntimeReceiptStatus::Completed
                && receipt.summary.as_deref().is_some_and(|summary| {
                    summary.contains("opened pull request pr:42")
                        && summary.contains("https://forge.example/pr/42")
                })
        }));
    }

    #[test]
    fn pipeline_no_remote_fallback_keeps_branch_packet_with_receipt() {
        let fixture = pipeline_fixture();
        let mut command = delivery_command(Some(scope()));
        command.remote_target = String::new();
        let double = double(None, Ok(reference("pr:1", None)));

        let status = handle_run_delivery_execution(
            &fixture.handler,
            "command:run:delivery:fixture",
            command,
            double.clone(),
        );

        assert!(matches!(
            status,
            ServerCommandReceiptStatus::AcceptedForStateMutation
        ));
        let closeout = delivered_closeout(&fixture.handler);
        assert!(closeout.evidence_refs.contains(&"delivery:commit-created:true".to_owned()));
        assert!(closeout.evidence_refs.contains(&"delivery:push-executed:false".to_owned()));
        assert!(closeout.evidence_refs.contains(&"delivery:pr-created:false".to_owned()));
        assert!(!closeout
            .evidence_refs
            .iter()
            .any(|reference| reference.starts_with("delivery:pr-reference:")));
        assert_eq!(double.reconcile_call_count(), 0);
        assert_eq!(double.open_call_count(), 0);
        let receipts = read_runtime_receipts(&fixture.handler.state()).expect("receipts");
        assert!(receipts.iter().any(|receipt| {
            receipt.summary.as_deref().is_some_and(|summary| {
                summary.contains("no confirmed remote")
                    && summary.contains("branch-only delivery preserved")
            })
        }));
    }

    #[test]
    fn pipeline_no_credential_preflight_blocks_with_explaining_receipt() {
        let fixture = pipeline_fixture();
        let double = double(None, Ok(reference("pr:1", None)));

        let status = handle_run_delivery_execution(
            &fixture.handler,
            "command:run:delivery:fixture",
            delivery_command(Some(scope())),
            double.clone(),
        );

        assert!(matches!(
            status,
            ServerCommandReceiptStatus::AcceptedForStateMutation
        ));
        let closeout = delivered_closeout(&fixture.handler);
        assert!(closeout.evidence_refs.contains(&"delivery:pr-created:false".to_owned()));
        assert!(!closeout
            .evidence_refs
            .iter()
            .any(|reference| reference.starts_with("delivery:pr-reference:")));
        assert_eq!(double.reconcile_call_count(), 0);
        assert_eq!(double.open_call_count(), 0);
        let receipts = read_runtime_receipts(&fixture.handler.state()).expect("receipts");
        assert!(receipts.iter().any(|receipt| {
            receipt.status == nucleus_engine::EngineRuntimeReceiptStatus::Failed
                && receipt.summary.as_deref().is_some_and(|summary| {
                    summary.contains("ForgeCredentialNotReady")
                        && summary.contains("branch-only delivery preserved")
                })
        }));
    }

    #[test]
    fn pipeline_pr_api_failure_records_failure_and_delivers_branch() {
        let fixture = pipeline_fixture();
        seed_ready_forge_credential(&fixture.handler);
        let double = double(
            None,
            Err(ForgePullRequestCreationError::ApiFailure {
                reason: "422 validation failed".to_owned(),
            }),
        );

        let status = handle_run_delivery_execution(
            &fixture.handler,
            "command:run:delivery:fixture",
            delivery_command(Some(scope())),
            double.clone(),
        );

        assert!(matches!(
            status,
            ServerCommandReceiptStatus::AcceptedForStateMutation
        ));
        let closeout = delivered_closeout(&fixture.handler);
        assert!(closeout.evidence_refs.contains(&"delivery:pr-created:false".to_owned()));
        assert!(!closeout
            .evidence_refs
            .iter()
            .any(|reference| reference.starts_with("delivery:pr-reference:")));
        assert_eq!(double.reconcile_call_count(), 1);
        assert_eq!(double.open_call_count(), 1);
        let receipts = read_runtime_receipts(&fixture.handler.state()).expect("receipts");
        assert!(receipts.iter().any(|receipt| {
            receipt.status == nucleus_engine::EngineRuntimeReceiptStatus::Failed
                && receipt.summary.as_deref().is_some_and(|summary| {
                    summary.contains("422 validation failed")
                        && summary.contains("branch-only delivery preserved")
                })
        }));
    }

    #[test]
    fn pipeline_default_adapter_records_no_admitted_route_fallback() {
        let fixture = pipeline_fixture();
        seed_ready_forge_credential(&fixture.handler);

        let status = handle_run_delivery_execution(
            &fixture.handler,
            "command:run:delivery:fixture",
            delivery_command(Some(scope())),
            admitted_delivery_forge_adapter(),
        );

        assert!(matches!(
            status,
            ServerCommandReceiptStatus::AcceptedForStateMutation
        ));
        let closeout = delivered_closeout(&fixture.handler);
        assert!(closeout.evidence_refs.contains(&"delivery:pr-created:false".to_owned()));
        let receipts = read_runtime_receipts(&fixture.handler.state()).expect("receipts");
        assert!(receipts.iter().any(|receipt| {
            receipt.summary.as_deref().is_some_and(|summary| {
                summary.contains("no admitted forge provider route")
                    && summary.contains("branch-only delivery preserved")
            })
        }));
    }

    #[test]
    fn pipeline_rejects_scope_whose_head_is_not_the_run_branch() {
        let fixture = pipeline_fixture();
        let mut command = delivery_command(Some(scope()));
        command.pull_request_creation = Some(ForgePullRequestCreationScope {
            head_branch: "run/other".to_owned(),
            ..scope()
        });

        let status = handle_run_delivery_execution(
            &fixture.handler,
            "command:run:delivery:fixture",
            command,
            double(None, Ok(reference("pr:1", None))),
        );

        assert!(matches!(
            status,
            ServerCommandReceiptStatus::Rejected(_)
        ));
    }

    struct PipelineFixture {
        _temp: tempfile::TempDir,
        handler: LocalControlRequestHandler<SqliteBackend>,
    }

    fn pipeline_fixture() -> PipelineFixture {
        let temp = tempfile::tempdir().expect("temp dir");
        let handler = LocalControlRequestHandler::new(
            SqliteBackend::new(temp.path().join("state.sqlite")),
            None,
        );
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(&repo).expect("repo dir");
        run_git(&repo, &["init", "-q", "-b", "main"]);
        run_git(&repo, &["config", "user.email", "fixture@example.com"]);
        run_git(&repo, &["config", "user.name", "fixture"]);
        std::fs::write(repo.join("readme.md"), "# fixture\n").expect("readme");
        run_git(&repo, &["add", "readme.md"]);
        run_git(&repo, &["commit", "-q", "-m", "initial"]);
        let remote = temp.path().join("remote.git");
        run_git(
            &repo,
            &["init", "--bare", "-q", remote.to_str().expect("remote path")],
        );
        run_git(
            &repo,
            &["remote", "add", "origin", remote.to_str().expect("remote path")],
        );
        seed_local_project_with_resource_root(
            handler.state(),
            LocalProjectSeed::nucleus_local(),
            Some(repo.clone()),
        )
        .expect("seed project");

        // The host flow: propose -> operator-confirmed dispatch (gated
        // worktree creation) -> running.
        let status = handle_run_command(
            &handler,
            "command:run:propose:fixture",
            RunCommand::Propose(RunProposeCommand {
                run_id: EngineRunId(RUN_ID.to_owned()),
                project_id: ProjectId(PROJECT_ID.to_owned()),
                objective_scope: "deliver fixture".to_owned(),
                acceptance: vec!["fixture delivered".to_owned()],
                stop_conditions: Vec::new(),
                worktree_ref: None,
                provider_instance: "provider:test".to_owned(),
                provider_model: "model:test".to_owned(),
                orchestrator_designation: None,
                token_budget: None,
                time_budget_seconds: None,
            }),
        );
        assert!(matches!(
            status,
            ServerCommandReceiptStatus::AcceptedForStateMutation
        ));
        let status = handle_run_dispatch_execution(
            &handler,
            "command:run:dispatch:fixture",
            RunDispatchExecutionCommand {
                run_id: EngineRunId(RUN_ID.to_owned()),
                expected_revision: None,
                operator_ref: "operator:tom".to_owned(),
            },
        );
        assert!(
            matches!(
                status,
                ServerCommandReceiptStatus::AcceptedForStateMutation
            ),
            "dispatch status: {status:?}"
        );
        let status = handle_run_command(
            &handler,
            "command:run:running:fixture",
            RunCommand::MarkRunning(RunTransitionCommand {
                run_id: EngineRunId(RUN_ID.to_owned()),
                operation_id: Some("operation:fixture".to_owned()),
                expected_revision: None,
                reason: None,
            }),
        );
        assert!(matches!(
            status,
            ServerCommandReceiptStatus::AcceptedForStateMutation
        ));

        // The worker's change plus a Cargo workspace so the validation hook's
        // `effigy test --plan` passes.
        let worktree = temp.path().join("repo-wt").join(SLUG);
        std::fs::write(worktree.join("delivery.txt"), "delivered\n").expect("change");
        std::fs::write(
            worktree.join("Cargo.toml"),
            "[workspace]\nmembers = []\nresolver = \"2\"\n",
        )
        .expect("cargo manifest");

        PipelineFixture {
            _temp: temp,
            handler,
        }
    }

    fn delivery_command(
        pull_request_creation: Option<ForgePullRequestCreationScope>,
    ) -> RunDeliveryExecutionCommand {
        RunDeliveryExecutionCommand {
            run_id: EngineRunId(RUN_ID.to_owned()),
            closeout_summary: "delivered fixture".to_owned(),
            closeout_evidence_refs: vec!["turn:fixture".to_owned()],
            closeout_diff_ref: Some("worktree:fixture".to_owned()),
            operator_ref: "operator:tom".to_owned(),
            commit_message: "Deliver run:fixture".to_owned(),
            remote_target: "origin".to_owned(),
            pull_request_creation,
            idempotency_key: "delivery:fixture".to_owned(),
            expected_revision: None,
        }
    }

    fn scope() -> ForgePullRequestCreationScope {
        ForgePullRequestCreationScope {
            forge_provider: ForgePullRequestProvider::GitHub,
            base_branch: "main".to_owned(),
            head_branch: BRANCH_REF.to_owned(),
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

    fn seed_ready_forge_credential(handler: &LocalControlRequestHandler<SqliteBackend>) {
        let refresh_set = crate::forge_credential_status_refresh(ForgeCredentialStatusRefreshInput {
            credential_refs: vec![ForgeNetworkExecutionCredentialRef {
                credential_ref_id: "credential:fixture:github".to_owned(),
                credential_kind: ForgeNetworkCredentialKind::HostCredentialProvider,
                resolution_boundary:
                    ForgeNetworkCredentialResolutionBoundary::HostCredentialProvider,
                status: ForgeNetworkCredentialStatus::Ready,
                allowed_operation_families: vec![
                    ForgeNetworkExecutionOperationFamily::ProviderAuthStatusRefresh,
                ],
            }],
            provider_context_ref: Some("provider-context:fixture:github".to_owned()),
            status_refresh_evidence_ref: Some("evidence:fixture:credential-status".to_owned()),
            sanitization_policy_ref: Some("sanitize:fixture".to_owned()),
            credential_material_present: false,
            provider_payload_present: false,
            raw_provider_payload_retention_requested: false,
            real_credential_resolution_requested: false,
            provider_network_call_requested: false,
            callback_execution_requested: false,
            interruption_execution_requested: false,
            recovery_execution_requested: false,
            task_mutation_requested: false,
        });
        persist_forge_credential_status_refreshes(
            handler.state(),
            ForgeCredentialStatusRefreshPersistenceInput {
                refresh_set,
                evidence_refs: vec!["evidence:fixture:credential-status".to_owned()],
                existing_persisted_refresh_ids: Vec::new(),
                credential_material_present: false,
                provider_payload_present: false,
                raw_provider_payload_retention_requested: false,
                real_credential_resolution_requested: false,
                provider_network_call_requested: false,
                callback_execution_requested: false,
                interruption_execution_requested: false,
                recovery_execution_requested: false,
                task_mutation_requested: false,
            },
        )
        .expect("seed credential");
    }

    fn delivered_closeout(
        handler: &LocalControlRequestHandler<SqliteBackend>,
    ) -> nucleus_engine::EngineRunCloseout {
        let stored = handler
            .state()
            .orchestration_runs()
            .get(&PersistenceRecordId(RUN_ID.to_owned()))
            .expect("run get")
            .expect("run record");
        let run = decode_run_storage_record(&stored.payload.bytes).expect("decode run");
        assert_eq!(run.state, EngineRunLifecycleState::Delivered);
        run.closeout.expect("closeout")
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
