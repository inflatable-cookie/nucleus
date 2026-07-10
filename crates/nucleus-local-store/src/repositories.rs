//! Repository trait vocabulary for persisted domains.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};

use crate::errors::LocalStoreResult;
use crate::revisions::RevisionExpectation;
use crate::transactions::LocalStoreTransactionPosture;

/// Planned repository boundary before repository traits exist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepositoryBoundary {
    pub domain: PersistenceDomain,
    pub description: &'static str,
}

/// Opaque payload at the local-store boundary.
///
/// This avoids choosing TOML, JSON, bincode, normalized SQL rows, or another
/// serialization shape in the repository trait card.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalStoreRecordPayload {
    pub media_type: Option<String>,
    pub bytes: Vec<u8>,
}

/// Generic persisted record at the local-store boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalStoreRecord {
    pub id: PersistenceRecordId,
    pub domain: PersistenceDomain,
    pub kind: PersistenceRecordKind,
    pub revision_id: RevisionId,
    pub payload: LocalStoreRecordPayload,
}

/// Description of one repository surface.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalStoreRepositoryDescriptor {
    pub domain: PersistenceDomain,
    pub supports_transactions: bool,
}

/// Small repository trait for durable domain records.
///
/// Implementations are intentionally deferred. The trait is synchronous and
/// payload-shaped until backend and runtime choices are made.
pub trait LocalStoreRepository {
    fn descriptor(&self) -> LocalStoreRepositoryDescriptor;

    fn get(&self, id: &PersistenceRecordId) -> LocalStoreResult<Option<LocalStoreRecord>>;

    fn list(&self) -> LocalStoreResult<Vec<LocalStoreRecord>>;

    fn put(
        &mut self,
        record: LocalStoreRecord,
        revision: RevisionExpectation,
        transaction: LocalStoreTransactionPosture,
    ) -> LocalStoreResult<LocalStoreRecord>;

    fn delete(
        &mut self,
        id: &PersistenceRecordId,
        revision: RevisionExpectation,
        transaction: LocalStoreTransactionPosture,
    ) -> LocalStoreResult<()>;
}

/// Backend adapter that can open domain repositories.
///
/// Backends own database connection strategy. Domain repository callers should
/// not know whether records live in SQLite, PostgreSQL, a remote service, or a
/// fixture.
pub trait LocalStoreBackend {
    fn backend_descriptor(&self) -> crate::backend::LocalStoreBackendDescriptor;

    fn open_repository(
        &self,
        domain: PersistenceDomain,
    ) -> LocalStoreResult<Box<dyn LocalStoreRepository>>;
}

/// Compile-only repository boundary for future domain-specific repositories.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalStoreRepositoryBoundary {
    pub descriptor: LocalStoreRepositoryDescriptor,
}

impl RepositoryBoundary {
    /// Planned project repository boundary.
    pub fn projects() -> Self {
        Self {
            domain: PersistenceDomain::Projects,
            description: "durable project identity and repo membership records",
        }
    }

    /// Planned task repository boundary.
    pub fn tasks() -> Self {
        Self {
            domain: PersistenceDomain::Tasks,
            description: "durable task records and task projection metadata",
        }
    }

    /// Planned workspace repository boundary.
    pub fn workspaces() -> Self {
        Self {
            domain: PersistenceDomain::Workspaces,
            description: "persisted workspace layout and panel state records",
        }
    }

    /// Planned shared memory repository boundary.
    pub fn shared_memory() -> Self {
        Self {
            domain: PersistenceDomain::SharedMemory,
            description: "accepted and proposed shared memory records",
        }
    }

    /// Planned structured planning repository boundary.
    pub fn planning() -> Self {
        Self {
            domain: PersistenceDomain::Planning,
            description: "planning sessions, goals, artifacts, and task seed records",
        }
    }

    /// Planned deep research repository boundary.
    pub fn deep_research() -> Self {
        Self {
            domain: PersistenceDomain::DeepResearch,
            description: "research runs, sources, observations, and synthesis records",
        }
    }

    /// Planned project tooling repository boundary.
    pub fn project_tooling() -> Self {
        Self {
            domain: PersistenceDomain::ProjectTooling,
            description: "project tool integration and Effigy integration records",
        }
    }

    /// Planned adapter registry repository boundary.
    pub fn adapter_registry() -> Self {
        Self {
            domain: PersistenceDomain::AdapterRegistry,
            description: "configured adapter instance registry records",
        }
    }

    /// Planned agent session repository boundary.
    pub fn agent_sessions() -> Self {
        Self {
            domain: PersistenceDomain::AgentSessions,
            description: "server-owned agent session records",
        }
    }

    /// Planned model route repository boundary.
    pub fn model_routes() -> Self {
        Self {
            domain: PersistenceDomain::ModelRoutes,
            description: "model route records with credential refs only",
        }
    }

    /// Planned event journal repository boundary.
    pub fn event_journal() -> Self {
        Self {
            domain: PersistenceDomain::EventJournal,
            description: "server event journal records",
        }
    }

    /// Planned command evidence repository boundary.
    pub fn command_evidence() -> Self {
        Self {
            domain: PersistenceDomain::CommandEvidence,
            description: "sanitized command evidence metadata records",
        }
    }

    /// Planned artifact metadata repository boundary.
    pub fn artifact_metadata() -> Self {
        Self {
            domain: PersistenceDomain::ArtifactMetadata,
            description: "artifact metadata and retention ref records",
        }
    }

    /// Planned runtime effects repository boundary.
    pub fn runtime_effects() -> Self {
        Self {
            domain: PersistenceDomain::RuntimeEffects,
            description: "runtime effect refs and latest-state records",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ShapeOnlyRepository {
        descriptor: LocalStoreRepositoryDescriptor,
    }

    impl LocalStoreRepository for ShapeOnlyRepository {
        fn descriptor(&self) -> LocalStoreRepositoryDescriptor {
            self.descriptor.clone()
        }

        fn get(&self, _id: &PersistenceRecordId) -> LocalStoreResult<Option<LocalStoreRecord>> {
            Ok(None)
        }

        fn list(&self) -> LocalStoreResult<Vec<LocalStoreRecord>> {
            Ok(Vec::new())
        }

        fn put(
            &mut self,
            record: LocalStoreRecord,
            _revision: RevisionExpectation,
            _transaction: LocalStoreTransactionPosture,
        ) -> LocalStoreResult<LocalStoreRecord> {
            Ok(record)
        }

        fn delete(
            &mut self,
            _id: &PersistenceRecordId,
            _revision: RevisionExpectation,
            _transaction: LocalStoreTransactionPosture,
        ) -> LocalStoreResult<()> {
            Ok(())
        }
    }

    #[test]
    fn repository_trait_shape_is_implementable_without_backend() {
        let mut repository = ShapeOnlyRepository {
            descriptor: LocalStoreRepositoryDescriptor {
                domain: PersistenceDomain::Projects,
                supports_transactions: false,
            },
        };
        let record = LocalStoreRecord {
            id: PersistenceRecordId("project:1".to_owned()),
            domain: PersistenceDomain::Projects,
            kind: PersistenceRecordKind::Project,
            revision_id: RevisionId("rev:1".to_owned()),
            payload: LocalStoreRecordPayload {
                media_type: None,
                bytes: Vec::new(),
            },
        };

        let stored = repository
            .put(
                record,
                RevisionExpectation::Any,
                LocalStoreTransactionPosture::Autocommit,
            )
            .expect("shape-only put should return the record");

        assert_eq!(stored.id, PersistenceRecordId("project:1".to_owned()));
        assert_eq!(repository.list().expect("shape-only list"), Vec::new());
    }
}
