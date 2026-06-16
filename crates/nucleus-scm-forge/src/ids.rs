//! SCM and forge identity records.

/// Configured SCM adapter instance id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ScmAdapterInstanceId(pub String);

/// Configured forge adapter instance id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ForgeAdapterInstanceId(pub String);

/// Provider-native SCM reference retained as metadata.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ScmProviderRef(pub String);

/// Provider-native forge reference retained as metadata.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ForgeProviderRef(pub String);

/// Stable nucleus repository reference id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ScmRepositoryRefId(pub String);

/// Stable nucleus worktree reference id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ScmWorktreeRefId(pub String);

/// Stable nucleus SCM work session id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ScmWorkSessionId(pub String);
