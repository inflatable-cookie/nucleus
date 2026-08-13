//! Run aggregate tests: state machine fixtures, persistence round-trip,
//! projection shape.

use std::collections::HashMap;

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_projects::ProjectId;

use super::model::{
    decode_run_storage_record, encode_run_storage_record, EngineRunBudgetEnvelope, EngineRunCloseout,
    EngineRunCommand, EngineRunCommandError, EngineRunCommandOutcome, EngineRunDispatchCommand,
    EngineRunId, EngineRunLifecycleState, EngineRunObjective, EngineRunProposeCommand,
    EngineRunRecord, EngineRunRepository, EngineRunTransitionCommand, EngineRunTransitionRecord,
};
use super::service::EngineRunCommandService;
use crate::EngineRevisionExpectation;

fn propose_command(run_id: &str) -> EngineRunCommand {
    EngineRunCommand::Propose(EngineRunProposeCommand {
        run_id: EngineRunId(run_id.to_owned()),
        project_id: ProjectId("project:1".to_owned()),
        objective: EngineRunObjective {
            scope: "implement the run registry".to_owned(),
            acceptance: vec!["aggregate persists".to_owned()],
            stop_conditions: vec!["tests red".to_owned()],
        },
        worktree_ref: Some("worktree:1".to_owned()),
        provider_instance: "provider:codex".to_owned(),
        provider_model: "codex-mini".to_owned(),
        orchestrator_designation: None,
        budget: EngineRunBudgetEnvelope {
            token_budget: Some(100_000),
            time_budget_seconds: Some(3600),
        },
    })
}

fn transition_command(run_id: &str) -> EngineRunTransitionCommand {
    EngineRunTransitionCommand {
        run_id: EngineRunId(run_id.to_owned()),
        operation_id: None,
        expected_revision: None,
        reason: None,
    }
}

fn closeout() -> EngineRunCloseout {
    EngineRunCloseout {
        summary: "run delivered with closeout".to_owned(),
        evidence_refs: vec!["evidence:1".to_owned()],
        diff_ref: Some("diff:1".to_owned()),
    }
}

/// In-memory repository keeping engine-shaped records.
#[derive(Clone, Debug, Default)]
struct InMemoryRunRepository {
    records: std::cell::RefCell<HashMap<String, EngineRunRecord>>,
}

impl InMemoryRunRepository {
    fn new() -> Self {
        Self::default()
    }

    fn records(&self) -> Vec<EngineRunRecord> {
        let mut records: Vec<EngineRunRecord> = self
            .records
            .borrow()
            .values()
            .cloned()
            .collect();
        records.sort_by(|left, right| left.id.0.cmp(&right.id.0));
        records
    }
}

impl EngineRunRepository for InMemoryRunRepository {
    type Error = String;

    fn get_run(
        &self,
        run_id: &PersistenceRecordId,
    ) -> Result<Option<EngineRunRecord>, Self::Error> {
        Ok(self.records.borrow().get(&run_id.0).cloned())
    }

    fn put_run(
        &self,
        record: EngineRunRecord,
        revision: EngineRevisionExpectation,
    ) -> Result<(), Self::Error> {
        let existing = self.records.borrow().get(&record.id.0).cloned();
        match revision {
            EngineRevisionExpectation::MustNotExist if existing.is_some() => {
                return Err("record exists".to_owned());
            }
            EngineRevisionExpectation::MustExist if existing.is_none() => {
                return Err("record missing".to_owned());
            }
            EngineRevisionExpectation::Exact(expected)
                if existing.as_ref().map(|r| &r.revision_id) != Some(&expected) =>
            {
                return Err("revision mismatch".to_owned());
            }
            _ => {}
        }
        self.records
            .borrow_mut()
            .insert(record.id.0.clone(), record);
        Ok(())
    }
}

#[test]
fn full_lifecycle_transitions_to_accepted() {
    let repository = InMemoryRunRepository::new();
    let service = EngineRunCommandService::new(repository);

    let propose_outcome = service
        .execute("command:run:propose:1", propose_command("run:1"))
        .expect("propose accepted");
    let EngineRunCommandOutcome::Mutated { transition } = propose_outcome;
    assert_eq!(transition.from, None);
    assert_eq!(transition.to, EngineRunLifecycleState::Proposed);

    for (command_id, command, expected) in [
        (
            "command:run:dispatch:1",
            EngineRunCommand::Dispatch(EngineRunDispatchCommand {
                run_id: EngineRunId("run:1".to_owned()),
                operation_id: Some("operation:1".to_owned()),
                conversation_id: Some("conversation:1".to_owned()),
                worktree_ref: Some("worktree:1".to_owned()),
                expected_revision: None,
            }),
            EngineRunLifecycleState::Dispatched,
        ),
        (
            "command:run:running:1",
            EngineRunCommand::MarkRunning(transition_command("run:1")),
            EngineRunLifecycleState::Running,
        ),
        (
            "command:run:deliver:1",
            EngineRunCommand::Deliver(super::model::EngineRunDeliverCommand {
                run_id: EngineRunId("run:1".to_owned()),
                closeout: closeout(),
                expected_revision: None,
            }),
            EngineRunLifecycleState::Delivered,
        ),
        (
            "command:run:accept:1",
            EngineRunCommand::Accept(transition_command("run:1")),
            EngineRunLifecycleState::Accepted,
        ),
    ] {
        let outcome = service.execute(command_id, command).expect("transition accepted");
        let EngineRunCommandOutcome::Mutated { transition } = outcome;
        assert_eq!(transition.to, expected);
        assert_eq!(transition.from, Some(expected.predecessor()));
    }

    let record = service
        .repository
        .records()
        .into_iter()
        .find(|record| record.id.0 == "run:1")
        .expect("run record");
    let storage = decode_run_storage_record(&record.payload).expect("decode");
    assert_eq!(storage.state, EngineRunLifecycleState::Accepted);
    assert_eq!(storage.transitions.len(), 5);
    assert_eq!(storage.closeout, Some(closeout()));
    assert_eq!(
        storage.operation_id.as_deref(),
        Some("operation:1")
    );
}

#[test]
fn mark_running_binds_observed_operation_id_and_dispatch_binds_worktree_ref() {
    let repository = InMemoryRunRepository::new();
    let service = EngineRunCommandService::new(repository);
    service
        .execute("command:run:propose:1", propose_command("run:1"))
        .expect("propose accepted");

    // Dispatch binds the deterministic conversation and the realized
    // worktree; the operation id is not yet observable.
    service
        .execute(
            "command:run:dispatch:1",
            EngineRunCommand::Dispatch(EngineRunDispatchCommand {
                run_id: EngineRunId("run:1".to_owned()),
                operation_id: None,
                conversation_id: Some("conversation:run:run:1".to_owned()),
                worktree_ref: Some("worktree:run:1".to_owned()),
                expected_revision: None,
            }),
        )
        .expect("dispatch accepted");

    // The first observed turn activity binds the operation identity while
    // transitioning dispatched -> running (observed operation truth).
    let mut running = transition_command("run:1");
    running.operation_id = Some("run:runtime:run:1".to_owned());
    service
        .execute("command:run:running:1", EngineRunCommand::MarkRunning(running))
        .expect("mark running accepted");

    let record = service
        .repository
        .records()
        .into_iter()
        .find(|record| record.id.0 == "run:1")
        .expect("run record");
    let storage = decode_run_storage_record(&record.payload).expect("decode");
    assert_eq!(storage.state, EngineRunLifecycleState::Running);
    assert_eq!(
        storage.conversation_id.as_deref(),
        Some("conversation:run:run:1")
    );
    assert_eq!(storage.worktree_ref.as_deref(), Some("worktree:run:1"));
    assert_eq!(storage.operation_id.as_deref(), Some("run:runtime:run:1"));
}

#[test]
fn operation_id_cannot_bind_outside_mark_running() {
    let repository = InMemoryRunRepository::new();
    let service = EngineRunCommandService::new(repository);
    service
        .execute("command:run:propose:1", propose_command("run:1"))
        .expect("propose accepted");

    let mut cancel = transition_command("run:1");
    cancel.operation_id = Some("run:stray".to_owned());
    let error = service
        .execute("command:run:cancel:1", EngineRunCommand::Cancel(cancel))
        .expect_err("operation binding on cancel rejected");
    assert!(matches!(
        error,
        EngineRunCommandError::InvalidRequest { reason }
            if reason.contains("can only bind on mark-running")
    ));

    let record = service
        .repository
        .records()
        .into_iter()
        .find(|record| record.id.0 == "run:1")
        .expect("run record");
    let storage = decode_run_storage_record(&record.payload).expect("decode");
    assert_eq!(storage.state, EngineRunLifecycleState::Proposed);
    assert_eq!(storage.transitions.len(), 1);
    assert_eq!(storage.operation_id, None);
}

impl EngineRunLifecycleState {
    fn predecessor(self) -> Self {
        match self {
            EngineRunLifecycleState::Dispatched => EngineRunLifecycleState::Proposed,
            EngineRunLifecycleState::Running => EngineRunLifecycleState::Dispatched,
            EngineRunLifecycleState::Delivered => EngineRunLifecycleState::Running,
            EngineRunLifecycleState::Accepted => EngineRunLifecycleState::Delivered,
            other => other,
        }
    }
}

#[test]
fn invalid_transitions_are_rejected() {
    let repository = InMemoryRunRepository::new();
    let service = EngineRunCommandService::new(repository);
    service
        .execute("command:run:propose:1", propose_command("run:1"))
        .expect("propose accepted");

    // proposed -> running jumps the dispatch step.
    let error = service
        .execute(
            "command:run:running:1",
            EngineRunCommand::MarkRunning(transition_command("run:1")),
        )
        .expect_err("running without dispatch rejected");
    assert!(matches!(
        error,
        EngineRunCommandError::InvalidTransition {
            from: EngineRunLifecycleState::Proposed,
            to: EngineRunLifecycleState::Running
        }
    ));

    // proposed -> delivered jumps three steps.
    let error = service
        .execute(
            "command:run:deliver:1",
            EngineRunCommand::Deliver(super::model::EngineRunDeliverCommand {
                run_id: EngineRunId("run:1".to_owned()),
                closeout: closeout(),
                expected_revision: None,
            }),
        )
        .expect_err("deliver from proposed rejected");
    assert!(matches!(
        error,
        EngineRunCommandError::InvalidTransition {
            from: EngineRunLifecycleState::Proposed,
            to: EngineRunLifecycleState::Delivered
        }
    ));

    // proposed -> accepted rejected.
    let error = service
        .execute(
            "command:run:accept:1",
            EngineRunCommand::Accept(transition_command("run:1")),
        )
        .expect_err("accept before delivery rejected");
    assert!(matches!(
        error,
        EngineRunCommandError::InvalidTransition {
            from: EngineRunLifecycleState::Proposed,
            to: EngineRunLifecycleState::Accepted
        }
    ));
}

#[test]
fn terminal_states_do_not_accept_further_transitions() {
    let repository = InMemoryRunRepository::new();
    let service = EngineRunCommandService::new(repository);
    service
        .execute("command:run:propose:1", propose_command("run:1"))
        .expect("propose accepted");
    service
        .execute(
            "command:run:cancel:1",
            EngineRunCommand::Cancel(transition_command("run:1")),
        )
        .expect("cancel accepted");

    let error = service
        .execute(
            "command:run:dispatch:1",
            EngineRunCommand::Dispatch(EngineRunDispatchCommand {
                run_id: EngineRunId("run:1".to_owned()),
                operation_id: None,
                conversation_id: None,
                worktree_ref: None,
                expected_revision: None,
            }),
        )
        .expect_err("dispatch after cancel rejected");
    assert!(matches!(
        error,
        EngineRunCommandError::InvalidTransition {
            from: EngineRunLifecycleState::Cancelled,
            to: EngineRunLifecycleState::Dispatched
        }
    ));
}

#[test]
fn failed_and_cancelled_are_reachable_before_delivery() {
    for (command_id, command, expected) in [
        (
            "command:run:fail:1",
            EngineRunCommand::Fail(transition_command("run:fail")),
            EngineRunLifecycleState::Failed,
        ),
        (
            "command:run:cancel:1",
            EngineRunCommand::Cancel(transition_command("run:cancel")),
            EngineRunLifecycleState::Cancelled,
        ),
    ] {
        let repository = InMemoryRunRepository::new();
        let service = EngineRunCommandService::new(repository);
        service
            .execute(
                "command:run:propose:1",
                propose_command(if command_id.contains("fail") { "run:fail" } else { "run:cancel" }),
            )
            .expect("propose accepted");
        let outcome = service.execute(command_id, command).expect("terminal accepted");
        let EngineRunCommandOutcome::Mutated { transition } = outcome;
        assert_eq!(transition.to, expected);
    }
}

#[test]
fn delivered_requires_a_closeout() {
    let repository = InMemoryRunRepository::new();
    let service = EngineRunCommandService::new(repository);
    service
        .execute("command:run:propose:1", propose_command("run:1"))
        .expect("propose accepted");
    service
        .execute(
            "command:run:dispatch:1",
            EngineRunCommand::Dispatch(EngineRunDispatchCommand {
                run_id: EngineRunId("run:1".to_owned()),
                operation_id: None,
                conversation_id: None,
                worktree_ref: None,
                expected_revision: None,
            }),
        )
        .expect("dispatch accepted");
    service
        .execute(
            "command:run:running:1",
            EngineRunCommand::MarkRunning(transition_command("run:1")),
        )
        .expect("running accepted");

    let error = service
        .execute(
            "command:run:deliver:1",
            EngineRunCommand::Deliver(super::model::EngineRunDeliverCommand {
                run_id: EngineRunId("run:1".to_owned()),
                closeout: EngineRunCloseout {
                    summary: " ".to_owned(),
                    evidence_refs: Vec::new(),
                    diff_ref: None,
                },
                expected_revision: None,
            }),
        )
        .expect_err("delivery with empty closeout rejected");
    assert!(matches!(
        error,
        EngineRunCommandError::InvalidRequest { .. }
    ));
}

#[test]
fn run_storage_record_round_trips() {
    let storage = super::model::EngineRunStorageRecord {
        run_id: EngineRunId("run:1".to_owned()),
        project_id: "project:1".to_owned(),
        objective: EngineRunObjective {
            scope: "scope".to_owned(),
            acceptance: vec!["a".to_owned()],
            stop_conditions: vec!["s".to_owned()],
        },
        worktree_ref: Some("worktree:1".to_owned()),
        provider_instance: "provider:codex".to_owned(),
        provider_model: "codex-mini".to_owned(),
        orchestrator_designation: None,
        operation_id: Some("operation:1".to_owned()),
        conversation_id: Some("conversation:1".to_owned()),
        state: EngineRunLifecycleState::Running,
        budget: EngineRunBudgetEnvelope::default(),
        closeout: None,
        transitions: vec![EngineRunTransitionRecord {
            command_id: "command:run:running:1".to_owned(),
            from: Some(EngineRunLifecycleState::Dispatched),
            to: EngineRunLifecycleState::Running,
            at: 1,
        }],
        created_at: 1,
        updated_at: 2,
    };

    let bytes = encode_run_storage_record(&storage).expect("encode");
    let decoded = decode_run_storage_record(&bytes).expect("decode");
    assert_eq!(decoded, storage);
}

#[test]
fn propose_rejects_missing_required_fields() {
    let repository = InMemoryRunRepository::new();
    let service = EngineRunCommandService::new(repository);
    let mut command = match propose_command("run:1") {
        EngineRunCommand::Propose(command) => command,
        _ => unreachable!(),
    };
    command.provider_instance.clear();

    let error = service
        .execute(
            "command:run:propose:1",
            EngineRunCommand::Propose(command),
        )
        .expect_err("propose without provider rejected");
    assert!(matches!(
        error,
        EngineRunCommandError::InvalidRequest { .. }
    ));
}

#[test]
fn transition_on_missing_run_is_not_found() {
    let repository = InMemoryRunRepository::new();
    let service = EngineRunCommandService::new(repository);

    let error = service
        .execute(
            "command:run:cancel:1",
            EngineRunCommand::Cancel(transition_command("run:missing")),
        )
        .expect_err("cancel missing run rejected");
    assert!(matches!(error, EngineRunCommandError::NotFound { .. }));
}

#[test]
fn expected_revision_conflict_is_rejected() {
    let repository = InMemoryRunRepository::new();
    let service = EngineRunCommandService::new(repository);
    service
        .execute("command:run:propose:1", propose_command("run:1"))
        .expect("propose accepted");

    let error = service
        .execute(
            "command:run:cancel:1",
            EngineRunCommand::Cancel(EngineRunTransitionCommand {
                run_id: EngineRunId("run:1".to_owned()),
                operation_id: None,
                expected_revision: Some(RevisionId("rev:stale".to_owned())),
                reason: None,
            }),
        )
        .expect_err("stale revision rejected");
    assert!(matches!(error, EngineRunCommandError::Conflict { .. }));
}

#[test]
fn propose_duplicate_is_conflict() {
    let repository = InMemoryRunRepository::new();
    let service = EngineRunCommandService::new(repository);
    service
        .execute("command:run:propose:1", propose_command("run:1"))
        .expect("propose accepted");

    let error = service
        .execute("command:run:propose:2", propose_command("run:1"))
        .expect_err("duplicate propose rejected");
    assert!(matches!(error, EngineRunCommandError::Storage(_)));
}

#[test]
fn storage_domain_and_kind_are_orchestration_runs() {
    let repository = InMemoryRunRepository::new();
    let service = EngineRunCommandService::new(repository);
    service
        .execute("command:run:propose:1", propose_command("run:1"))
        .expect("propose accepted");

    let record = service
        .repository
        .records()
        .into_iter()
        .find(|record| record.id.0 == "run:1")
        .expect("run record");
    assert_eq!(record.domain, PersistenceDomain::OrchestrationRuns);
    assert_eq!(record.kind, PersistenceRecordKind::OrchestrationRun);
    assert_eq!(record.id, PersistenceRecordId("run:1".to_owned()));
}
