use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use longhorn_git_workspace::{Git, GitCredential, GitFailure, GitFailureCode, GitPolicy};
use longhorn_redact::{RedactionRules, Redactor};
use nucleus_core::{Head, Identity, Role};
use nucleus_forge::Branches;
use nucleus_hosts::{Binding, HostError, RoleProfile};
use nucleus_store::{RepositorySettings, StorageError};
use nucleus_work::{Checkout, WorkError};

use crate::{Service, ServiceError, State, volume::Limit};

const FIXTURE_REPOSITORY: &str = "inflatable-cookie/nucleus-fixture";

/// The single-repository fixture configuration that tests build in memory.
#[derive(Clone)]
pub struct Project {
    pub repository: String,
    pub checkout: PathBuf,
    pub base: String,
    pub start: Head,
    pub host_project: String,
    pub worker: RoleProfile,
    pub reviewer: RoleProfile,
    /// The local T3 ACP provider running the Rust session agent.
    pub acp_provider: Option<String>,
    pub launch_budget: LaunchBudget,
}

#[derive(Clone)]
pub struct LaunchBudget {
    pub slots: u32,
}

impl Project {
    pub(crate) fn verify(&self, policy: &LocalGit) -> Result<(), ServiceError> {
        if self.repository != FIXTURE_REPOSITORY
            || self.launch_budget.slots == 0
            || self.host_project.trim().is_empty()
            || self
                .acp_provider
                .as_deref()
                .is_some_and(|provider| provider.trim().is_empty())
        {
            return Err(ServiceError::Project);
        }
        verify_repository(&self.repository, &self.checkout, &self.base, policy)?;
        Ok(())
    }

    pub(crate) fn scope(&self, identity: &Identity) -> Result<(), ServiceError> {
        if self.repository != identity.repository || self.base != identity.base {
            return Err(ServiceError::Project);
        }
        check_task_id(&identity.id)
    }

    pub(crate) const fn profile(&self, role: Role) -> &RoleProfile {
        match role {
            Role::Worker => &self.worker,
            Role::Reviewer => &self.reviewer,
        }
    }
}

#[derive(Clone)]
pub(super) struct ProjectRoute {
    pub(super) project_id: Option<String>,
    pub(super) checkout: PathBuf,
    pub(super) host_project: String,
    pub(super) slots: Option<u32>,
    pub(super) repositories: Vec<String>,
}

impl ProjectRoute {
    pub(super) fn binding(&self, checkout: &Checkout<'_>) -> Result<Binding, ServiceError> {
        if checkout.repository() != self.checkout {
            return Err(HostError::Binding.into());
        }
        self.thread_binding(checkout.path(), checkout.branch())
    }

    pub(super) fn thread_binding(
        &self,
        path: &Path,
        branch: &str,
    ) -> Result<Binding, ServiceError> {
        Ok(Binding {
            project_id: self.host_project.clone(),
            worktree_path: path.to_str().ok_or(ServiceError::Project)?.into(),
            branch: branch.into(),
        })
    }
}

impl Service {
    pub(super) fn acp_provider(&self) -> Option<&str> {
        self.project
            .as_ref()
            .and_then(|project| project.acp_provider.as_deref())
            .or(self.registry_provider.as_deref())
    }

    pub(super) fn task_scope(&self, identity: &Identity) -> Result<(), ServiceError> {
        match &self.project {
            Some(project) => project.scope(identity),
            None => check_task_id(&identity.id),
        }
    }

    pub(super) fn resolve_project(
        &self,
        state: &State,
        identity: &Identity,
    ) -> Result<ProjectRoute, ServiceError> {
        self.task_scope(identity)?;
        if let Some(project) = &self.project {
            return Ok(ProjectRoute {
                project_id: state
                    .settings
                    .fixture_project(project)
                    .map(|(id, _, _)| id.into()),
                checkout: project.checkout.clone(),
                host_project: project.host_project.clone(),
                slots: state.settings.fixture_slots(project),
                repositories: vec![project.repository.clone()],
            });
        }
        let (id, project, repo) = state
            .settings
            .project_for_origin(&identity.repository)
            .filter(|(_, _, repo)| repo.base == identity.base)
            .ok_or(ServiceError::Project)?;
        Ok(ProjectRoute {
            project_id: Some(id.into()),
            checkout: repo.path.clone(),
            host_project: repo.host_project.clone().ok_or(ServiceError::Project)?,
            slots: (!project.archived).then(|| state.settings.project_slots(id)),
            repositories: project
                .repositories
                .iter()
                .map(|repo| repo.origin.clone())
                .collect(),
        })
    }

    pub(super) async fn project_for(
        &self,
        identity: &Identity,
    ) -> Result<ProjectRoute, ServiceError> {
        let state = self.state.lock().await;
        self.resolve_project(&state, identity)
    }

    pub(super) async fn verify_route(
        &self,
        identity: &Identity,
        route: &ProjectRoute,
    ) -> Result<Head, ServiceError> {
        let repository = identity.repository.clone();
        let checkout = route.checkout.clone();
        let base = identity.base.clone();
        let git = self.git.clone();
        let (work, scratch) = (self.storage.work().clone(), self.storage.scratch().clone());
        let verify = move |_| {
            verify_repository(&repository, &checkout, &base, &git).or_else(|refused| {
                // A refusal with the volume or checkout unavailable says nothing
                // about the project.
                work.verify().map_err(WorkError::from)?;
                scratch.verify().map_err(WorkError::from)?;
                if !checkout.is_dir() {
                    return Err(WorkError::from(StorageError::VolumeUnavailable).into());
                }
                Err(refused)
            })
        };
        self.volume
            .run(
                &identity.id,
                "verifying the project checkout",
                Limit::Check,
                verify,
            )
            .await
            .map_err(WorkError::from)?
    }

    pub(super) async fn verify_linked_checkout(
        &self,
        owner: &str,
        project: PathBuf,
        checkout: PathBuf,
    ) -> Result<bool, HostError> {
        let git = self.git.clone();
        self.volume
            .run(
                owner,
                "verifying a linked checkout",
                Limit::Check,
                move |_| linked_checkout(&project, &checkout, &git),
            )
            .await
            .map_err(|_| HostError::Uncertain)?
    }

    pub(super) async fn check_project_route(
        &self,
        identity: &Identity,
        route: &ProjectRoute,
    ) -> Result<(), ServiceError> {
        self.verify_route(identity, route).await?;
        let root = route.checkout.to_str().ok_or(ServiceError::Project)?;
        self.host.check_project(&route.host_project, root).await?;
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn fixture(&self) -> &Project {
        self.project.as_ref().expect("fixture project")
    }

    #[cfg(test)]
    pub(super) fn fixture_mut(&mut self) -> &mut Project {
        self.project.as_mut().expect("fixture project")
    }

    #[cfg(test)]
    pub(super) async fn check_project(&self) -> Result<(), ServiceError> {
        let project = self.fixture();
        let identity = Identity {
            id: "fixture-binding".into(),
            reference: String::new(),
            repository: project.repository.clone(),
            base: project.base.clone(),
            entry: nucleus_core::Entry::Brief,
            origin_thread: None,
        };
        let route = self.project_for(&identity).await?;
        self.check_project_route(&identity, &route).await
    }
}

pub(super) fn check_task_id(id: &str) -> Result<(), ServiceError> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(ServiceError::Project);
    }
    Ok(())
}

pub(super) fn verify_repository(
    repository: &str,
    checkout: &Path,
    base: &str,
    policy: &LocalGit,
) -> Result<Head, ServiceError> {
    if !checkout.is_absolute() || checkout.canonicalize()? != checkout || !checkout.is_dir() {
        return Err(ServiceError::Project);
    }
    Branches::new(repository, base, "ns-binding")?;
    let git = Git::new(policy, Redactor::new([], RedactionRules::common()));
    let identity = git
        .worktree_identity(checkout)
        .map_err(|_| ServiceError::Project)?;
    if identity.root() != checkout || identity.branch() != Some(base) {
        return Err(ServiceError::Project);
    }
    for args in [
        &["remote", "get-url", "--all", "origin"][..],
        &["remote", "get-url", "--push", "--all", "origin"][..],
    ] {
        let url = git
            .run(
                checkout,
                args,
                GitFailureCode::CommandUnavailable,
                Duration::from_secs(5),
            )
            .map_err(|_| ServiceError::Project)?;
        if !matches_origin(repository, &url) {
            return Err(ServiceError::Project);
        }
    }
    identity
        .head_oid()
        .parse()
        .map_err(|_| ServiceError::Project)
}

fn matches_origin(repository: &str, url: &str) -> bool {
    github_origin(url).is_some_and(|origin| origin.eq_ignore_ascii_case(repository))
}

fn github_origin(url: &str) -> Option<&str> {
    let url = url.strip_suffix(".git").unwrap_or(url);
    url.strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
}

pub(super) fn discover_repository(
    path: PathBuf,
    policy: &LocalGit,
) -> Result<RepositorySettings, ServiceError> {
    let refused = ServiceError::PlannerEnrollmentRefused;
    if !path.is_absolute() || !path.canonicalize().is_ok_and(|root| root == path) || !path.is_dir()
    {
        return Err(refused(
            "The checkout registered in T3 is missing or is not a canonical directory.",
        ));
    }
    let git = Git::new(policy, Redactor::new([], RedactionRules::common()));
    let read = |args: &[&str], reason| {
        git.run(
            &path,
            args,
            GitFailureCode::CommandUnavailable,
            Duration::from_secs(5),
        )
        .map_err(|_| refused(reason))
    };
    let identity = git
        .worktree_identity(&path)
        .map_err(|_| refused("The checkout registered in T3 is not a Git worktree."))?;
    if identity.root() != path {
        return Err(refused("T3 must register the exact Git checkout root."));
    }
    let fetch_failure = "The T3 checkout needs one GitHub fetch URL for origin.";
    let fetch = read(&["remote", "get-url", "--all", "origin"], fetch_failure)?;
    let origin = github_origin(&fetch)
        .ok_or_else(|| refused(fetch_failure))?
        .to_ascii_lowercase();
    let push_failure = "The origin fetch and push URLs must identify the same GitHub repository.";
    let push = read(
        &["remote", "get-url", "--push", "--all", "origin"],
        push_failure,
    )?;
    if !matches_origin(&origin, &push) {
        return Err(refused(push_failure));
    }
    let default_failure = "The checkout needs a local origin/HEAD for the default branch.";
    let default = read(
        &["symbolic-ref", "refs/remotes/origin/HEAD"],
        default_failure,
    )?;
    let base = default
        .strip_prefix("refs/remotes/origin/")
        .ok_or_else(|| refused(default_failure))?;
    if identity.branch() != Some(base) {
        return Err(refused(
            "The T3 checkout must be on the repository's default branch.",
        ));
    }
    Branches::new(&origin, base, "ns-binding").map_err(|_| refused(fetch_failure))?;
    Ok(RepositorySettings {
        origin,
        path,
        base: base.into(),
        host_project: None,
        host_project_title: None,
        planner_threads: Vec::new(),
    })
}

fn linked_checkout(project: &Path, path: &Path, policy: &LocalGit) -> Result<bool, HostError> {
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

#[cfg(test)]
pub(crate) mod git_gate {
    use std::{
        collections::BTreeMap,
        path::PathBuf,
        sync::{
            Arc, Condvar, Mutex, OnceLock,
            atomic::{AtomicUsize, Ordering},
        },
    };

    #[derive(Default)]
    pub struct Gate {
        pub entered: AtomicUsize,
        /// Hold only this many calls. Zero holds every call until release.
        pub holds: AtomicUsize,
        /// Count and hold only Git commands with this argument.
        pub only: OnceLock<&'static str>,
        released: Mutex<bool>,
        ready: Condvar,
    }

    impl Gate {
        pub fn release(&self) {
            *self.released.lock().unwrap() = true;
            self.ready.notify_all();
        }
    }

    fn gates() -> &'static Mutex<BTreeMap<PathBuf, Arc<Gate>>> {
        static GATES: OnceLock<Mutex<BTreeMap<PathBuf, Arc<Gate>>>> = OnceLock::new();
        GATES.get_or_init(|| Mutex::new(BTreeMap::new()))
    }

    pub fn install(path: PathBuf) -> Arc<Gate> {
        let gate = Arc::new(Gate::default());
        gates().lock().unwrap().insert(path, Arc::clone(&gate));
        gate
    }

    pub fn enter(path: &PathBuf, command: &std::process::Command) {
        let gate = gates().lock().unwrap().get(path).cloned();
        if let Some(gate) = gate.filter(|gate| {
            gate.only
                .get()
                .is_none_or(|only| command.get_args().any(|argument| argument == *only))
        }) {
            let earlier = gate.entered.fetch_add(1, Ordering::SeqCst);
            let holds = gate.holds.load(Ordering::SeqCst);
            if holds != 0 && earlier >= holds {
                return;
            }
            let released = gate.released.lock().unwrap();
            drop(
                gate.ready
                    .wait_while(released, |released| !*released)
                    .unwrap(),
            );
        }
    }
}

impl GitPolicy for LocalGit {
    fn isolate(&self, command: &mut Command) {
        #[cfg(test)]
        git_gate::enter(&self.0, command);
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
    fn fixture_scope_and_both_remotes_must_name_the_repository() {
        let (_home, service) = fixture(GitHub::new("unused-fixture").expect("forge"));
        let mut project = service.fixture().clone();
        project.verify(&service.git).expect("fixture repository");

        // A Project serves only the fixture repository. The remote checks run on the
        // same repository verification that the registry route uses.
        project.repository = "example/greeter".into();
        assert!(matches!(
            project.verify(&service.git),
            Err(ServiceError::Project)
        ));
        let (checkout, base) = (project.checkout.clone(), project.base.clone());
        let check = |git_policy: &LocalGit| {
            verify_repository("example/greeter", &checkout, &base, git_policy)
        };
        git(
            &checkout,
            &[
                "remote",
                "set-url",
                "origin",
                "ssh://git@github.com/example/greeter.git",
            ],
        );
        check(&service.git).expect("origin names the repository");

        git(
            &checkout,
            &[
                "remote",
                "set-url",
                "--push",
                "origin",
                "git@github.com:example/other.git",
            ],
        );
        assert!(matches!(check(&service.git), Err(ServiceError::Project)));
        git(
            &checkout,
            &[
                "remote",
                "set-url",
                "--push",
                "origin",
                "git@github.com:EXAMPLE/greeter.git",
            ],
        );
        check(&service.git).expect("both GitHub remotes identify the bound repository");
        git(
            &checkout,
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/example/other.git",
            ],
        );
        assert!(matches!(check(&service.git), Err(ServiceError::Project)));
    }

    #[tokio::test]
    async fn native_write_gate_requires_the_explicit_project_at_its_registered_checkout() {
        let (_home, mut service) = fixture(GitHub::new("unused-fixture").expect("forge"));
        service.fixture_mut().repository = "example/greeter".into();
        service.fixture_mut().host_project = "greeter-project".into();
        service.fixture_mut().acp_provider = Some("fixture-acp".into());
        let root = service.fixture().checkout.clone();
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
                repository: service.fixture().repository.clone(),
                base: service.fixture().base.clone(),
                entry: Entry::Brief,
                origin_thread: None,
            },
            "Add a synthetic greeting.".into(),
            None,
        );
        let worktrees = service.worktrees();
        let checkout = worktrees
            .checkout(
                &service.fixture().checkout,
                &service.fixture().repository,
                &task.identity().id,
            )
            .expect("bound checkout");
        checkout
            .allocate(&service.fixture().start)
            .expect("allocate");
        let binding = Binding {
            project_id: service.fixture().host_project.clone(),
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
        assert!(gate().await.expect("verified native destination").is_some());
        retargeted.store(true, Ordering::Relaxed);
        assert!(matches!(
            gate().await,
            Err(ServiceError::Host(HostError::Binding))
        ));
        server.abort();
    }
}
