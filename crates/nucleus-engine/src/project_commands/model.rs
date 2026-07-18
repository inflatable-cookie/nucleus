//! Project lifecycle command model and repository port.

use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_projects::ProjectId;

use crate::task_commands::{EngineRevisionExpectation, EngineTaskRecord};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineProjectCommand {
    Create(EngineProjectCreateCommand),
    Lifecycle(EngineProjectLifecycleCommand),
}

/// Retention chosen at creation. Transient projects back disposable chat
/// and stay out of the named-project rail until promoted.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EngineProjectRetentionChoice {
    Durable,
    Transient,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineProjectCreateCommand {
    pub display_name: String,
    pub retention: EngineProjectRetentionChoice,
    pub actor_ref: String,
    pub authority_host_ref: String,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineProjectLifecycleCommand {
    pub project_id: ProjectId,
    pub expected_revision: RevisionId,
    pub action: EngineProjectLifecycleAction,
    pub actor_ref: String,
    pub authority_host_ref: String,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineProjectLifecycleAction {
    Rename { display_name: String },
    Park,
    Archive,
    Restore,
    Delete,
    /// Transient -> durable in place; identity is preserved, records are
    /// never copied into a replacement project.
    Promote { display_name: Option<String> },
    /// Delete an expired transient project. Refused while any durable
    /// child (task, goal, accepted memory, resource) still references it.
    ExpireTransient,
}

/// Sanitized lifecycle receipt the engine asks the host to persist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineProjectLifecycleReceipt {
    pub command_id: String,
    pub idempotency_key: String,
    pub request_fingerprint: String,
    pub project_id: String,
    pub action: String,
    pub actor_ref: String,
    pub authority_host_ref: String,
    pub previous_revision: Option<String>,
    pub resulting_revision: Option<String>,
}

/// Domains scanned for retained records before a project delete.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EngineProjectScanDomain {
    Tasks,
    Planning,
    SharedMemory,
    AgentSessions,
    DeepResearch,
    Workspaces,
}

impl EngineProjectScanDomain {
    pub const ALL: [EngineProjectScanDomain; 6] = [
        EngineProjectScanDomain::Tasks,
        EngineProjectScanDomain::Planning,
        EngineProjectScanDomain::SharedMemory,
        EngineProjectScanDomain::AgentSessions,
        EngineProjectScanDomain::DeepResearch,
        EngineProjectScanDomain::Workspaces,
    ];

    pub fn label(&self) -> &'static str {
        match self {
            Self::Tasks => "tasks",
            Self::Planning => "planning",
            Self::SharedMemory => "memory",
            Self::AgentSessions => "conversations",
            Self::DeepResearch => "research",
            Self::Workspaces => "workspaces",
        }
    }
}

/// Storage and receipt port for project lifecycle commands.
pub trait EngineProjectRepository {
    type Error;

    /// Authority host this engine instance executes for.
    fn authority_host_ref(&self) -> String;

    fn get_project_record(
        &self,
        record_id: &PersistenceRecordId,
    ) -> Result<Option<EngineTaskRecord>, Self::Error>;

    fn put_project_record(
        &self,
        record: EngineTaskRecord,
        revision: EngineRevisionExpectation,
    ) -> Result<(), Self::Error>;

    fn delete_project_record(
        &self,
        record_id: &PersistenceRecordId,
        revision: EngineRevisionExpectation,
    ) -> Result<(), Self::Error>;

    /// Raw records of one domain, `(record_id, kind_label, payload_bytes)`,
    /// for the deletion-impact and transient-expiry scans.
    fn domain_payloads(
        &self,
        domain: EngineProjectScanDomain,
    ) -> Result<Vec<(String, String, Vec<u8>)>, Self::Error>;

    /// Fingerprint of a previously persisted receipt for this idempotency
    /// key, if any.
    fn receipt_fingerprint(&self, idempotency_key: &str) -> Result<Option<String>, Self::Error>;

    fn persist_receipt(&self, receipt: EngineProjectLifecycleReceipt) -> Result<(), Self::Error>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineProjectCommandError<E> {
    InvalidRequest { reason: String },
    NotFound { reason: String },
    Conflict { reason: String },
    Unauthorized { reason: String },
    Codec { reason: String },
    Storage(E),
}
