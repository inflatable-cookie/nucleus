//! Forge repository and collaboration refs.

use crate::ids::{ForgeProviderRef, ScmRepositoryRefId};

/// Forge provider family.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ForgeProviderKind {
    GitHub,
    GitLab,
    Gitea,
    Bitbucket,
    Custom(String),
}

/// Forge-side repository ref.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgeRepositoryRef {
    pub provider_kind: ForgeProviderKind,
    pub provider_ref: ForgeProviderRef,
    pub repository_id: Option<ScmRepositoryRefId>,
    pub web_url: Option<String>,
}

/// Pull request or merge request ref.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgePullRequestRef {
    pub repository: ForgeRepositoryRef,
    pub provider_ref: ForgeProviderRef,
    pub number: Option<u64>,
    pub title: Option<String>,
    pub web_url: Option<String>,
}

/// Issue ref.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgeIssueRef {
    pub repository: ForgeRepositoryRef,
    pub provider_ref: ForgeProviderRef,
    pub number: Option<u64>,
    pub title: Option<String>,
    pub web_url: Option<String>,
}

/// Comment ref.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgeCommentRef {
    pub provider_ref: ForgeProviderRef,
    pub parent_ref: ForgeProviderRef,
    pub web_url: Option<String>,
}
