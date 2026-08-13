//! Designation aggregate tests: designate/revoke fixtures, revision
//! expectations, envelope validation, storage round-trip.

use std::collections::HashMap;

use nucleus_core::{PersistenceRecordId, PersistenceRecordKind, RevisionId};

use super::model::{
    decode_orchestrator_designation, encode_orchestrator_designation,
    EngineDelegationAction, EngineDesignateCommand, EngineOrchestratorDesignation,
    EngineOrchestratorDesignationCommand, EngineOrchestratorDesignationCommandError,
    EngineOrchestratorDesignationCommandOutcome, EngineOrchestratorDesignationId,
    EngineOrchestratorDesignationRecord, EngineOrchestratorDesignationRepository,
    EngineOrchestratorDesignationStatus, EngineRevokeDesignationCommand,
};
use super::service::EngineOrchestratorDesignationService;
use crate::EngineRevisionExpectation;

const DESIGNATION_ID: &str = "designation:project:1:codex:local-default";

fn designate_command() -> EngineDesignateCommand {
    EngineDesignateCommand {
        designation_id: EngineOrchestratorDesignationId(DESIGNATION_ID.to_owned()),
        project_id: "project:1".to_owned(),
        orchestrator_provider_instance: "codex:local-default".to_owned(),
        allowed_worker_provider_instances: Some(vec!["codex:local-default".to_owned()]),
        allowed_worker_models: Some(vec!["gpt-5.4-mini".to_owned()]),
        concurrent_run_budget: 2,
        per_run_token_budget: Some(100_000),
        per_run_time_budget_seconds: Some(3600),
        allowed_actions: vec![
            EngineDelegationAction::Delegate,
            EngineDelegationAction::RunStatus,
            EngineDelegationAction::CancelRun,
            EngineDelegationAction::AcceptDelivery,
            EngineDelegationAction::RejectDelivery,
        ],
        steering_permitted: false,
        expected_revision: None,
    }
}

/// In-memory repository keeping engine-shaped designation records. The map
/// is `Rc`-shared so a cloned repository observes the service's writes.
#[derive(Clone, Debug, Default)]
struct InMemoryDesignationRepository {
    records: std::rc::Rc<std::cell::RefCell<HashMap<String, EngineOrchestratorDesignationRecord>>>,
}

impl InMemoryDesignationRepository {
    fn new() -> Self {
        Self::default()
    }

    fn records(&self) -> Vec<EngineOrchestratorDesignationRecord> {
        let mut records: Vec<EngineOrchestratorDesignationRecord> = self
            .records
            .borrow()
            .values()
            .cloned()
            .collect();
        records.sort_by(|left, right| left.id.0.cmp(&right.id.0));
        records
    }
}

impl EngineOrchestratorDesignationRepository for InMemoryDesignationRepository {
    type Error = String;

    fn get_designation(
        &self,
        designation_id: &PersistenceRecordId,
    ) -> Result<Option<EngineOrchestratorDesignationRecord>, Self::Error> {
        Ok(self.records.borrow().get(&designation_id.0).cloned())
    }

    fn put_designation(
        &self,
        record: EngineOrchestratorDesignationRecord,
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
        self.records.borrow_mut().insert(record.id.0.clone(), record);
        Ok(())
    }
}

#[test]
fn designate_persists_an_active_envelope() {
    let repository = InMemoryDesignationRepository::new();
    let service = EngineOrchestratorDesignationService::new(repository);

    let outcome = service
        .execute("command:designate:1", EngineOrchestratorDesignationCommand::Designate(
            designate_command(),
        ))
        .expect("designate accepted");
    let EngineOrchestratorDesignationCommandOutcome::Designated { designation } = outcome else {
        panic!("expected designated outcome");
    };

    assert_eq!(designation.designation_id, DESIGNATION_ID);
    assert_eq!(designation.status, EngineOrchestratorDesignationStatus::Active);
    assert_eq!(designation.orchestrator_provider_instance, "codex:local-default");
    assert_eq!(designation.concurrent_run_budget, 2);
    assert_eq!(designation.allowed_actions.len(), 5);
    assert!(designation.allowed_actions.contains(&EngineDelegationAction::Delegate));
}

#[test]
fn designate_duplicate_without_revision_is_conflict() {
    let repository = InMemoryDesignationRepository::new();
    let service = EngineOrchestratorDesignationService::new(repository);
    service
        .execute("command:designate:1", EngineOrchestratorDesignationCommand::Designate(
            designate_command(),
        ))
        .expect("first designate accepted");

    let error = service
        .execute("command:designate:2", EngineOrchestratorDesignationCommand::Designate(
            designate_command(),
        ))
        .expect_err("duplicate designate rejected");
    assert!(matches!(
        error,
        EngineOrchestratorDesignationCommandError::Storage(reason)
            if reason == "record exists"
    ));
}

#[test]
fn redesignate_replaces_envelope_at_exact_revision() {
    let repository = InMemoryDesignationRepository::new();
    let service = EngineOrchestratorDesignationService::new(repository.clone());
    service
        .execute("command:designate:1", EngineOrchestratorDesignationCommand::Designate(
            designate_command(),
        ))
        .expect("first designate accepted");

    let record = repository.records()[0].clone();
    let revision = record.revision_id.clone();
    let mut replacement = designate_command();
    replacement.allowed_worker_models = Some(vec!["gpt-5.4".to_owned()]);
    replacement.concurrent_run_budget = 4;
    replacement.expected_revision = Some(revision);

    let outcome = service
        .execute("command:designate:2", EngineOrchestratorDesignationCommand::Designate(
            replacement,
        ))
        .expect("replacement accepted");
    let EngineOrchestratorDesignationCommandOutcome::Designated { designation } = outcome else {
        panic!("expected designated outcome");
    };
    assert_eq!(designation.concurrent_run_budget, 4);
    assert_eq!(
        designation.allowed_worker_models,
        Some(vec!["gpt-5.4".to_owned()])
    );
}

#[test]
fn redesignate_with_stale_revision_is_conflict() {
    let repository = InMemoryDesignationRepository::new();
    let service = EngineOrchestratorDesignationService::new(repository);
    service
        .execute("command:designate:1", EngineOrchestratorDesignationCommand::Designate(
            designate_command(),
        ))
        .expect("first designate accepted");

    let mut replacement = designate_command();
    replacement.expected_revision = Some(RevisionId("rev:designation:stale".to_owned()));
    let error = service
        .execute("command:designate:2", EngineOrchestratorDesignationCommand::Designate(
            replacement,
        ))
        .expect_err("stale replacement rejected");
    assert!(matches!(error, EngineOrchestratorDesignationCommandError::Storage(_)));
}

#[test]
fn revoke_flips_status_and_blocks_new_delegation() {
    let repository = InMemoryDesignationRepository::new();
    let service = EngineOrchestratorDesignationService::new(repository);
    service
        .execute("command:designate:1", EngineOrchestratorDesignationCommand::Designate(
            designate_command(),
        ))
        .expect("designate accepted");

    let outcome = service
        .execute("command:revoke:1", EngineOrchestratorDesignationCommand::Revoke(
            EngineRevokeDesignationCommand {
                designation_id: EngineOrchestratorDesignationId(DESIGNATION_ID.to_owned()),
                expected_revision: None,
            },
        ))
        .expect("revoke accepted");
    let EngineOrchestratorDesignationCommandOutcome::Revoked { designation } = outcome else {
        panic!("expected revoked outcome");
    };
    assert_eq!(designation.status, EngineOrchestratorDesignationStatus::Revoked);

    // Revoking again is rejected: revocation is a one-way act recorded once.
    let error = service
        .execute("command:revoke:2", EngineOrchestratorDesignationCommand::Revoke(
            EngineRevokeDesignationCommand {
                designation_id: EngineOrchestratorDesignationId(DESIGNATION_ID.to_owned()),
                expected_revision: None,
            },
        ))
        .expect_err("double revoke rejected");
    assert!(matches!(
        error,
        EngineOrchestratorDesignationCommandError::InvalidRequest { .. }
    ));
}

#[test]
fn revoke_missing_designation_is_not_found() {
    let repository = InMemoryDesignationRepository::new();
    let service = EngineOrchestratorDesignationService::new(repository);

    let error = service
        .execute("command:revoke:1", EngineOrchestratorDesignationCommand::Revoke(
            EngineRevokeDesignationCommand {
                designation_id: EngineOrchestratorDesignationId(DESIGNATION_ID.to_owned()),
                expected_revision: None,
            },
        ))
        .expect_err("missing revoke rejected");
    assert!(matches!(error, EngineOrchestratorDesignationCommandError::NotFound { .. }));
}

#[test]
fn designate_validation_rejects_bad_envelopes() {
    let repository = InMemoryDesignationRepository::new();
    let service = EngineOrchestratorDesignationService::new(repository);

    let mut empty_instance = designate_command();
    empty_instance.orchestrator_provider_instance = "  ".to_owned();
    let error = service
        .execute("command:designate:bad:1", EngineOrchestratorDesignationCommand::Designate(
            empty_instance,
        ))
        .expect_err("empty instance rejected");
    assert!(matches!(error, EngineOrchestratorDesignationCommandError::InvalidRequest { .. }));

    let mut bad_prefix = designate_command();
    bad_prefix.designation_id = EngineOrchestratorDesignationId("project:1:codex".to_owned());
    let error = service
        .execute("command:designate:bad:2", EngineOrchestratorDesignationCommand::Designate(
            bad_prefix,
        ))
        .expect_err("bad prefix rejected");
    assert!(matches!(error, EngineOrchestratorDesignationCommandError::InvalidRequest { .. }));

    let mut duplicate_action = designate_command();
    duplicate_action.allowed_actions = vec![
        EngineDelegationAction::Delegate,
        EngineDelegationAction::Delegate,
    ];
    let error = service
        .execute("command:designate:bad:3", EngineOrchestratorDesignationCommand::Designate(
            duplicate_action,
        ))
        .expect_err("duplicate action rejected");
    assert!(matches!(error, EngineOrchestratorDesignationCommandError::InvalidRequest { .. }));
}

#[test]
fn designation_round_trips_through_codecs() {
    let designation = EngineOrchestratorDesignation {
        designation_id: DESIGNATION_ID.to_owned(),
        project_id: "project:1".to_owned(),
        orchestrator_provider_instance: "codex:local-default".to_owned(),
        allowed_worker_provider_instances: None,
        allowed_worker_models: Some(vec!["gpt-5.4-mini".to_owned()]),
        concurrent_run_budget: 1,
        per_run_token_budget: None,
        per_run_time_budget_seconds: Some(60),
        allowed_actions: vec![EngineDelegationAction::RunStatus],
        steering_permitted: false,
        status: EngineOrchestratorDesignationStatus::Active,
        created_at: 1,
        updated_at: 2,
    };

    let encoded = encode_orchestrator_designation(&designation).expect("encode");
    let decoded = decode_orchestrator_designation(&encoded).expect("decode");
    assert_eq!(decoded, designation);

    // Storage record carries the designation kind.
    let record = EngineOrchestratorDesignationRecord {
        id: PersistenceRecordId(DESIGNATION_ID.to_owned()),
        kind: PersistenceRecordKind::OrchestratorDesignation,
        revision_id: RevisionId("rev:designation:1".to_owned()),
        payload: encoded,
    };
    assert_eq!(record.kind, PersistenceRecordKind::OrchestratorDesignation);
}
