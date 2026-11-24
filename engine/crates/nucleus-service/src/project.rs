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
use serde::{Deserialize, Deserializer, Serialize};

use crate::ServiceError;

const FIXTURE_REPOSITORY: &str = "inflatable-cookie/nucleus-fixture";

/// Non-fixture dispatch requires an explicit opt-in in the serve file.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectMode {
    #[default]
    Fixture,
    Project,
}

/// The one repository and native project this instance is authorized to use.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    #[serde(default)]
    pub mode: ProjectMode,
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
    #[serde(default, deserialize_with = "read_launch_budget")]
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
}

impl Default for LaunchBudget {
    fn default() -> Self {
        Self { slots: 1 }
    }
}

fn read_launch_budget<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<LaunchBudget, D::Error> {
    let mut value = serde_json::Value::deserialize(deserializer)?;
    if let Some(fields) = value.as_object_mut() {
        fields.remove("maxLoad");
        fields.remove("max_load");
    }
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}

impl Project {
    pub(crate) fn verify(&self, policy: &LocalGit) -> Result<(), ServiceError> {
        let allowed = match self.mode {
            ProjectMode::Fixture => self.repository == FIXTURE_REPOSITORY,
            ProjectMode::Project => self.acp_provider.is_some(),
        };
        if !allowed
            || self.launch_budget.slots == 0
            || self.host_project.trim().is_empty()
            || self
                .acp_provider
                .as_deref()
                .is_some_and(|provider| provider.trim().is_empty())
            || !self.checkout.is_absolute()
            || self.checkout.canonicalize()? != self.checkout
            || !self.checkout.is_dir()
        {
            return Err(ServiceError::Project);
        }
        Branches::new(&self.repository, &self.base, "ns-binding")?;
        let git = Git::new(policy, Redactor::new([], RedactionRules::common()));
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
            if !matches_origin(&self.repository, &url) {
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

fn matches_origin(repository: &str, url: &str) -> bool {
    let url = url.strip_suffix(".git").unwrap_or(url);
    url.strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .is_some_and(|origin| origin.eq_ignore_ascii_case(repository))
}

pub(super) fn linked_checkout(
    project: &Path,
    path: &Path,
    policy: &LocalGit,
) -> Result<bool, HostError> {
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
    let git = Git::new(policy, Redactor::new([], RedactionRules::common()));
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

#[derive(Clone)]
pub(crate) struct LocalGit(pub(crate) PathBuf);

impl GitPolicy for LocalGit {
    fn isolate(&self, command: &mut Command) {
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("LC_ALL", "C")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .envs(["TMPDIR", "TMP", "TEMP"].map(|name| (name, &self.0)));
    }

    fn credential(&self, _remote: &str) -> Result<Option<GitCredential>, GitFailure> {
        Ok(None)
    }

    fn refresh_credential(&self, _rejected: &GitCredential) -> Option<GitCredential> {
        None
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    use nucleus_core::{Entry, Task};
    use nucleus_forge::GitHub;
    use nucleus_hosts::{Binding, HostError};
    use serde_json::json;

    use super::*;
    use crate::{
        pass::DispatchTarget,
        tests::{fixture, git, native_fixture},
    };

    #[test]
    fn fixture_files_keep_their_scope_and_project_mode_verifies_both_remotes() {
        let (_home, service) = fixture(GitHub::new("unused-fixture").expect("forge"));
        let mut legacy = serde_json::to_value(&service.project).expect("fixture configuration");
        legacy
            .as_object_mut()
            .expect("project object")
            .remove("mode");
        legacy["launchBudget"]["maxLoad"] = json!(18);
        let mut project: Project = serde_json::from_value(legacy).expect("old serve file");
        assert_eq!(project.mode, ProjectMode::Fixture);
        assert_eq!(
            serde_json::to_value(&project.launch_budget).expect("current budget"),
            json!({"slots": 1})
        );
        project
            .verify(&service.git)
            .expect("old fixture is still accepted");

        project.repository = "example/greeter".into();
        git(
            &project.checkout,
            &[
                "remote",
                "set-url",
                "origin",
                "ssh://git@github.com/example/greeter.git",
            ],
        );
        assert!(matches!(
            project.verify(&service.git),
            Err(ServiceError::Project)
        ));

        project.mode = ProjectMode::Project;
        assert!(matches!(
            project.verify(&service.git),
            Err(ServiceError::Project)
        ));
        project.acp_provider = Some("fixture-acp".into());
        project
            .verify(&service.git)
            .expect("explicit repository mode");

        git(
            &project.checkout,
            &[
                "remote",
                "set-url",
                "--push",
                "origin",
                "git@github.com:example/other.git",
            ],
        );
        assert!(matches!(
            project.verify(&service.git),
            Err(ServiceError::Project)
        ));
        git(
            &project.checkout,
            &[
                "remote",
                "set-url",
                "--push",
                "origin",
                "git@github.com:EXAMPLE/greeter.git",
            ],
        );
        project
            .verify(&service.git)
            .expect("both GitHub remotes identify the bound repository");
        git(
            &project.checkout,
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/example/other.git",
            ],
        );
        assert!(matches!(
            project.verify(&service.git),
            Err(ServiceError::Project)
        ));
    }

    #[tokio::test]
    async fn native_write_gate_requires_the_explicit_project_at_its_registered_checkout() {
        let (_home, mut service) = fixture(GitHub::new("unused-fixture").expect("forge"));
        service.project.mode = ProjectMode::Project;
        service.project.repository = "example/greeter".into();
        service.project.host_project = "greeter-project".into();
        service.project.acp_provider = Some("fixture-acp".into());
        let root = service.project.checkout.clone();
        git(
            &root,
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/example/greeter.git",
            ],
        );
        let retargeted = Arc::new(AtomicBool::new(false));
        let moved = Arc::clone(&retargeted);
        let (host, server) = native_fixture(move |request| {
            assert_eq!(request["tag"], "orchestration.subscribeShell");
            let registered = if moved.load(Ordering::Relaxed) { Path::new("/other/checkout") } else { &root };
            json!({"_tag":"Chunk","requestId":request["id"],"values":[
                {"kind":"snapshot","snapshot":{"projects":[{"id":"greeter-project","workspaceRoot":registered}]}},
                {"kind":"synchronized"},
            ]})
        }).await;
        service.host = host;
        let task = Task::new(
            Identity {
                id: "greeter".into(),
                reference: "fixture#1".into(),
                repository: service.project.repository.clone(),
                base: service.project.base.clone(),
                entry: Entry::Brief,
                origin_thread: None,
            },
            "Add a synthetic greeting.".into(),
            None,
        );
        let worktrees = service.worktrees().expect("worktrees");
        let checkout = worktrees
            .checkout(
                &service.project.checkout,
                &service.project.repository,
                &task.identity().id,
            )
            .expect("bound checkout");
        checkout.allocate(&service.project.start).expect("allocate");
        let binding = Binding {
            project_id: service.project.host_project.clone(),
            worktree_path: checkout.path().to_str().expect("checkout path").into(),
            branch: checkout.branch().into(),
        };
        let gate = || {
            service.dispatch_gate(
                &task,
                DispatchTarget::Run {
                    frozen: &binding,
                    checkout: &checkout,
                    launch: false,
                },
            )
        };
        assert_eq!(
            gate().await.expect("verified native destination"),
            Some(false)
        );
        retargeted.store(true, Ordering::Relaxed);
        assert!(matches!(
            gate().await,
            Err(ServiceError::Host(HostError::Binding))
        ));
        server.abort();
    }
}
