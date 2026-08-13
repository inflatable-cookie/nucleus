//! Delivery-review read surface for one delivered run.
//!
//! Review is a read path over the run aggregate: the closeout (summary,
//! evidence refs, validation result) beside the run branch's diff against its
//! fork point (`base_ref`, bound at dispatch). Accept/reject are registry
//! transitions through the ordinary run command path; this module never
//! mutates the run, the worktree, or the registry.

use std::path::{Path, PathBuf};
use std::process::Command;

use nucleus_engine::{
    decode_run_storage_record, EngineRunCloseout, EngineRunId, EngineRunLifecycleState,
    EngineRunStorageRecord, EngineRunTransitionRecord,
};
use nucleus_local_store::LocalStoreBackend;

use super::handler::LocalControlRequestHandler;
use crate::control_api::{
    OrchestrationRunReviewPatchQuery, OrchestrationRunReviewQuery, ServerControlError,
    ServerQueryResult,
};
use crate::state::ServerStateService;

/// One delivered run's review read model.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrchestrationRunReview {
    pub project_id: String,
    pub run_id: String,
    pub state: EngineRunLifecycleState,
    pub objective_scope: String,
    pub acceptance: Vec<String>,
    pub stop_conditions: Vec<String>,
    pub provider_instance: String,
    pub provider_model: String,
    pub orchestrator_designation: Option<String>,
    pub worktree_ref: Option<String>,
    pub base_ref: Option<String>,
    pub conversation_id: Option<String>,
    pub closeout: Option<EngineRunCloseout>,
    pub transitions: Vec<EngineRunTransitionRecord>,
    pub created_at: u64,
    pub updated_at: u64,
    /// Parsed from the closeout evidence refs written by the delivery
    /// pipeline (`validation:effigy-test-plan:<status>`, `changed-files:N`,
    /// `delivery:commit-created:true|false`, `delivery:push-executed:...`).
    pub validation: RunReviewValidation,
    /// The run branch's diff against the fork point, when computable.
    pub diff: RunReviewDiffOverview,
}

/// Parsed validation evidence from a delivered run's closeout.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RunReviewValidation {
    pub status: Option<String>,
    pub changed_files: Option<u64>,
    pub commit_created: Option<bool>,
    pub push_executed: Option<bool>,
}

/// File-level diff overview for the review surface.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunReviewDiffOverview {
    pub base_ref: Option<String>,
    pub available: bool,
    pub unreachable_reason: Option<String>,
    pub files: Vec<RunReviewDiffFile>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunReviewDiffFile {
    pub path: String,
    pub change_kind: String,
    pub additions: u64,
    pub deletions: u64,
}

/// One file's unified diff patch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrchestrationRunReviewPatch {
    pub run_id: String,
    pub file_ref: String,
    pub available: bool,
    pub unreachable_reason: Option<String>,
    pub patch: Option<String>,
    pub additions: u64,
    pub deletions: u64,
    pub truncated: bool,
}

pub(super) fn orchestration_run_review_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: OrchestrationRunReviewQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let run = load_run(handler.state(), &query.run_id)?;
    if run.project_id != query.project_id.0 {
        return Err(ServerControlError::NotFound {
            reason: format!("run record not found: {}", query.run_id.0),
        });
    }

    let validation = parse_validation(run.closeout.as_ref());
    let diff = diff_overview(&run);

    Ok(ServerQueryResult::OrchestrationRunReview(OrchestrationRunReview {
        project_id: run.project_id.clone(),
        run_id: run.run_id.0.clone(),
        state: run.state,
        objective_scope: run.objective.scope.clone(),
        acceptance: run.objective.acceptance.clone(),
        stop_conditions: run.objective.stop_conditions.clone(),
        provider_instance: run.provider_instance.clone(),
        provider_model: run.provider_model.clone(),
        orchestrator_designation: run.orchestrator_designation.clone(),
        worktree_ref: run.worktree_ref.clone(),
        base_ref: run.base_ref.clone(),
        conversation_id: run.conversation_id.clone(),
        closeout: run.closeout.clone(),
        transitions: run.transitions.clone(),
        created_at: run.created_at,
        updated_at: run.updated_at,
        validation,
        diff,
    }))
}

pub(super) fn orchestration_run_review_patch_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: OrchestrationRunReviewPatchQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let run = load_run(handler.state(), &query.run_id)?;
    if run.project_id != query.project_id.0 {
        return Err(ServerControlError::NotFound {
            reason: format!("run record not found: {}", query.run_id.0),
        });
    }

    Ok(ServerQueryResult::OrchestrationRunReviewPatch(
        diff_patch(&run, &query.file_ref),
    ))
}

fn load_run<B>(
    state: &ServerStateService<B>,
    run_id: &EngineRunId,
) -> Result<EngineRunStorageRecord, ServerControlError>
where
    B: LocalStoreBackend,
{
    let record = state
        .orchestration_runs()
        .get(&nucleus_core::PersistenceRecordId(run_id.0.clone()))
        .map_err(|error| ServerControlError::StorageUnavailable {
            reason: format!("{error:?}"),
        })?
        .ok_or_else(|| ServerControlError::NotFound {
            reason: format!("run record not found: {}", run_id.0),
        })?;
    decode_run_storage_record(&record.payload.bytes).map_err(|error| {
        ServerControlError::InvalidRequest {
            reason: format!("run storage payload is invalid: {error:?}"),
        }
    })
}

/// Parse the structured delivery evidence out of the closeout evidence refs.
fn parse_validation(closeout: Option<&EngineRunCloseout>) -> RunReviewValidation {
    let Some(closeout) = closeout else {
        return RunReviewValidation::default();
    };
    let mut validation = RunReviewValidation::default();
    for evidence in &closeout.evidence_refs {
        if let Some(status) = evidence.strip_prefix("validation:effigy-test-plan:") {
            validation.status = Some(status.to_owned());
        } else if let Some(count) = evidence.strip_prefix("changed-files:") {
            validation.changed_files = count.parse().ok();
        } else if let Some(created) = evidence.strip_prefix("delivery:commit-created:") {
            validation.commit_created = created.parse().ok();
        } else if let Some(pushed) = evidence.strip_prefix("delivery:push-executed:") {
            validation.push_executed = pushed.parse().ok();
        }
    }
    validation
}

fn diff_overview(run: &EngineRunStorageRecord) -> RunReviewDiffOverview {
    let Some(worktree) = run.worktree_ref.as_deref() else {
        return RunReviewDiffOverview {
            base_ref: run.base_ref.clone(),
            available: false,
            unreachable_reason: Some("run has no realized worktree".to_owned()),
            files: Vec::new(),
            truncated: false,
        };
    };
    let Some(base_ref) = run.base_ref.as_deref() else {
        return RunReviewDiffOverview {
            base_ref: None,
            available: false,
            unreachable_reason: Some("run has no recorded diff base".to_owned()),
            files: Vec::new(),
            truncated: false,
        };
    };

    let worktree = PathBuf::from(worktree);
    if !worktree.is_dir() || !worktree.join(".git").exists() {
        return RunReviewDiffOverview {
            base_ref: Some(base_ref.to_owned()),
            available: false,
            unreachable_reason: Some("run worktree is not present".to_owned()),
            files: Vec::new(),
            truncated: false,
        };
    }

    // Read-only, bounded git diff: the base ref and worktree are server-bound
    // at dispatch, never client input. Mirrors the delivery pipeline's
    // evidence reads.
    let output = Command::new("git")
        .args(["diff", "--numstat", "--no-renames", base_ref, "HEAD"])
        .current_dir(&worktree)
        .output()
        .ok();
    let Some(output) = output else {
        return RunReviewDiffOverview {
            base_ref: Some(base_ref.to_owned()),
            available: false,
            unreachable_reason: Some("git diff is unavailable".to_owned()),
            files: Vec::new(),
            truncated: false,
        };
    };
    if !output.status.success() {
        return RunReviewDiffOverview {
            base_ref: Some(base_ref.to_owned()),
            available: false,
            unreachable_reason: Some(format!("git diff failed (exit {:?})", output.status.code())),
            files: Vec::new(),
            truncated: false,
        };
    }

    const MAX_FILES: usize = 5_000;
    let mut files = Vec::new();
    let mut truncated = false;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if files.len() >= MAX_FILES {
            truncated = true;
            break;
        }
        let mut parts = line.splitn(3, '\t');
        let (Some(added), Some(deleted), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let additions = added.parse::<u64>().unwrap_or(0);
        let deletions = deleted.parse::<u64>().unwrap_or(0);
        if path.trim().is_empty() {
            continue;
        }
        files.push(RunReviewDiffFile {
            path: path.to_owned(),
            change_kind: change_kind(additions, deletions),
            additions,
            deletions,
        });
    }

    RunReviewDiffOverview {
        base_ref: Some(base_ref.to_owned()),
        available: true,
        unreachable_reason: None,
        files,
        truncated,
    }
}

fn change_kind(additions: u64, deletions: u64) -> String {
    if additions > 0 && deletions == 0 {
        "added".to_owned()
    } else if deletions > 0 && additions == 0 {
        "deleted".to_owned()
    } else {
        "modified".to_owned()
    }
}

fn diff_patch(run: &EngineRunStorageRecord, file_ref: &str) -> OrchestrationRunReviewPatch {
    let unavailable = |reason: &str| OrchestrationRunReviewPatch {
        run_id: run.run_id.0.clone(),
        file_ref: file_ref.to_owned(),
        available: false,
        unreachable_reason: Some(reason.to_owned()),
        patch: None,
        additions: 0,
        deletions: 0,
        truncated: false,
    };
    let Some(worktree) = run.worktree_ref.as_deref() else {
        return unavailable("run has no realized worktree");
    };
    let Some(base_ref) = run.base_ref.as_deref() else {
        return unavailable("run has no recorded diff base");
    };
    if file_ref.trim().is_empty()
        || file_ref.starts_with('-')
        || file_ref.contains('\0')
        || Path::new(file_ref).is_absolute()
        || file_ref.split('/').any(|part| part == "..")
    {
        return unavailable("file ref is not a safe relative worktree path");
    }

    let worktree = PathBuf::from(worktree);
    if !worktree.is_dir() || !worktree.join(".git").exists() {
        return unavailable("run worktree is not present");
    }

    let output = Command::new("git")
        .args(["diff", "--no-renames", base_ref, "HEAD", "--", file_ref])
        .current_dir(&worktree)
        .output()
        .ok();
    let Some(output) = output else {
        return unavailable("git diff is unavailable");
    };
    if !output.status.success() {
        return unavailable(&format!("git diff failed (exit {:?})", output.status.code()));
    }
    let patch = String::from_utf8_lossy(&output.stdout).into_owned();
    let (additions, deletions) = count_patch_lines(&patch);

    OrchestrationRunReviewPatch {
        run_id: run.run_id.0.clone(),
        file_ref: file_ref.to_owned(),
        available: true,
        unreachable_reason: None,
        patch: Some(patch),
        additions,
        deletions,
        truncated: false,
    }
}

fn count_patch_lines(patch: &str) -> (u64, u64) {
    let mut additions = 0;
    let mut deletions = 0;
    for line in patch.lines() {
        if line.starts_with("+++ ") || line.starts_with("--- ") || line.starts_with("diff ")
            || line.starts_with("@@") || line.starts_with("index ") || line.starts_with("new file")
            || line.starts_with("deleted file") || line.starts_with("similarity ")
            || line.starts_with("rename ") || line.starts_with("old mode ")
            || line.starts_with("new mode ") || line.starts_with("Binary files ")
        {
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }
    (additions, deletions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_parses_delivery_evidence_refs() {
        let closeout = EngineRunCloseout {
            summary: "done".to_owned(),
            evidence_refs: vec![
                "turn:turn:1".to_owned(),
                "validation:effigy-test-plan:passed".to_owned(),
                "changed-files:3".to_owned(),
                "delivery:commit-created:true".to_owned(),
                "delivery:push-executed:false".to_owned(),
            ],
            diff_ref: None,
        };
        let validation = parse_validation(Some(&closeout));
        assert_eq!(validation.status.as_deref(), Some("passed"));
        assert_eq!(validation.changed_files, Some(3));
        assert_eq!(validation.commit_created, Some(true));
        assert_eq!(validation.push_executed, Some(false));
    }

    #[test]
    fn validation_is_empty_without_closeout() {
        assert_eq!(parse_validation(None), RunReviewValidation::default());
    }

    #[test]
    fn change_kind_reflects_numstat_shape() {
        assert_eq!(change_kind(4, 0), "added");
        assert_eq!(change_kind(0, 2), "deleted");
        assert_eq!(change_kind(1, 1), "modified");
    }

    #[test]
    fn patch_counts_skip_headers_and_meta_lines() {
        let patch = "\
diff --git a/a.rs b/a.rs
index 111..222 100644
--- a/a.rs
+++ b/a.rs
@@ -1,2 +1,3 @@
 fn main() {
-    old();
+    new();
 }
++added-line
";
        let (additions, deletions) = count_patch_lines(patch);
        assert_eq!(additions, 2);
        assert_eq!(deletions, 1);
    }

    // ---- end-to-end review query fixtures over persisted runs ----

    use nucleus_core::{
        PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId,
    };
    use nucleus_engine::{
        encode_run_storage_record, EngineRunBudgetEnvelope, EngineRunId, EngineRunObjective,
    };
    use nucleus_local_store::{
        LocalStoreBackend, LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation,
        SqliteBackend,
    };
    use nucleus_projects::ProjectId;

    use crate::request_handler::handler::LocalControlRequestHandler;
    use crate::request_handler::run_review::{
        orchestration_run_review_patch_query, orchestration_run_review_query,
    };

    #[test]
    fn review_query_returns_closeout_validation_and_branch_diff() {
        let (_directory, worktree, base_ref) = temp_repo_with_branch_commit();
        let (_temp_dir, handler) = handler();

        let run = EngineRunStorageRecord {
            run_id: EngineRunId("run:delivered:1".to_owned()),
            project_id: "project:1".to_owned(),
            objective: EngineRunObjective {
                scope: "implement the review surface".to_owned(),
                acceptance: vec!["diff renders".to_owned()],
                stop_conditions: Vec::new(),
            },
            worktree_ref: Some(worktree.display().to_string()),
            base_ref: Some(base_ref.clone()),
            provider_instance: "provider:codex".to_owned(),
            provider_model: "codex-mini".to_owned(),
            orchestrator_designation: None,
            operation_id: None,
            conversation_id: None,
            state: EngineRunLifecycleState::Delivered,
            budget: EngineRunBudgetEnvelope::default(),
            closeout: Some(EngineRunCloseout {
                summary: "worker finished".to_owned(),
                evidence_refs: vec![
                    "turn:turn:1".to_owned(),
                    "validation:effigy-test-plan:passed".to_owned(),
                    "changed-files:1".to_owned(),
                    "delivery:commit-created:true".to_owned(),
                    "delivery:push-executed:true".to_owned(),
                ],
                diff_ref: Some("worktree:run".to_owned()),
            }),
            transitions: vec![EngineRunTransitionRecord {
                command_id: "command:run:deliver:1".to_owned(),
                from: Some(EngineRunLifecycleState::Running),
                to: EngineRunLifecycleState::Delivered,
                at: 10,
            }],
            created_at: 1,
            updated_at: 10,
        };
        persist(&handler, &run);

        let result = orchestration_run_review_query(
            &handler,
            OrchestrationRunReviewQuery {
                project_id: ProjectId("project:1".to_owned()),
                run_id: EngineRunId("run:delivered:1".to_owned()),
            },
        )
        .expect("review query");

        let ServerQueryResult::OrchestrationRunReview(review) = result else {
            panic!("expected orchestration run review");
        };
        assert_eq!(review.state, EngineRunLifecycleState::Delivered);
        assert_eq!(review.closeout.as_ref().expect("closeout").summary, "worker finished");
        assert_eq!(review.validation.status.as_deref(), Some("passed"));
        assert_eq!(review.validation.changed_files, Some(1));
        assert_eq!(review.validation.commit_created, Some(true));
        assert_eq!(review.validation.push_executed, Some(true));
        assert_eq!(review.base_ref.as_deref(), Some(base_ref.as_str()));
        assert_eq!(review.diff.available, true);
        assert_eq!(review.diff.base_ref.as_deref(), Some(base_ref.as_str()));
        assert_eq!(
            review
                .diff
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["work.txt"]
        );
        assert_eq!(review.diff.files[0].change_kind, "added");
    }

    #[test]
    fn review_patch_query_returns_unified_diff_for_one_file() {
        let (_directory, worktree, base_ref) = temp_repo_with_branch_commit();
        let (_temp_dir, handler) = handler();

        let run = delivered_run(&worktree, &Some(base_ref.clone()));
        persist(&handler, &run);

        let result = orchestration_run_review_patch_query(
            &handler,
            OrchestrationRunReviewPatchQuery {
                project_id: ProjectId("project:1".to_owned()),
                run_id: EngineRunId("run:delivered:1".to_owned()),
                file_ref: "work.txt".to_owned(),
            },
        )
        .expect("patch query");

        let ServerQueryResult::OrchestrationRunReviewPatch(patch) = result else {
            panic!("expected orchestration run review patch");
        };
        assert_eq!(patch.available, true);
        assert_eq!(patch.file_ref, "work.txt");
        let text = patch.patch.expect("patch text");
        assert!(text.contains("+delivered line"));
        assert_eq!(patch.additions, 1);
        assert_eq!(patch.deletions, 0);
    }

    #[test]
    fn review_fails_closed_without_worktree_or_base() {
        let (_temp_dir, handler) = handler();
        let mut run = delivered_run(&std::path::PathBuf::from("/missing/worktree"), &None);
        run.run_id = EngineRunId("run:no-worktree".to_owned());
        run.worktree_ref = Some("/missing/worktree".to_owned());
        run.base_ref = None;
        persist(&handler, &run);

        let result = orchestration_run_review_query(
            &handler,
            OrchestrationRunReviewQuery {
                project_id: ProjectId("project:1".to_owned()),
                run_id: EngineRunId("run:no-worktree".to_owned()),
            },
        )
        .expect("review query");
        let ServerQueryResult::OrchestrationRunReview(review) = result else {
            panic!("expected orchestration run review");
        };
        assert_eq!(review.diff.available, false);
        assert_eq!(review.diff.base_ref, None);
        assert_eq!(
            review.diff.unreachable_reason.as_deref(),
            Some("run has no recorded diff base")
        );
    }

    #[test]
    fn review_rejects_run_from_another_project() {
        let (_directory, worktree, base_ref) = temp_repo_with_branch_commit();
        let (_temp_dir, handler) = handler();
        let run = delivered_run(&worktree, &Some(base_ref));
        persist(&handler, &run);

        let error = orchestration_run_review_query(
            &handler,
            OrchestrationRunReviewQuery {
                project_id: ProjectId("project:other".to_owned()),
                run_id: EngineRunId("run:delivered:1".to_owned()),
            },
        )
        .expect_err("cross-project review rejected");
        assert!(matches!(
            error,
            ServerControlError::NotFound { .. }
        ));
    }

    #[test]
    fn review_patch_rejects_unsafe_file_refs() {
        let (_directory, worktree, base_ref) = temp_repo_with_branch_commit();
        let (_temp_dir, handler) = handler();
        let run = delivered_run(&worktree, &Some(base_ref));
        persist(&handler, &run);

        for unsafe_ref in ["../secret", "/etc/passwd", "-o", "a\0b"] {
            let result = orchestration_run_review_patch_query(
                &handler,
                OrchestrationRunReviewPatchQuery {
                    project_id: ProjectId("project:1".to_owned()),
                    run_id: EngineRunId("run:delivered:1".to_owned()),
                    file_ref: unsafe_ref.to_owned(),
                },
            )
            .expect("patch query");
            let ServerQueryResult::OrchestrationRunReviewPatch(patch) = result else {
                panic!("expected orchestration run review patch");
            };
            assert_eq!(patch.available, false, "unsafe file ref {unsafe_ref}");
            assert_eq!(
                patch.unreachable_reason.as_deref(),
                Some("file ref is not a safe relative worktree path")
            );
        }
    }

    fn handler() -> (tempfile::TempDir, LocalControlRequestHandler<SqliteBackend>) {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        (temp_dir, LocalControlRequestHandler::new(backend, None))
    }

    fn delivered_run(worktree: &std::path::Path, base_ref: &Option<String>) -> EngineRunStorageRecord {
        EngineRunStorageRecord {
            run_id: EngineRunId("run:delivered:1".to_owned()),
            project_id: "project:1".to_owned(),
            objective: EngineRunObjective {
                scope: "scope".to_owned(),
                acceptance: Vec::new(),
                stop_conditions: Vec::new(),
            },
            worktree_ref: Some(worktree.display().to_string()),
            base_ref: base_ref.clone(),
            provider_instance: "provider:codex".to_owned(),
            provider_model: "codex-mini".to_owned(),
            orchestrator_designation: None,
            operation_id: None,
            conversation_id: None,
            state: EngineRunLifecycleState::Delivered,
            budget: EngineRunBudgetEnvelope::default(),
            closeout: Some(EngineRunCloseout {
                summary: "done".to_owned(),
                evidence_refs: vec!["validation:effigy-test-plan:passed".to_owned()],
                diff_ref: None,
            }),
            transitions: Vec::new(),
            created_at: 1,
            updated_at: 10,
        }
    }

    fn persist(handler: &LocalControlRequestHandler<SqliteBackend>, run: &EngineRunStorageRecord) {
        let payload = encode_run_storage_record(run).expect("encode");
        handler
            .state()
            .orchestration_runs()
            .put(
                LocalStoreRecord {
                    id: PersistenceRecordId(run.run_id.0.clone()),
                    domain: PersistenceDomain::OrchestrationRuns,
                    kind: PersistenceRecordKind::OrchestrationRun,
                    revision_id: RevisionId(format!("rev:{}", run.run_id.0)),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: payload,
                    },
                },
                RevisionExpectation::MustNotExist,
            )
            .expect("persist run");
    }

    /// Temp git repo whose HEAD carries one commit on top of the base:
    /// base = initial commit, work = work.txt added on the branch. Returns
    /// the repo and the fork-point sha (base commit) for the review diff.
    fn temp_repo_with_branch_commit() -> (tempfile::TempDir, std::path::PathBuf, String) {
        let directory = tempfile::tempdir().expect("directory");
        let repo = directory.path().join("repo");
        std::fs::create_dir(&repo).expect("repo");
        run_git(&repo, &["init", "-q"]);
        run_git(&repo, &["config", "user.email", "test@nucleus"]);
        run_git(&repo, &["config", "user.name", "Nucleus Test"]);
        std::fs::write(repo.join("base.txt"), "base\n").expect("file");
        run_git(&repo, &["add", "base.txt"]);
        run_git(&repo, &["commit", "-q", "-m", "base"]);
        let base = current_head(&repo);
        std::fs::write(repo.join("work.txt"), "delivered line\n").expect("file");
        run_git(&repo, &["add", "work.txt"]);
        run_git(&repo, &["commit", "-q", "-m", "work"]);
        (directory, repo, base)
    }

    fn current_head(repo: &std::path::Path) -> String {
        let output = std::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(repo)
            .output()
            .expect("git");
        assert!(output.status.success(), "git rev-parse failed");
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn run_git(cwd: &std::path::Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?} failed");
    }
}
