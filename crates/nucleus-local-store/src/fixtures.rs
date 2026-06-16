//! In-memory conformance fixtures for repository behavior.

use std::collections::HashMap;

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};

use crate::errors::{LocalStoreError, LocalStoreResult};
use crate::repositories::{
    LocalStoreRecord, LocalStoreRecordPayload, LocalStoreRepository, LocalStoreRepositoryDescriptor,
};
use crate::revisions::{RevisionConflict, RevisionExpectation};
use crate::transactions::LocalStoreTransactionPosture;

/// Boundary marker for in-memory conformance fixtures.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InMemoryFixtureBoundary;

/// In-memory repository fixture for storage conformance tests.
///
/// This is not a production backend. It exists to prove repository trait
/// behavior before SQLite or any other backend is introduced.
#[derive(Clone, Debug)]
pub struct InMemoryRepositoryFixture {
    descriptor: LocalStoreRepositoryDescriptor,
    records: HashMap<PersistenceRecordId, LocalStoreRecord>,
}

impl InMemoryRepositoryFixture {
    /// Create an empty fixture for one persistence domain.
    pub fn new(domain: PersistenceDomain) -> Self {
        Self {
            descriptor: LocalStoreRepositoryDescriptor {
                domain,
                supports_transactions: false,
            },
            records: HashMap::new(),
        }
    }

    fn check_transaction(transaction: LocalStoreTransactionPosture) -> LocalStoreResult<()> {
        match transaction {
            LocalStoreTransactionPosture::Autocommit => Ok(()),
            LocalStoreTransactionPosture::Existing(_)
            | LocalStoreTransactionPosture::Required(_) => {
                Err(LocalStoreError::TransactionRejected {
                    reason: "in-memory conformance fixture supports autocommit only".to_owned(),
                })
            }
        }
    }

    fn check_domain(&self, record: &LocalStoreRecord) -> LocalStoreResult<()> {
        if record.domain == self.descriptor.domain {
            Ok(())
        } else {
            Err(LocalStoreError::UnsupportedDomain {
                domain: record.domain.clone(),
            })
        }
    }

    fn check_revision(
        &self,
        record_id: &PersistenceRecordId,
        expectation: RevisionExpectation,
    ) -> LocalStoreResult<()> {
        let actual = self
            .records
            .get(record_id)
            .map(|record| record.revision_id.clone());
        let satisfied = match (&expectation, &actual) {
            (RevisionExpectation::Any, _) => true,
            (RevisionExpectation::MustNotExist, None) => true,
            (RevisionExpectation::MustExist, Some(_)) => true,
            (RevisionExpectation::Exact(expected), Some(actual)) => expected == actual,
            _ => false,
        };

        if satisfied {
            Ok(())
        } else {
            Err(LocalStoreError::RevisionConflict(RevisionConflict {
                record_id: record_id.clone(),
                expected: expectation,
                actual,
            }))
        }
    }
}

impl LocalStoreRepository for InMemoryRepositoryFixture {
    fn descriptor(&self) -> LocalStoreRepositoryDescriptor {
        self.descriptor.clone()
    }

    fn get(&self, id: &PersistenceRecordId) -> LocalStoreResult<Option<LocalStoreRecord>> {
        Ok(self.records.get(id).cloned())
    }

    fn list(&self) -> LocalStoreResult<Vec<LocalStoreRecord>> {
        let mut records: Vec<_> = self.records.values().cloned().collect();
        records.sort_by(|left, right| left.id.0.cmp(&right.id.0));
        Ok(records)
    }

    fn put(
        &mut self,
        record: LocalStoreRecord,
        revision: RevisionExpectation,
        transaction: LocalStoreTransactionPosture,
    ) -> LocalStoreResult<LocalStoreRecord> {
        Self::check_transaction(transaction)?;
        self.check_domain(&record)?;
        self.check_revision(&record.id, revision)?;
        self.records.insert(record.id.clone(), record.clone());
        Ok(record)
    }

    fn delete(
        &mut self,
        id: &PersistenceRecordId,
        revision: RevisionExpectation,
        transaction: LocalStoreTransactionPosture,
    ) -> LocalStoreResult<()> {
        Self::check_transaction(transaction)?;
        self.check_revision(id, revision)?;
        self.records
            .remove(id)
            .map(|_| ())
            .ok_or_else(|| LocalStoreError::RecordNotFound {
                record_id: id.clone(),
            })
    }
}

/// Build a deterministic fixture record for conformance tests.
pub fn fixture_record(
    domain: PersistenceDomain,
    kind: PersistenceRecordKind,
    id: &str,
    revision: &str,
) -> LocalStoreRecord {
    LocalStoreRecord {
        id: PersistenceRecordId(id.to_owned()),
        domain,
        kind,
        revision_id: RevisionId(revision.to_owned()),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/x.nucleus.fixture".to_owned()),
            bytes: id.as_bytes().to_vec(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transactions::{LocalStoreTransactionBoundary, LocalStoreTransactionPosture};

    fn record_kind_for(domain: &PersistenceDomain) -> PersistenceRecordKind {
        match domain {
            PersistenceDomain::Projects => PersistenceRecordKind::Project,
            PersistenceDomain::Tasks => PersistenceRecordKind::Task,
            PersistenceDomain::Workspaces => PersistenceRecordKind::WorkspaceLayout,
            PersistenceDomain::SharedMemory => PersistenceRecordKind::SharedMemoryRecord,
            PersistenceDomain::Planning => PersistenceRecordKind::PlanningArtifact,
            PersistenceDomain::DeepResearch => PersistenceRecordKind::ResearchRun,
            PersistenceDomain::ProjectTooling => PersistenceRecordKind::EffigyIntegration,
            other => panic!("fixture conformance domain not covered: {other:?}"),
        }
    }

    fn assert_create_read_update_list_delete(domain: PersistenceDomain) {
        let kind = record_kind_for(&domain);
        let mut repository = InMemoryRepositoryFixture::new(domain.clone());

        let created = fixture_record(domain.clone(), kind.clone(), "record:1", "rev:1");
        let stored = repository
            .put(
                created.clone(),
                RevisionExpectation::MustNotExist,
                LocalStoreTransactionPosture::Autocommit,
            )
            .expect("create should store record");

        assert_eq!(stored, created);
        assert_eq!(
            repository
                .get(&created.id)
                .expect("read should succeed")
                .expect("record should exist"),
            created
        );
        assert_eq!(repository.list().expect("list should succeed").len(), 1);

        let updated = fixture_record(domain, kind, "record:1", "rev:2");
        repository
            .put(
                updated.clone(),
                RevisionExpectation::Exact(RevisionId("rev:1".to_owned())),
                LocalStoreTransactionPosture::Autocommit,
            )
            .expect("update should satisfy exact revision");

        assert_eq!(
            repository
                .get(&updated.id)
                .expect("read updated should succeed")
                .expect("updated record should exist")
                .revision_id,
            RevisionId("rev:2".to_owned())
        );

        repository
            .delete(
                &updated.id,
                RevisionExpectation::Exact(RevisionId("rev:2".to_owned())),
                LocalStoreTransactionPosture::Autocommit,
            )
            .expect("delete should satisfy exact revision");

        assert_eq!(
            repository.get(&updated.id).expect("read after delete"),
            None
        );
    }

    #[test]
    fn conformance_fixture_handles_first_domain_records() {
        for domain in [
            PersistenceDomain::Projects,
            PersistenceDomain::Tasks,
            PersistenceDomain::Workspaces,
            PersistenceDomain::SharedMemory,
            PersistenceDomain::Planning,
            PersistenceDomain::DeepResearch,
            PersistenceDomain::ProjectTooling,
        ] {
            assert_create_read_update_list_delete(domain);
        }
    }

    #[test]
    fn conformance_fixture_rejects_stale_revision() {
        let mut repository = InMemoryRepositoryFixture::new(PersistenceDomain::Tasks);
        let created = fixture_record(
            PersistenceDomain::Tasks,
            PersistenceRecordKind::Task,
            "task:1",
            "rev:1",
        );
        repository
            .put(
                created.clone(),
                RevisionExpectation::MustNotExist,
                LocalStoreTransactionPosture::Autocommit,
            )
            .expect("create should succeed");

        let stale_update = fixture_record(
            PersistenceDomain::Tasks,
            PersistenceRecordKind::Task,
            "task:1",
            "rev:2",
        );
        let error = repository
            .put(
                stale_update,
                RevisionExpectation::Exact(RevisionId("stale".to_owned())),
                LocalStoreTransactionPosture::Autocommit,
            )
            .expect_err("stale revision should be rejected");

        assert!(matches!(error, LocalStoreError::RevisionConflict(_)));
        assert_eq!(
            repository
                .get(&created.id)
                .expect("read should succeed")
                .expect("record should remain unchanged")
                .revision_id,
            RevisionId("rev:1".to_owned())
        );
    }

    #[test]
    fn conformance_fixture_rejects_cross_domain_records() {
        let mut repository = InMemoryRepositoryFixture::new(PersistenceDomain::Projects);
        let task_record = fixture_record(
            PersistenceDomain::Tasks,
            PersistenceRecordKind::Task,
            "task:1",
            "rev:1",
        );

        let error = repository
            .put(
                task_record,
                RevisionExpectation::Any,
                LocalStoreTransactionPosture::Autocommit,
            )
            .expect_err("cross-domain write should be rejected");

        assert_eq!(
            error,
            LocalStoreError::UnsupportedDomain {
                domain: PersistenceDomain::Tasks,
            }
        );
    }

    #[test]
    fn conformance_fixture_rejects_non_autocommit_transactions() {
        let mut repository = InMemoryRepositoryFixture::new(PersistenceDomain::ProjectTooling);
        let record = fixture_record(
            PersistenceDomain::ProjectTooling,
            PersistenceRecordKind::EffigyIntegration,
            "effigy:1",
            "rev:1",
        );

        let error = repository
            .put(
                record,
                RevisionExpectation::Any,
                LocalStoreTransactionPosture::Existing(LocalStoreTransactionBoundary {
                    id: "tx:1".to_owned(),
                }),
            )
            .expect_err("fixture does not implement backend transactions");

        assert!(matches!(error, LocalStoreError::TransactionRejected { .. }));
    }
}
