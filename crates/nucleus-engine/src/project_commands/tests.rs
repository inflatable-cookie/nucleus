use std::cell::RefCell;
use std::collections::HashMap;

use nucleus_core::PersistenceRecordId;

use super::model::{
    EngineProjectCommand, EngineProjectCommandError, EngineProjectCreateCommand,
    EngineProjectLifecycleReceipt, EngineProjectRepository, EngineProjectRetentionChoice,
    EngineProjectScanDomain,
};
use super::service::EngineProjectCommandService;
use crate::task_commands::{EngineRevisionExpectation, EngineTaskRecord};

#[derive(Default)]
struct MemoryProjectRepository {
    records: RefCell<HashMap<String, EngineTaskRecord>>,
    receipts: RefCell<HashMap<String, String>>,
    scan_records: Vec<(String, String, Vec<u8>)>,
}

impl EngineProjectRepository for &MemoryProjectRepository {
    type Error = String;

    fn authority_host_ref(&self) -> String {
        "host:local".to_owned()
    }

    fn get_project_record(
        &self,
        record_id: &PersistenceRecordId,
    ) -> Result<Option<EngineTaskRecord>, Self::Error> {
        Ok(self.records.borrow().get(&record_id.0).cloned())
    }

    fn put_project_record(
        &self,
        record: EngineTaskRecord,
        _revision: EngineRevisionExpectation,
    ) -> Result<(), Self::Error> {
        self.records
            .borrow_mut()
            .insert(record.id.0.clone(), record);
        Ok(())
    }

    fn delete_project_record(
        &self,
        record_id: &PersistenceRecordId,
        _revision: EngineRevisionExpectation,
    ) -> Result<(), Self::Error> {
        self.records.borrow_mut().remove(&record_id.0);
        Ok(())
    }

    fn domain_payloads(
        &self,
        _domain: EngineProjectScanDomain,
    ) -> Result<Vec<(String, String, Vec<u8>)>, Self::Error> {
        Ok(self.scan_records.clone())
    }

    fn receipt_fingerprint(&self, idempotency_key: &str) -> Result<Option<String>, Self::Error> {
        Ok(self.receipts.borrow().get(idempotency_key).cloned())
    }

    fn persist_receipt(&self, receipt: EngineProjectLifecycleReceipt) -> Result<(), Self::Error> {
        self.receipts
            .borrow_mut()
            .insert(receipt.idempotency_key, receipt.request_fingerprint);
        Ok(())
    }
}

fn create_command(idempotency_key: &str) -> EngineProjectCreateCommand {
    EngineProjectCreateCommand {
        display_name: "Nucleus".to_owned(),
        retention: EngineProjectRetentionChoice::Durable,
        actor_ref: "operator:tom".to_owned(),
        authority_host_ref: "host:local".to_owned(),
        idempotency_key: idempotency_key.to_owned(),
    }
}

#[test]
fn create_is_idempotent_and_conflicts_on_key_reuse() {
    let repository = MemoryProjectRepository::default();
    let service = EngineProjectCommandService::new(&repository);

    service
        .execute(
            "command:project:1",
            EngineProjectCommand::Create(create_command("idem:1")),
        )
        .expect("create project");
    assert_eq!(repository.records.borrow().len(), 1);

    // Same key + same request: replayed as a no-op.
    service
        .execute(
            "command:project:2",
            EngineProjectCommand::Create(create_command("idem:1")),
        )
        .expect("replayed create");
    assert_eq!(repository.records.borrow().len(), 1);

    // Same key, different request: conflict.
    let mut different = create_command("idem:1");
    different.display_name = "Other".to_owned();
    let result = service.execute(
        "command:project:3",
        EngineProjectCommand::Create(different),
    );
    assert!(matches!(
        result,
        Err(EngineProjectCommandError::Conflict { .. })
    ));
}

#[test]
fn create_rejects_wrong_authority_host() {
    let repository = MemoryProjectRepository::default();
    let service = EngineProjectCommandService::new(&repository);

    let mut command = create_command("idem:2");
    command.authority_host_ref = "host:other".to_owned();
    let result = service.execute("command:project:4", EngineProjectCommand::Create(command));

    assert!(matches!(
        result,
        Err(EngineProjectCommandError::Unauthorized { .. })
    ));
}

#[test]
fn transient_create_defaults_name_and_promotion_requires_transient() {
    use nucleus_projects::{decode_project_storage_record, ProjectRetentionStorage};

    let repository = MemoryProjectRepository::default();
    let service = EngineProjectCommandService::new(&repository);

    let mut command = create_command("idem:transient");
    command.display_name = String::new();
    command.retention = EngineProjectRetentionChoice::Transient;
    service
        .execute("command:project:t1", EngineProjectCommand::Create(command))
        .expect("create transient project");

    let stored = repository.records.borrow();
    let record = stored.values().next().expect("stored transient project");
    let project = decode_project_storage_record(&record.payload).expect("decode project");
    assert_eq!(project.display_name, "New Chat");
    assert_eq!(project.retention, ProjectRetentionStorage::Transient);
}

#[test]
fn durable_create_still_requires_a_name() {
    let repository = MemoryProjectRepository::default();
    let service = EngineProjectCommandService::new(&repository);

    let mut command = create_command("idem:unnamed");
    command.display_name = "   ".to_owned();
    let result = service.execute("command:project:t2", EngineProjectCommand::Create(command));

    assert!(matches!(
        result,
        Err(EngineProjectCommandError::InvalidRequest { .. })
    ));
}

use super::model::{EngineProjectLifecycleAction, EngineProjectLifecycleCommand};
use nucleus_core::RevisionId as CoreRevisionId;
use nucleus_projects::ProjectId as DomainProjectId;

fn lifecycle_command(
    project_id: &str,
    revision: &str,
    action: EngineProjectLifecycleAction,
    idempotency_key: &str,
) -> EngineProjectLifecycleCommand {
    EngineProjectLifecycleCommand {
        project_id: DomainProjectId(project_id.to_owned()),
        expected_revision: CoreRevisionId(revision.to_owned()),
        action,
        actor_ref: "operator:tom".to_owned(),
        authority_host_ref: "host:local".to_owned(),
        idempotency_key: idempotency_key.to_owned(),
    }
}

fn create_transient(repository: &MemoryProjectRepository, idem: &str) -> (String, String) {
    let service = EngineProjectCommandService::new(repository);
    let mut command = create_command(idem);
    command.display_name = String::new();
    command.retention = EngineProjectRetentionChoice::Transient;
    service
        .execute(&format!("command:{idem}"), EngineProjectCommand::Create(command))
        .expect("create transient");
    let stored = repository.records.borrow();
    let record = stored.values().next().expect("stored");
    (record.id.0.clone(), record.revision_id.0.clone())
}

#[test]
fn promotion_turns_transient_durable_in_place_and_preserves_identity() {
    use nucleus_projects::{decode_project_storage_record, ProjectRetentionStorage};

    let repository = MemoryProjectRepository::default();
    let (project_id, revision) = create_transient(&repository, "idem:promote");
    let service = EngineProjectCommandService::new(&repository);

    service
        .execute(
            "command:promote:1",
            EngineProjectCommand::Lifecycle(lifecycle_command(
                &project_id,
                &revision,
                EngineProjectLifecycleAction::Promote {
                    display_name: Some("Real Work".to_owned()),
                },
                "idem:promote:apply",
            )),
        )
        .expect("promote transient");

    let stored = repository.records.borrow();
    let record = stored.get(&project_id).expect("same project id survives");
    let project = decode_project_storage_record(&record.payload).expect("decode");
    assert_eq!(project.retention, ProjectRetentionStorage::Durable);
    assert_eq!(project.display_name, "Real Work");
}

#[test]
fn transient_expiry_is_blocked_by_durable_children_and_allowed_when_clean() {
    let mut repository = MemoryProjectRepository::default();
    let (project_id, revision) = create_transient(&repository, "idem:expire");
    repository.scan_records = vec![(
        "task:child".to_owned(),
        "Task".to_owned(),
        format!("{{\"project_id\":\"{project_id}\"}}").into_bytes(),
    )];

    let service = EngineProjectCommandService::new(&repository);
    let blocked = service.execute(
        "command:expire:1",
        EngineProjectCommand::Lifecycle(lifecycle_command(
            &project_id,
            &revision,
            EngineProjectLifecycleAction::ExpireTransient,
            "idem:expire:blocked",
        )),
    );
    assert!(matches!(
        blocked,
        Err(EngineProjectCommandError::InvalidRequest { reason })
            if reason.contains("retention decision")
    ));

    repository.scan_records = Vec::new();
    let service = EngineProjectCommandService::new(&repository);
    service
        .execute(
            "command:expire:2",
            EngineProjectCommand::Lifecycle(lifecycle_command(
                &project_id,
                &revision,
                EngineProjectLifecycleAction::ExpireTransient,
                "idem:expire:clean",
            )),
        )
        .expect("expire clean transient");
    assert!(repository.records.borrow().is_empty());
}
