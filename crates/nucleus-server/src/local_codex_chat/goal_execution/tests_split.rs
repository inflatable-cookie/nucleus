//! Split from the goal_execution god file; behavior unchanged.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use super::{dispatch::*, outcome::*, persistence::*, rules::*, run_loop::*};
#[allow(unused_imports)]
use std::time::{SystemTime, UNIX_EPOCH};

use nucleus_agent_protocol::{AgentSessionId, AgentTurnId};
use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_engine::{
    admit_task_agent_work_unit, EngineCheckpointRecordId, EngineDiffSummaryRecordId,
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus, EngineTaskAgentWorkUnitReviewStatus,
    EngineTaskAgentWorkUnitRuntimeStatus, EngineTaskAgentWorkUnitSourceId,
    EngineTaskWorkItemAssignment, EngineTaskWorkItemId, EngineTaskWorkItemRecord,
    EngineTaskWorkItemRefs, EngineTaskWorkItemReviewState, EngineTaskWorkItemRuntimeState,
};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::{TaskActionType, TaskId};
use serde::{Deserialize, Serialize};

use super::super::goal_inspection::goal_record;
use super::super::goal_run::{read_goal_run_plan, GoalRunPlan, GoalRunPlanTask, GoalRunRoute};
use super::super::mandates::{expire_workflow_mandate, read_workflow_mandate, WorkflowMandateStatus};
use super::super::review_evidence::{
    capture_baseline, capture_completed, CompletedReviewEvidence, TaskReviewEvidenceInput,
};
use super::super::task_execution::{
    run_task, TaskExecutionLinkage, TaskExecutionOutcome, TaskExecutionRequest,
};
use super::super::task_inspection::active_task;
use crate::runtime_receipt_state::write_runtime_receipt;
use crate::task_agent_work_unit_state::{
    read_task_agent_work_unit_source_records, write_task_agent_work_unit_source_record,
};
use crate::{
    durable_dispatch_invocation_preflight, durable_dispatch_invocation_request,
    durable_provider_executor_command, durable_provider_executor_dispatch_admission,
    durable_provider_executor_dispatch_selection, DurableDispatchInvocationPreflightInput,
    DurableDispatchInvocationPreflightStatus, DurableDispatchInvocationRequestInput,
    DurableDispatchInvocationRequestStatus, DurableProviderExecutorCommandId,
    DurableProviderExecutorCommandInput, DurableProviderExecutorDispatchAdmissionInput,
    DurableProviderExecutorDispatchAdmissionStatus, DurableProviderExecutorDispatchSelectionInput,
    DurableProviderExecutorDispatchSelectionStatus, DurableProviderExecutorLane,
    DurableProviderExecutorMethod, ServerStateService, TaskReviewSnapshotStore,
};


    use super::*;
    use crate::local_codex_chat::goal_run::tests::{fixture, run_request};
    use crate::local_codex_chat::{admit_goal_run, GoalRunOutcome};
    use crate::runtime_receipt_state::read_runtime_receipts;
    use crate::{read_checkpoint_records, read_diff_summary_records};
    use nucleus_engine::EngineDiffPathChangeKind;

    #[test]
    fn rework_prompt_includes_durable_note_and_refs_without_patch_content() {
        let fixture = fixture(true);
        let mut plan = admitted_plan(&fixture.state, &fixture.mandate, "prompt:rework");
        let plan_task = &mut plan.ordered_tasks[0];
        plan_task.rework_decision_ref = Some("review:decision:1".to_owned());
        plan_task.rework_reason = Some("Keep the heading and fix the example.".to_owned());
        plan_task.reviewed_work_item_refs = vec!["work:previous".to_owned()];
        plan_task.reviewed_evidence_refs = vec!["diff:previous".to_owned()];
        let task =
            active_task(&fixture.state, &plan.project_id, &plan_task.task_id).expect("active task");

        let prompt = task_prompt(&plan, 0, &task);

        assert!(prompt.contains("Keep the heading and fix the example."));
        assert!(prompt.contains("review:decision:1"));
        assert!(prompt.contains("work:previous"));
        assert!(prompt.contains("diff:previous"));
        assert!(!prompt.contains("@@"));
    }

    #[test]
    fn two_task_goal_executes_serially_and_stops_at_reviewable_results() {
        let fixture = fixture(true);
        let snapshots = snapshot_runtime(&fixture.state);
        let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:two");
        let mut calls = 0;
        let execution = execute_goal_run_with(
            &fixture.state,
            Some(&snapshots.store),
            GoalRunExecutionRequest {
                plan_id: plan.plan_id.clone(),
                expected_plan_revision: plan.revision_id.clone(),
            },
            &mut |_, on_started| {
                calls += 1;
                let persisted = read_execution(&fixture.state, &plan.plan_id)
                    .expect("execution lookup")
                    .expect("persisted execution");
                if calls == 1 {
                    assert!(!persisted.provider_execution_started);
                }
                assert_eq!(persisted.task_executions.len(), calls);
                assert!(persisted.task_executions[calls - 1]
                    .baseline_checkpoint_id
                    .is_some());
                assert_eq!(
                    read_checkpoint_records(&fixture.state)
                        .expect("baseline checkpoints")
                        .len(),
                    calls * 2 - 1
                );
                let linkage = linkage(calls);
                on_started(&linkage)?;
                Ok(TaskExecutionOutcome::Completed(linkage))
            },
        )
        .expect("execute Goal");

        assert_eq!(calls, 2);
        assert_eq!(execution.status, GoalRunExecutionStatus::Completed);
        assert_eq!(execution.task_executions.len(), 2);
        assert!(execution
            .task_executions
            .iter()
            .all(|task| task.status == "completed"));
        assert!(execution
            .task_executions
            .iter()
            .all(|task| !task.dispatch.invocation_request_id.is_empty()));
        assert!(execution.task_executions.iter().all(|task| {
            task.baseline_checkpoint_id.is_some()
                && task.target_checkpoint_id.is_some()
                && task.diff_summary_id.is_some()
        }));
        assert_eq!(
            read_checkpoint_records(&fixture.state)
                .expect("all checkpoints")
                .len(),
            4
        );
        assert_eq!(
            read_diff_summary_records(&fixture.state)
                .expect("all diffs")
                .len(),
            2
        );
        for task in &execution.task_executions {
            let latest = latest_source(&fixture.state, &task.work_item_id)
                .expect("latest source")
                .expect("work source");
            assert_eq!(latest.refs.checkpoint_ids.len(), 2);
            assert_eq!(latest.refs.diff_summary_ids.len(), 1);
            assert_eq!(
                latest.review,
                EngineTaskAgentWorkUnitReviewStatus::AwaitingReview
            );
        }
        assert_eq!(
            read_runtime_receipts(&fixture.state)
                .expect("runtime receipts")
                .len(),
            2
        );
        assert_eq!(
            read_task_agent_work_unit_source_records(&fixture.state)
                .expect("work sources")
                .len(),
            8
        );
        let tasks = fixture.state.tasks().list().expect("tasks");
        assert_eq!(tasks.len(), 2);
        assert!(tasks.iter().all(|record| {
            crate::ControlTaskRecordDto::try_from(record).is_ok_and(|task| task.activity == "ready")
        }));
        assert_eq!(
            read_workflow_mandate(&fixture.state, &fixture.mandate.mandate_id)
                .expect("expired mandate")
                .status,
            WorkflowMandateStatus::Expired
        );
        assert!(!execution.task_completion_permitted);
        assert!(!execution.review_acceptance_permitted);
        assert!(!execution.goal_achievement_permitted);
        assert!(!execution.scm_mutation_permitted);
    }

    #[test]
    fn failure_stops_before_scheduling_the_next_goal_task() {
        let fixture = fixture(true);
        let snapshots = snapshot_runtime(&fixture.state);
        let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:failure");
        let mut calls = 0;
        let execution = execute_goal_run_with(
            &fixture.state,
            Some(&snapshots.store),
            GoalRunExecutionRequest {
                plan_id: plan.plan_id.clone(),
                expected_plan_revision: plan.revision_id,
            },
            &mut |_, on_started| {
                calls += 1;
                let linkage = linkage(calls);
                on_started(&linkage)?;
                Ok(TaskExecutionOutcome::Failed {
                    linkage: Some(linkage),
                    reason: "validation failed".to_owned(),
                })
            },
        )
        .expect("stopped Goal");

        assert_eq!(calls, 1);
        assert_eq!(execution.status, GoalRunExecutionStatus::Stopped);
        assert_eq!(execution.task_executions.len(), 1);
        assert_eq!(execution.task_executions[0].status, "failed");
        assert_eq!(
            read_task_agent_work_unit_source_records(&fixture.state)
                .expect("work sources")
                .len(),
            4
        );
    }

    #[test]
    fn interactive_wait_is_recorded_then_closed_as_recovery_required() {
        let fixture = fixture(true);
        let snapshots = snapshot_runtime(&fixture.state);
        let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:wait");
        let execution = execute_goal_run_with(
            &fixture.state,
            Some(&snapshots.store),
            GoalRunExecutionRequest {
                plan_id: plan.plan_id.clone(),
                expected_plan_revision: plan.revision_id,
            },
            &mut |_, on_started| {
                let linkage = linkage(1);
                on_started(&linkage)?;
                Ok(TaskExecutionOutcome::WaitingForUserInput(linkage))
            },
        )
        .expect("wait outcome");

        assert_eq!(execution.status, GoalRunExecutionStatus::RecoveryRequired);
        assert_eq!(
            execution.task_executions[0].status,
            "waiting_for_user_input"
        );
        let sources =
            read_task_agent_work_unit_source_records(&fixture.state).expect("work sources");
        assert!(sources.iter().any(|source| matches!(
            source.runtime,
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForUserInput
        )));
        assert!(sources.iter().any(|source| matches!(
            source.runtime,
            EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(_)
        )));
    }

    #[test]
    fn mandate_revocation_stops_before_the_next_serial_task() {
        let fixture = fixture(true);
        let snapshots = snapshot_runtime(&fixture.state);
        let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:revoke");
        let mut calls = 0;
        let execution = execute_goal_run_with(
            &fixture.state,
            Some(&snapshots.store),
            GoalRunExecutionRequest {
                plan_id: plan.plan_id,
                expected_plan_revision: plan.revision_id,
            },
            &mut |_, on_started| {
                calls += 1;
                let linkage = linkage(calls);
                on_started(&linkage)?;
                crate::local_codex_chat::revoke_workflow_mandate(
                    &fixture.state,
                    &fixture.mandate.mandate_id,
                    &fixture.mandate.revision_id,
                    "operator revoked execution",
                )?;
                Ok(TaskExecutionOutcome::Completed(linkage))
            },
        )
        .expect("revoked Goal");

        assert_eq!(calls, 1);
        assert_eq!(execution.status, GoalRunExecutionStatus::Stopped);
        assert!(execution
            .terminal_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("no longer active")));
    }

    #[test]
    fn repeated_execution_returns_the_terminal_record_without_provider_replay() {
        let fixture = fixture(true);
        let snapshots = snapshot_runtime(&fixture.state);
        let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:idem");
        let request = GoalRunExecutionRequest {
            plan_id: plan.plan_id,
            expected_plan_revision: plan.revision_id,
        };
        let first = execute_goal_run_with(
            &fixture.state,
            Some(&snapshots.store),
            request.clone(),
            &mut |_, on_started| {
                let linkage = linkage(1);
                on_started(&linkage)?;
                Ok(TaskExecutionOutcome::Failed {
                    linkage: Some(linkage),
                    reason: "stop".to_owned(),
                })
            },
        )
        .expect("first execution");
        let mut replay_calls = 0;
        let repeated = execute_goal_run_with(
            &fixture.state,
            Some(&snapshots.store),
            request,
            &mut |_, _| {
                replay_calls += 1;
                Err("must not replay".to_owned())
            },
        )
        .expect("repeat execution");

        assert_eq!(replay_calls, 0);
        assert_eq!(repeated, first);
    }

    #[test]
    fn missing_snapshot_backend_fails_before_provider_start() {
        let fixture = fixture(true);
        let workspace = tempfile::tempdir().expect("workspace");
        redirect_project_root(&fixture.state, workspace.path());
        let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:no-snapshots");
        let mut calls = 0;
        let execution = execute_goal_run_with(
            &fixture.state,
            None,
            GoalRunExecutionRequest {
                plan_id: plan.plan_id,
                expected_plan_revision: plan.revision_id,
            },
            &mut |_, _| {
                calls += 1;
                Err("provider must not start".to_owned())
            },
        )
        .expect("fail closed");

        assert_eq!(calls, 0);
        assert!(!execution.provider_execution_started);
        assert_eq!(execution.status, GoalRunExecutionStatus::RecoveryRequired);
        assert_eq!(execution.task_executions[0].status, "recovery_required");
        assert!(read_checkpoint_records(&fixture.state)
            .expect("checkpoints")
            .is_empty());
        let sources =
            read_task_agent_work_unit_source_records(&fixture.state).expect("work sources");
        assert!(sources.iter().any(|source| matches!(
            source.runtime,
            EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(_)
        )));
    }

    #[test]
    fn serial_tasks_receive_non_overlapping_source_windows() {
        let fixture = fixture(true);
        let snapshots = snapshot_runtime(&fixture.state);
        std::fs::write(
            snapshots.workspace.path().join("preexisting.txt"),
            "stable\n",
        )
        .expect("preexisting");
        std::fs::write(snapshots.workspace.path().join("modified.txt"), "before\n")
            .expect("modified fixture");
        std::fs::write(snapshots.workspace.path().join("deleted.txt"), "delete\n")
            .expect("deleted fixture");
        let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:windows");
        let mut calls = 0;
        let execution = execute_goal_run_with(
            &fixture.state,
            Some(&snapshots.store),
            GoalRunExecutionRequest {
                plan_id: plan.plan_id,
                expected_plan_revision: plan.revision_id,
            },
            &mut |_, on_started| {
                calls += 1;
                let linkage = linkage(calls);
                on_started(&linkage)?;
                std::fs::write(
                    snapshots.workspace.path().join(format!("task-{calls}.txt")),
                    format!("task {calls}\n"),
                )
                .map_err(|error| error.to_string())?;
                if calls == 1 {
                    std::fs::write(snapshots.workspace.path().join("modified.txt"), "after\n")
                        .map_err(|error| error.to_string())?;
                    std::fs::remove_file(snapshots.workspace.path().join("deleted.txt"))
                        .map_err(|error| error.to_string())?;
                    std::fs::write(snapshots.workspace.path().join("binary.bin"), b"a\0b")
                        .map_err(|error| error.to_string())?;
                }
                Ok(TaskExecutionOutcome::Completed(linkage))
            },
        )
        .expect("serial windows");

        assert_eq!(execution.status, GoalRunExecutionStatus::Completed);
        let mut diffs = read_diff_summary_records(&fixture.state).expect("diffs");
        diffs.sort_by(|left, right| left.diff_id.0.cmp(&right.diff_id.0));
        assert_eq!(diffs.len(), 2);
        assert_eq!(
            diffs[0].changed_paths,
            vec!["binary.bin", "deleted.txt", "modified.txt", "task-1.txt"]
        );
        assert_eq!(diffs[1].changed_paths, vec!["task-2.txt"]);
        assert_eq!(diffs[0].counts.added, 1);
        assert_eq!(diffs[0].counts.modified, 1);
        assert_eq!(diffs[0].counts.deleted, 1);
        assert_eq!(diffs[0].counts.metadata_only, 1);
        assert!(diffs[0]
            .path_changes
            .iter()
            .any(|change| change.kind == EngineDiffPathChangeKind::MetadataOnly));
        assert_eq!(diffs[1].counts.added, 1);
        assert_eq!(
            diffs[1].path_changes[0].kind,
            EngineDiffPathChangeKind::Added
        );
        assert!(diffs.iter().all(|diff| !diff
            .changed_paths
            .iter()
            .any(|path| path == "preexisting.txt")));
    }

    #[test]
    fn target_capture_failure_never_becomes_review_ready() {
        let fixture = fixture(true);
        let snapshots = snapshot_runtime(&fixture.state);
        let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:target-failure");
        let execution = execute_goal_run_with(
            &fixture.state,
            Some(&snapshots.store),
            GoalRunExecutionRequest {
                plan_id: plan.plan_id,
                expected_plan_revision: plan.revision_id,
            },
            &mut |_, on_started| {
                let linkage = linkage(1);
                on_started(&linkage)?;
                for index in 0..=crate::project_file_policy::MAX_ADMITTED_PROJECT_FILES {
                    std::fs::write(
                        snapshots.workspace.path().join(format!("{index:04}.txt")),
                        "",
                    )
                    .map_err(|error| error.to_string())?;
                }
                Ok(TaskExecutionOutcome::Completed(linkage))
            },
        )
        .expect("target recovery");

        assert_eq!(execution.status, GoalRunExecutionStatus::RecoveryRequired);
        assert_eq!(execution.task_executions[0].status, "recovery_required");
        assert!(execution.task_executions[0].target_checkpoint_id.is_none());
        assert!(execution.task_executions[0].diff_summary_id.is_none());
        assert!(read_diff_summary_records(&fixture.state)
            .expect("diffs")
            .is_empty());
        let latest = latest_source(&fixture.state, &execution.task_executions[0].work_item_id)
            .expect("latest source")
            .expect("source");
        assert!(matches!(
            latest.runtime,
            EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(_)
        ));
        assert_eq!(latest.review, EngineTaskAgentWorkUnitReviewStatus::NotReady);
    }

    #[test]
    #[ignore = "requires a locally authenticated Codex app-server"]
    fn authenticated_single_task_runner_performs_a_workspace_write() {
        let workspace = tempfile::tempdir().expect("workspace");
        let root = workspace.path().to_string_lossy().into_owned();
        let route = GoalRunRoute {
            adapter_id: "codex-app-server".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            model: "gpt-5.4-mini".to_owned(),
            reasoning_effort: Some("low".to_owned()),
        };
        let mut started = false;
        let outcome = run_task(
            TaskExecutionRequest {
                project_root: &root,
                route: &route,
                prompt: "Create a UTF-8 file named nucleus-single-task-smoke.txt containing exactly the text nucleus task smoke ok followed by a newline. Do nothing else.",
            },
            |_| {
                started = true;
                Ok(())
            },
        )
        .expect("live task");

        assert!(started);
        assert!(matches!(outcome, TaskExecutionOutcome::Completed(_)));
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("nucleus-single-task-smoke.txt"))
                .expect("smoke file"),
            "nucleus task smoke ok\n"
        );
    }

    #[test]
    #[ignore = "requires a locally authenticated Codex app-server"]
    fn authenticated_two_task_goal_reaches_two_serial_provider_turns() {
        let fixture = fixture(true);
        let workspace = tempfile::tempdir().expect("workspace");
        let snapshot_backend = tempfile::tempdir().expect("snapshot backend");
        let snapshot_store =
            TaskReviewSnapshotStore::new(snapshot_backend.path()).expect("snapshot store");
        redirect_project_root(&fixture.state, workspace.path());
        let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:live-two");
        let execution = execute_goal_run(
            &fixture.state,
            Some(&snapshot_store),
            GoalRunExecutionRequest {
                plan_id: plan.plan_id,
                expected_plan_revision: plan.revision_id,
            },
        )
        .expect("live Goal execution");

        assert_eq!(execution.status, GoalRunExecutionStatus::Completed);
        assert_eq!(execution.task_executions.len(), 2);
        assert!(execution
            .task_executions
            .iter()
            .all(|task| task.provider_turn_id.is_some()));
    }

    fn admitted_plan(
        state: &ServerStateService<nucleus_local_store::SqliteBackend>,
        mandate: &super::super::WorkflowMandate,
        key: &str,
    ) -> GoalRunPlan {
        match admit_goal_run(state, run_request(mandate, key)).expect("admit Goal") {
            GoalRunOutcome::Admitted { plan } => plan,
            other => panic!("expected plan, got {other:?}"),
        }
    }

    struct SnapshotRuntime {
        workspace: tempfile::TempDir,
        _backend: tempfile::TempDir,
        store: TaskReviewSnapshotStore,
    }

    fn snapshot_runtime(
        state: &ServerStateService<nucleus_local_store::SqliteBackend>,
    ) -> SnapshotRuntime {
        let workspace = tempfile::tempdir().expect("workspace");
        redirect_project_root(state, workspace.path());
        let backend = tempfile::tempdir().expect("snapshot backend");
        let store = TaskReviewSnapshotStore::new(backend.path().join("snapshots")).expect("store");
        SnapshotRuntime {
            workspace,
            _backend: backend,
            store,
        }
    }

    fn linkage(index: usize) -> TaskExecutionLinkage {
        TaskExecutionLinkage {
            session_id: format!("session:{index}"),
            thread_id: format!("thread:{index}"),
            turn_id: format!("turn:{index}"),
        }
    }

    fn redirect_project_root(
        state: &ServerStateService<nucleus_local_store::SqliteBackend>,
        root: &std::path::Path,
    ) {
        let id = PersistenceRecordId("project:nucleus-local".to_owned());
        let mut record = state
            .projects()
            .get(&id)
            .expect("project lookup")
            .expect("project");
        let previous = record.revision_id.clone();
        let mut project =
            nucleus_projects::decode_project_storage_record(&record.payload.bytes).expect("decode");
        let resource = project.resources.first_mut().expect("seed resource");
        resource.current_locator = Some(root.to_string_lossy().into_owned());
        resource.location_status = nucleus_projects::ProjectResourceStorageLocationStatus::Present;
        record.revision_id = RevisionId("rev:project:live-smoke".to_owned());
        record.payload = LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: nucleus_projects::encode_project_storage_payload(&project).expect("encode"),
        };
        state
            .projects()
            .put(record, RevisionExpectation::Exact(previous))
            .expect("redirect project");
    }

