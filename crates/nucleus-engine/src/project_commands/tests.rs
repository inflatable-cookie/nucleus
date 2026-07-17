use std::cell::RefCell;
use std::collections::HashMap;

use nucleus_core::PersistenceRecordId;

use super::model::{
    EngineProjectCommand, EngineProjectCommandError, EngineProjectCreateCommand,
    EngineProjectLifecycleReceipt, EngineProjectRepository, EngineProjectScanDomain,
};
use super::service::EngineProjectCommandService;
use crate::task_commands::{EngineRevisionExpectation, EngineTaskRecord};

#[derive(Default)]
struct MemoryProjectRepository {
    records: RefCell<HashMap<String, EngineTaskRecord>>,
    receipts: RefCell<HashMap<String, String>>,
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
    ) -> Result<Vec<(String, Vec<u8>)>, Self::Error> {
        Ok(Vec::new())
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
