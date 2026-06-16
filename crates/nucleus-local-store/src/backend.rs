//! Backend adapter boundary for server-local storage.

/// Planned backend families for server-local storage.
///
/// SQLite is the first local backend. PostgreSQL and other remote/database
/// backends must fit this boundary later without changing domain repositories.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalStoreBackendFamily {
    Sqlite,
    Postgres,
    RemoteSql,
    InMemoryFixture,
    Custom(String),
}

/// Deployment role a storage backend is expected to serve.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalStoreDeploymentRole {
    SinglePlayerLocal,
    CentralizedTeamServer,
    ManagedRemote,
    TestFixture,
    Custom(String),
}

/// Storage backend descriptor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalStoreBackendDescriptor {
    pub family: LocalStoreBackendFamily,
    pub role: LocalStoreDeploymentRole,
    pub supports_backend_transactions: bool,
}

/// Compile-only statement of the intended backend posture.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalStoreBackendPlan {
    pub primary: LocalStoreBackendDescriptor,
    pub fixture: Option<LocalStoreBackendDescriptor>,
}
