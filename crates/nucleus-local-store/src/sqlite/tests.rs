//! SQLite backend tests, split from the tests god file; behavior unchanged.

use super::*;
use crate::backend::LocalStoreDeploymentRole;
use crate::errors::LocalStoreError;
use crate::fixtures::fixture_record;
use crate::repositories::LocalStoreRepository;
use crate::revisions::RevisionExpectation;
use crate::transactions::LocalStoreTransactionPosture;
use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};

mod backend_tests;
mod recovery_tests;
mod repository_tests;

pub(super) fn sqlite_supported_domains() -> Vec<(PersistenceDomain, PersistenceRecordKind, &'static str)> {
    vec![
        (
            PersistenceDomain::Projects,
            PersistenceRecordKind::Project,
            "project:1",
        ),
        (
            PersistenceDomain::Tasks,
            PersistenceRecordKind::Task,
            "task:1",
        ),
        (
            PersistenceDomain::TaskHistory,
            PersistenceRecordKind::TaskHistoryEntry,
            "task:history:1",
        ),
        (
            PersistenceDomain::SharedMemory,
            PersistenceRecordKind::SharedMemoryRecord,
            "memory:1",
        ),
        (
            PersistenceDomain::SharedMemory,
            PersistenceRecordKind::SharedMemoryReviewReceipt,
            "memory:review-receipt:1",
        ),
        (
            PersistenceDomain::Planning,
            PersistenceRecordKind::PlanningSession,
            "planning:session:1",
        ),
        (
            PersistenceDomain::Planning,
            PersistenceRecordKind::Goal,
            "goal:1",
        ),
        (
            PersistenceDomain::Planning,
            PersistenceRecordKind::PlanningArtifact,
            "planning:artifact:1",
        ),
        (
            PersistenceDomain::Planning,
            PersistenceRecordKind::PlanningImportApplyPlan,
            "planning:import-apply-plan:1",
        ),
        (
            PersistenceDomain::Planning,
            PersistenceRecordKind::PlanningImportActiveApplyAdmission,
            "planning:import-active-apply-admission:1",
        ),
        (
            PersistenceDomain::Planning,
            PersistenceRecordKind::TaskSeed,
            "planning:task-seed:1",
        ),
        (
            PersistenceDomain::Workspaces,
            PersistenceRecordKind::WorkspaceLayout,
            "workspace:1",
        ),
        (
            PersistenceDomain::AdapterRegistry,
            PersistenceRecordKind::AdapterInstance,
            "adapter:1",
        ),
        (
            PersistenceDomain::AgentSessions,
            PersistenceRecordKind::AgentSession,
            "session:1",
        ),
        (
            PersistenceDomain::ModelRoutes,
            PersistenceRecordKind::ModelRoute,
            "route:1",
        ),
        (
            PersistenceDomain::EventJournal,
            PersistenceRecordKind::Event,
            "event:1",
        ),
        (
            PersistenceDomain::CommandEvidence,
            PersistenceRecordKind::CommandEvidence,
            "command:evidence:1",
        ),
        (
            PersistenceDomain::ArtifactMetadata,
            PersistenceRecordKind::ArtifactMetadata,
            "artifact:metadata:1",
        ),
        (
            PersistenceDomain::RuntimeEffects,
            PersistenceRecordKind::RuntimeEffect,
            "runtime:effect:1",
        ),
        (
            PersistenceDomain::OrchestrationRuns,
            PersistenceRecordKind::OrchestrationRun,
            "run:1",
        ),
    ]
}

pub(super) fn assert_sqlite_repository_recovers_after_reopen(
    domain: PersistenceDomain,
    kind: PersistenceRecordKind,
    id: &str,
) {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let database_path = tempdir.path().join("nucleus.sqlite3");

    {
        let mut repository =
            SqliteRepository::open(&database_path, domain.clone()).expect("open sqlite");
        let record = fixture_record(domain.clone(), kind.clone(), id, "rev:1");
        repository
            .put(
                record,
                RevisionExpectation::MustNotExist,
                LocalStoreTransactionPosture::Autocommit,
            )
            .expect("write record");
    }

    let repository = SqliteRepository::open(&database_path, domain).expect("reopen sqlite");
    let records = repository.list().expect("list after reopen");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].id, PersistenceRecordId(id.to_owned()));
    assert_eq!(records[0].kind, kind);
    assert_eq!(records[0].revision_id, RevisionId("rev:1".to_owned()));
}
