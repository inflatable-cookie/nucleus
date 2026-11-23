use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use longhorn_git_workspace::{Git, GitCredential, GitFailure, GitFailureCode, GitPolicy};
use longhorn_redact::{RedactionRules, Redactor};
use nucleus_core::{Head, Identity, Role};
use nucleus_forge::Branches;
use nucleus_hosts::{HostError, RoleProfile};
use serde::{Deserialize, Serialize};

use crate::ServiceError;

const FIXTURE_REPOSITORY: &str = "inflatable-cookie/nucleus-fixture";

/// The one repository and native project this instance is authorized to use.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    pub repository: String,
    pub checkout: PathBuf,
    pub base: String,
    pub start: Head,
    pub host_project: String,
    pub worker: RoleProfile,
    pub reviewer: RoleProfile,
    /// The local T3 ACP provider running the Rust session agent.
    #[serde(default)]
    pub acp_provider: Option<String>,
    #[serde(default)]
    pub launch_budget: LaunchBudget,
    #[serde(default)]
    pub agents: Vec<RegisteredAgent>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisteredAgent {
    pub thread: String,
    pub role: RegisteredRole,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegisteredRole {
    Planner,
    Agent,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchBudget {
    pub slots: u32,
    pub max_load: f64,
}

impl Default for LaunchBudget {
    fn default() -> Self {
        let cores = std::thread::available_parallelism().map_or(8, std::num::NonZeroUsize::get);
        Self {
            slots: 1,
            max_load: f64::from(u32::try_from(cores).unwrap_or(u32::MAX)),
        }
    }
}

impl Project {
    pub(crate) fn verify(&self) -> Result<(), ServiceError> {
        if self.repository != FIXTURE_REPOSITORY
            || self.launch_budget.slots == 0
            || !self.launch_budget.max_load.is_finite()
            || self.launch_budget.max_load <= 0.0
            || self.host_project.is_empty()
            || self.acp_provider.as_deref().is_some_and(str::is_empty)
            || !self.checkout.is_absolute()
            || self.checkout.canonicalize()? != self.checkout
            || !self.checkout.is_dir()
        {
            return Err(ServiceError::Project);
        }
        Branches::new(&self.repository, &self.base, "ns-fixture")?;
        let git = Git::new(&GIT_POLICY, Redactor::new([], RedactionRules::common()));
        let identity = git
            .worktree_identity(&self.checkout)
            .map_err(|_| ServiceError::Project)?;
        if identity.root() != self.checkout || identity.branch() != Some(&self.base) {
            return Err(ServiceError::Project);
        }
        for args in [
            &["remote", "get-url", "--all", "origin"][..],
            &["remote", "get-url", "--push", "--all", "origin"][..],
        ] {
            let url = git
                .run(
                    &self.checkout,
                    args,
                    GitFailureCode::CommandUnavailable,
                    Duration::from_secs(5),
                )
                .map_err(|_| ServiceError::Project)?;
            if !fixture_origin(&url) {
                return Err(ServiceError::Project);
            }
        }
        Ok(())
    }

    pub(crate) fn scope(&self, identity: &Identity) -> Result<(), ServiceError> {
        if self.repository != identity.repository
            || self.base != identity.base
            || identity.id.is_empty()
            || identity.id.len() > 64
            || !identity
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(ServiceError::Project);
        }
        Ok(())
    }

    pub(crate) const fn profile(&self, role: Role) -> &RoleProfile {
        match role {
            Role::Worker => &self.worker,
            Role::Reviewer => &self.reviewer,
        }
    }
}

fn fixture_origin(url: &str) -> bool {
    let url = url.strip_suffix(".git").unwrap_or(url);
    url.strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("git@github.com:"))
        == Some(FIXTURE_REPOSITORY)
}

pub(super) fn linked_checkout(project: &Path, path: &Path) -> Result<bool, HostError> {
    if !path.is_absolute() {
        return Ok(false);
    }
    let root = match path.canonicalize() {
        Ok(root) => root,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(HostError::Uncertain),
    };
    if root != path {
        return Ok(false);
    }
    let git = Git::new(&GIT_POLICY, Redactor::new([], RedactionRules::common()));
    let checkout = git
        .worktree_identity(&root)
        .map_err(|_| HostError::Uncertain)?;
    let repository = git
        .worktree_identity(project)
        .map_err(|_| HostError::Uncertain)?;
    Ok(checkout.root() == root
        && repository.root() == project
        && checkout.same_repository(&repository))
}

pub(crate) static GIT_POLICY: LocalGit = LocalGit;

pub(crate) struct LocalGit;

impl GitPolicy for LocalGit {
    fn isolate(&self, command: &mut Command) {
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("LC_ALL", "C")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null");
    }

    fn credential(&self, _remote: &str) -> Result<Option<GitCredential>, GitFailure> {
        Ok(None)
    }

    fn refresh_credential(&self, _rejected: &GitCredential) -> Option<GitCredential> {
        None
    }
}
