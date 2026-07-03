//! Server-owned state service facade.
//!
//! Clients should talk to server control surfaces, not directly to storage
//! repositories. This module keeps the first local state facade transport-free
//! and backend-adapter based.

use nucleus_core::{PersistenceDomain, PersistenceRecordId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreBackendDescriptor, LocalStoreRecord,
    LocalStoreRepositoryDescriptor, LocalStoreResult, LocalStoreTransactionPosture,
    RevisionExpectation,
};

/// First state domains exposed through the server facade.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServerStateDomain {
    Projects,
    Tasks,
    TaskHistory,
    SharedMemory,
    Planning,
    Workspaces,
    AdapterRegistry,
    AgentSessions,
    ModelRoutes,
    EventJournal,
    CommandEvidence,
    ArtifactMetadata,
    RuntimeEffects,
}

impl ServerStateDomain {
    /// Underlying persisted domain.
    pub fn persistence_domain(&self) -> PersistenceDomain {
        match self {
            Self::Projects => PersistenceDomain::Projects,
            Self::Tasks => PersistenceDomain::Tasks,
            Self::TaskHistory => PersistenceDomain::TaskHistory,
            Self::SharedMemory => PersistenceDomain::SharedMemory,
            Self::Planning => PersistenceDomain::Planning,
            Self::Workspaces => PersistenceDomain::Workspaces,
            Self::AdapterRegistry => PersistenceDomain::AdapterRegistry,
            Self::AgentSessions => PersistenceDomain::AgentSessions,
            Self::ModelRoutes => PersistenceDomain::ModelRoutes,
            Self::EventJournal => PersistenceDomain::EventJournal,
            Self::CommandEvidence => PersistenceDomain::CommandEvidence,
            Self::ArtifactMetadata => PersistenceDomain::ArtifactMetadata,
            Self::RuntimeEffects => PersistenceDomain::RuntimeEffects,
        }
    }
}

/// Server-owned facade over a local-store backend.
#[derive(Clone, Debug)]
pub struct ServerStateService<B> {
    backend: B,
}

impl<B> ServerStateService<B>
where
    B: LocalStoreBackend,
{
    /// Create a server state facade from a storage backend adapter.
    pub fn new(backend: B) -> Self {
        Self { backend }
    }

    /// Describe the active backend without exposing repositories.
    pub fn backend_descriptor(&self) -> LocalStoreBackendDescriptor {
        self.backend.backend_descriptor()
    }

    /// Open a server-mediated domain service.
    pub fn domain(&self, domain: ServerStateDomain) -> ServerStateDomainService<'_, B> {
        ServerStateDomainService {
            backend: &self.backend,
            domain,
        }
    }

    pub fn projects(&self) -> ServerStateDomainService<'_, B> {
        self.domain(ServerStateDomain::Projects)
    }

    pub fn tasks(&self) -> ServerStateDomainService<'_, B> {
        self.domain(ServerStateDomain::Tasks)
    }

    pub fn task_history(&self) -> ServerStateDomainService<'_, B> {
        self.domain(ServerStateDomain::TaskHistory)
    }

    pub fn shared_memory(&self) -> ServerStateDomainService<'_, B> {
        self.domain(ServerStateDomain::SharedMemory)
    }

    pub fn planning(&self) -> ServerStateDomainService<'_, B> {
        self.domain(ServerStateDomain::Planning)
    }

    pub fn workspaces(&self) -> ServerStateDomainService<'_, B> {
        self.domain(ServerStateDomain::Workspaces)
    }

    pub fn adapter_registry(&self) -> ServerStateDomainService<'_, B> {
        self.domain(ServerStateDomain::AdapterRegistry)
    }

    pub fn agent_sessions(&self) -> ServerStateDomainService<'_, B> {
        self.domain(ServerStateDomain::AgentSessions)
    }

    pub fn model_routes(&self) -> ServerStateDomainService<'_, B> {
        self.domain(ServerStateDomain::ModelRoutes)
    }

    pub fn event_journal(&self) -> ServerStateDomainService<'_, B> {
        self.domain(ServerStateDomain::EventJournal)
    }

    pub fn command_evidence(&self) -> ServerStateDomainService<'_, B> {
        self.domain(ServerStateDomain::CommandEvidence)
    }

    pub fn artifact_metadata(&self) -> ServerStateDomainService<'_, B> {
        self.domain(ServerStateDomain::ArtifactMetadata)
    }

    pub fn runtime_effects(&self) -> ServerStateDomainService<'_, B> {
        self.domain(ServerStateDomain::RuntimeEffects)
    }
}

/// Domain-specific server state access.
///
/// This wrapper opens repositories per operation and keeps repository handles
/// out of the control-plane boundary.
#[derive(Clone, Debug)]
pub struct ServerStateDomainService<'a, B> {
    backend: &'a B,
    domain: ServerStateDomain,
}

impl<B> ServerStateDomainService<'_, B>
where
    B: LocalStoreBackend,
{
    /// Domain served by this state facade.
    pub fn domain(&self) -> &ServerStateDomain {
        &self.domain
    }

    /// Describe the underlying domain repository.
    pub fn repository_descriptor(&self) -> LocalStoreResult<LocalStoreRepositoryDescriptor> {
        let repository = self
            .backend
            .open_repository(self.domain.persistence_domain())?;
        Ok(repository.descriptor())
    }

    /// Read one persisted record.
    pub fn get(&self, id: &PersistenceRecordId) -> LocalStoreResult<Option<LocalStoreRecord>> {
        let repository = self
            .backend
            .open_repository(self.domain.persistence_domain())?;
        repository.get(id)
    }

    /// List persisted records in this domain.
    pub fn list(&self) -> LocalStoreResult<Vec<LocalStoreRecord>> {
        let repository = self
            .backend
            .open_repository(self.domain.persistence_domain())?;
        repository.list()
    }

    /// Store one record through server-owned state access.
    pub fn put(
        &self,
        record: LocalStoreRecord,
        revision: RevisionExpectation,
    ) -> LocalStoreResult<LocalStoreRecord> {
        let mut repository = self
            .backend
            .open_repository(self.domain.persistence_domain())?;
        repository.put(record, revision, LocalStoreTransactionPosture::Autocommit)
    }

    /// Delete one record through server-owned state access.
    pub fn delete(
        &self,
        id: &PersistenceRecordId,
        revision: RevisionExpectation,
    ) -> LocalStoreResult<()> {
        let mut repository = self
            .backend
            .open_repository(self.domain.persistence_domain())?;
        repository.delete(id, revision, LocalStoreTransactionPosture::Autocommit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_core::{PersistenceRecordKind, RevisionId};
    use nucleus_local_store::{
        fixture_record, LocalStoreBackendFamily, LocalStoreDeploymentRole, SqliteBackend,
    };

    fn sqlite_service() -> (
        tempfile::TempDir,
        ServerStateService<nucleus_local_store::SqliteBackend>,
    ) {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        (temp_dir, ServerStateService::new(backend))
    }

    #[test]
    fn state_service_describes_backend_without_exposing_repositories() {
        let (_temp_dir, service) = sqlite_service();

        let descriptor = service.backend_descriptor();

        assert_eq!(descriptor.family, LocalStoreBackendFamily::Sqlite);
        assert_eq!(descriptor.role, LocalStoreDeploymentRole::SinglePlayerLocal);
    }

    #[test]
    fn state_service_writes_and_reads_project_records() {
        let (_temp_dir, service) = sqlite_service();
        let record = fixture_record(
            PersistenceDomain::Projects,
            PersistenceRecordKind::Project,
            "project:1",
            "rev:1",
        );

        service
            .projects()
            .put(record.clone(), RevisionExpectation::MustNotExist)
            .expect("project put");

        assert_eq!(
            service.projects().get(&record.id).expect("project get"),
            Some(record.clone())
        );
        assert_eq!(
            service.projects().list().expect("project list"),
            vec![record]
        );
    }

    #[test]
    fn state_service_preserves_revision_checks() {
        let (_temp_dir, service) = sqlite_service();
        let created = fixture_record(
            PersistenceDomain::Tasks,
            PersistenceRecordKind::Task,
            "task:1",
            "rev:1",
        );
        service
            .tasks()
            .put(created.clone(), RevisionExpectation::MustNotExist)
            .expect("task create");

        let updated = fixture_record(
            PersistenceDomain::Tasks,
            PersistenceRecordKind::Task,
            "task:1",
            "rev:2",
        );
        service
            .tasks()
            .put(
                updated.clone(),
                RevisionExpectation::Exact(RevisionId("rev:1".to_owned())),
            )
            .expect("task update");

        assert_eq!(
            service
                .tasks()
                .get(&updated.id)
                .expect("task read")
                .expect("task exists")
                .revision_id,
            RevisionId("rev:2".to_owned())
        );
    }

    #[test]
    fn state_service_opens_first_domain_descriptors() {
        let (_temp_dir, service) = sqlite_service();
        let domains = [
            ServerStateDomain::Projects,
            ServerStateDomain::Tasks,
            ServerStateDomain::SharedMemory,
            ServerStateDomain::Workspaces,
            ServerStateDomain::AdapterRegistry,
            ServerStateDomain::AgentSessions,
            ServerStateDomain::ModelRoutes,
            ServerStateDomain::EventJournal,
            ServerStateDomain::CommandEvidence,
            ServerStateDomain::ArtifactMetadata,
            ServerStateDomain::RuntimeEffects,
        ];

        for domain in domains {
            let descriptor = service
                .domain(domain.clone())
                .repository_descriptor()
                .expect("repository descriptor");
            assert_eq!(descriptor.domain, domain.persistence_domain());
        }
    }
}
