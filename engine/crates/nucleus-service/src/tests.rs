use std::{
    collections::BTreeMap,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command as Process,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use axum::{
    Json, Router,
    extract::ws::{Message, WebSocketUpgrade},
    routing::{get, post},
};
use nucleus_core::{
    AuthorDeclaration, CallbackCredential, CheckState, Entry, Forge, Head, Host, LaunchInputs,
    Observation, Observed, PullRequest, Role, Run, Workspace,
};
use nucleus_hosts::{
    Binding, ControlDispatch, ReplayAuthorization, RunDispatch, RunObservation, SendOutcome,
    StopProgress, TaskHost,
};
use nucleus_store::{
    AllowanceObservation, Profiles, ProjectSettings, Projects, RepositorySettings, Store,
    StoreError,
};
use serde_json::{Value, json};
use tokio::net::TcpListener;

use super::*;

pub(super) const REPOSITORY: &str = "inflatable-cookie/nucleus-fixture";
pub(super) const REGISTERED_PROJECT: &str = "fixture-product";
const HOST_PROJECT: &str = "local-fixture";
const PR: &str = "https://github.com/inflatable-cookie/nucleus-fixture/pull/1";

pub(super) fn author_declaration() -> AuthorDeclaration {
    AuthorDeclaration {
        models: vec!["fixture/FIRST".into()],
        github_author: "fixture-author".into(),
        authoring_system: "fixture".into(),
        attested_by: "operator".into(),
        provenance: "Verified the fixture's authoring records.".into(),
    }
}

/// Seed a task change through the production save, charging no allowance time.
pub(super) fn save_row(
    store: &mut Store,
    expected: &TaskRow,
    task: &Task,
    event: &EventDraft,
) -> Result<i64, StoreError> {
    let idle = AllowanceObservation {
        elapsed_ms: 0,
        charging: false,
        extension: None,
    };
    store.save_accounted(expected, task, event, None, idle, false)
}

/// The production registry over one checkout: Projects settings register it, and
/// the T3 shell reports its project, so the scheduler runs the registry branches.
pub(super) fn registry_fixture(forge: GitHub) -> (tempfile::TempDir, Service) {
    let home = tempfile::tempdir().expect("fixture volume directory");
    let root = home.path().canonicalize().expect("portable root");
    let checkout = fixture_checkout(&root);
    let settings = SettingsFile::open(&root).expect("portable settings");
    settings
        .configure(&settings.read().expect("fixture settings"), |current| {
            current.enabled = true;
        })
        .expect("enable fixture");
    let revision = settings
        .read::<Projects>()
        .expect("project settings")
        .revision;
    settings
        .edit(&revision, |projects: &mut Projects| {
            projects.projects = BTreeMap::from([(
                REGISTERED_PROJECT.into(),
                ProjectSettings {
                    planner_claim: None,
                    claimed_planner_threads: Vec::new(),
                    name: "Fixture".into(),
                    archived: false,
                    repositories: vec![RepositorySettings {
                        origin: REPOSITORY.into(),
                        path: checkout.clone(),
                        base: "main".into(),
                        host_project: Some(HOST_PROJECT.into()),
                        host_project_title: Some("Fixture".into()),
                        planner_threads: Vec::new(),
                    }],
                },
            )]);
            Ok(())
        })
        .expect("register fixture project");
    // The registry launches from named profiles; this one is the fixture's
    // single role profile.
    let revision = settings
        .read::<Profiles>()
        .expect("profile settings")
        .revision;
    settings
        .edit(&revision, |value: &mut Profiles| {
            *value = serde_json::from_value(json!({"profiles": [{
                "name": "Fixture",
                "providerInstanceId": "provider",
                "selection": {"id": "fixture", "provider": "codex", "model": "fixture"}
            }]}))
            .expect("fixture profile");
            Ok(())
        })
        .expect("register fixture profile");
    let host = T3::new("http://127.0.0.1:9", "unused-fixture-key")
        .expect("no native host for the service fixture");
    host.fixture_project_shell(
        &json!({
            "projects": [{"id": HOST_PROJECT, "workspaceRoot": checkout, "title": "Fixture"}],
            "threads": []
        }),
        "fixture-acp",
    );
    let service = Service::open_projects(
        settings.lock_profile().expect("fixture profile"),
        "fixture-acp".into(),
        host,
        forge,
        "127.0.0.1:9".parse().expect("callback"),
        std::env::current_exe().expect("test binary"),
    )
    .expect("registry service");
    (home, service)
}

pub(super) fn clear_fixture_projects(settings: &SettingsFile) {
    let revision = settings.read::<Projects>().unwrap().revision;
    settings
        .edit(&revision, |projects: &mut Projects| {
            *projects = Projects::default();
            Ok(())
        })
        .unwrap();
}

/// A repository whose origin is the fixture repository, with one base commit.
fn fixture_checkout(root: &Path) -> PathBuf {
    let checkout = root.join("repo");
    std::fs::create_dir(&checkout).expect("project");
    git(&checkout, &["init", "-b", "main"]);
    create_fixture_commit(&checkout, "fixture");
    git(
        &checkout,
        &[
            "remote",
            "add",
            "origin",
            &format!("git@github.com:{REPOSITORY}.git"),
        ],
    );
    let remote = root.join("remote.git");
    git(
        root,
        &[
            "clone",
            "--bare",
            checkout.to_str().unwrap(),
            remote.to_str().unwrap(),
        ],
    );
    let ssh = root.join("fixture-ssh");
    std::fs::write(
        &ssh,
        format!(
            "#!/bin/sh\ncase \"$2\" in\n  \"git-upload-pack '{REPOSITORY}.git'\") exec git-upload-pack \"$(dirname \"$0\")/remote.git\" ;;\n  \"git-receive-pack '{REPOSITORY}.git'\") exec git-receive-pack \"$(dirname \"$0\")/remote.git\" ;;\n  *) exit 1 ;;\nesac\n"
        ),
    )
    .unwrap();
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o700)).unwrap();
    let ssh_command = format!("'{}'", ssh.to_str().unwrap().replace('\'', "'\\''"));
    git(&checkout, &["config", "core.sshCommand", &ssh_command]);
    git(&checkout, &["config", "ssh.variant", "simple"]);
    git(
        &checkout,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
        ],
    );
    checkout
}

pub(super) fn fixture(forge: GitHub) -> (tempfile::TempDir, Service) {
    registry_fixture(forge)
}

pub(super) fn create_fixture_commit(repository: &Path, message: &str) {
    git(
        repository,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            message,
        ],
    );
}

pub(super) fn git(root: &Path, args: &[&str]) -> String {
    let output = Process::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .expect("run fixture git");
    assert!(
        output.status.success(),
        "fixture Git: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("fixture Git output")
        .trim_end()
        .into()
}

pub(super) fn reservation(
    id: &str,
    entry: Entry,
    head: &Head,
) -> (Task, CallbackCredential, Observation) {
    reservation_at(id, entry, head, 1)
}

pub(super) fn reservation_at(
    id: &str,
    entry: Entry,
    head: &Head,
    started_at: u64,
) -> (Task, CallbackCredential, Observation) {
    let pr = PullRequest {
        url: PR.into(),
        head: head.clone(),
    };
    let mut task = Task::new(
        Identity {
            id: id.into(),
            reference: id.into(),
            repository: REPOSITORY.into(),
            base: "main".into(),
            entry,
            origin_thread: None,
        },
        "---\ncomplexity: normal\nqueue:\n  notifyOriginOnCloseout: false\n---\n\nFixture introduction.\n\n# Synthetic change\n\nFixture details.".into(),
        (entry == Entry::ReviewEntry).then(|| pr.clone()),
    );
    let observation = Observation {
        forge: if entry == Entry::ReviewEntry {
            Observed::Known(Forge::Open {
                pr,
                checks: CheckState::Ready,
            })
        } else {
            Observed::Known(Forge::Absent)
        },
        host: Observed::Unknown,
        workspace: Observed::Known(Workspace::Clean(head.clone())),
    };
    let _ = task.reconcile(&observation);
    let credential = task
        .reserve_grouped_launch(
            &observation,
            LaunchInputs {
                scratch: None,
                thread: format!("thread:{id}"),
                started_at,
                input: "fixture-only wire".into(),
            },
            &[3; 32],
            None,
            "fixture-group".into(),
        )
        .expect("reserve exact callback run");
    (task, credential, observation)
}

pub(super) fn reserved_reviewer(id: &str, head: &Head) -> (Task, CallbackCredential, Observation) {
    reserved_reviewer_with(id, head, |_| LaunchInputs {
        scratch: None,
        thread: "thread:reviewer".into(),
        started_at: 2,
        input: "fixture review".into(),
    })
}

pub(super) fn reserved_reviewer_with(
    id: &str,
    head: &Head,
    inputs: impl FnOnce(&Task) -> LaunchInputs,
) -> (Task, CallbackCredential, Observation) {
    let (mut task, credential, mut observation) = reservation(id, Entry::Brief, head);
    let pr = PullRequest {
        url: PR.into(),
        head: head.clone(),
    };
    let instance = task.run().expect("worker").launch().instance.clone();
    task.record_report(
        &instance,
        credential.as_bytes(),
        Report::Work(pr.clone().into()),
    )
    .unwrap();
    observation.forge = Observed::Known(Forge::Open {
        pr,
        checks: CheckState::Ready,
    });
    observation.host = Observed::Known(Host::Current {
        instance,
        state: nucleus_core::RunState::Ended,
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Reviewing)
    );
    let launch = inputs(&task);
    let credential = task
        .reserve_grouped_launch(&observation, launch, &[4; 32], None, "fixture-group".into())
        .unwrap();
    (task, credential, observation)
}

pub(super) fn code_task_at_merge(id: &str, head: &Head) -> (Task, Observation) {
    let (mut task, credential, mut observation) = reserved_reviewer(id, head);
    let instance = task.run().expect("reviewer").launch().instance.clone();
    task.record_report(
        &instance,
        credential.as_bytes(),
        Report::Review {
            head: head.clone(),
            decision: nucleus_core::Review::Approve,
            summary: "Approved the original head".into(),
            finding_titles: Vec::new(),
        },
    )
    .unwrap();
    observation.host = Observed::Known(Host::Current {
        instance,
        state: nucleus_core::RunState::Ended,
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Merging)
    );
    (task, observation)
}

pub(super) async fn forge_fixture(
    head: &Head,
) -> (GitHub, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    forge_fixture_for_branch(head, "ns-reviewer").await
}

pub(super) async fn forge_fixture_for_branch(
    head: &Head,
    branch: &str,
) -> (GitHub, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let reads = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&reads);
    let mut pull = forge_pull(head);
    pull["head"]["ref"] = Value::from(branch);
    let checks = forge_checks(head);
    let server = Router::new()
        .route(
            &format!("/repos/{REPOSITORY}/pulls/1"),
            get(move || async move {
                counter.fetch_add(1, Ordering::Relaxed);
                Json(pull)
            }),
        )
        .route("/graphql", post(move || async move { Json(checks) }));
    let (client, server) = serve_forge(server).await;
    (client, reads, server)
}

pub(super) fn forge_pull(head: &Head) -> Value {
    json!({
        "number":1, "html_url":PR, "merged":false, "state":"open", "merge_commit_sha":null, "user":{"id":11,"login":"fixture-author"},
        "head":{"ref":"ns-reviewer", "sha":head, "repo":{"full_name":REPOSITORY}},
        "base":{"ref":"main", "sha":head, "repo":{"full_name":REPOSITORY}},
    })
}

pub(super) fn forge_checks(head: &Head) -> Value {
    json!({"data":{"repository":{"pullRequest":{
        "headRefOid":head, "baseRefName":"main", "baseRefOid":head, "isDraft":false, "state":"OPEN",
        "mergeable":"MERGEABLE", "mergeStateStatus":"CLEAN", "reviewDecision":null,
        "statusCheckRollup":{"state":"SUCCESS","contexts":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}},
    }}}})
}

pub(super) async fn serve_forge(app: Router) -> (GitHub, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("fixture endpoint");
    let client = GitHub::loopback_fixture(listener.local_addr().expect("local address"))
        .expect("fixture forge");
    let server = tokio::spawn(async {
        axum::serve(listener, app)
            .await
            .expect("fixture forge server");
    });
    (client, server)
}

pub(super) struct Due(
    pub(super) AtomicUsize,
    pub(super) Option<nucleus_core::RunState>,
);

#[test]
fn report_reminder_continues_ordinary_work_and_preserves_the_review_verdict() {
    let head = "a".repeat(40).parse().unwrap();
    for (entry, continuation) in [(Entry::Brief, true), (Entry::ReviewEntry, false)] {
        let (task, _, _) = reservation("fixture", entry, &head);
        let reminder = crate::prompt::report_reminder(
            &task,
            task.run().unwrap(),
            Path::new("nucleus"),
            Path::new("ticket"),
        );
        assert_eq!(
            reminder
                .text
                .contains("Continue the assignment in this checkout"),
            continuation
        );
        assert_eq!(
            reminder
                .text
                .contains("review you actually performed at exact head"),
            !continuation
        );
    }
}

#[tokio::test]
async fn a_held_review_waits_and_a_late_report_wins_the_reminder_reservation() {
    let head: Head = "a".repeat(40).parse().unwrap();
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let source = {
        let (entered, release) = (Arc::clone(&entered), Arc::clone(&release));
        let pull = forge_pull(&head);
        let checks = forge_checks(&head);
        Router::new()
            .route(
                &format!("/repos/{REPOSITORY}/pulls/1"),
                get(move || async move {
                    entered.notify_one();
                    release.notified().await;
                    Json(pull)
                }),
            )
            .route("/graphql", post(move || async move { Json(checks) }))
    };
    let (forge, server) = serve_forge(source).await;
    let (_home, service) = fixture(forge);
    let id = "reviewer";
    let (mut task, credential, _) = reservation(id, Entry::ReviewEntry, &head);
    let instance = task.run().unwrap().launch().instance.clone();
    task.record_send(&instance, 2).unwrap();
    service
        .state
        .lock()
        .await
        .store
        .create_with_facts(
            &task,
            &event("fixture"),
            nucleus_store::TaskAdmissionFacts::default(),
        )
        .unwrap();
    let owner = Authority::Operator {
        actor: "fixture".into(),
    };
    let ended = Due(AtomicUsize::new(0), Some(nucleus_core::RunState::Ended));
    let held_row = service
        .command(id, &owner, Command::Hold("Check the review first".into()))
        .await
        .unwrap();
    assert_eq!(held_row.task.brief(), task.brief());
    assert_eq!(held_row.task.pull_request(), task.pull_request());
    assert_eq!(held_row.task.run(), task.run());
    assert_eq!(
        service.advance(&held_row, &ended).await.unwrap(),
        Action::Wait(WaitReason::Hold)
    );
    let released = service.command(id, &owner, Command::Release).await.unwrap();

    let report = Report::Review {
        head,
        decision: nucleus_core::Review::Changes,
        summary: "Original reviewer recovered the findings".into(),
        finding_titles: Vec::new(),
    };
    let (result, ()) = tokio::join!(service.advance(&released, &ended), async {
        tokio::time::timeout(Duration::from_secs(10), entered.notified())
            .await
            .expect("terminal observation reached the forge before reserving");
        let accepted = service
            .report(id, &instance, credential.as_bytes(), report.clone())
            .await;
        release.notify_one();
        accepted.expect("late original report authenticates");
    });
    assert!(matches!(
        result,
        Err(ServiceError::Store(StoreError::StaleTask))
    ));
    let current = service.task(id).await.unwrap();
    assert_eq!(current.version, released.version + 1);
    let run = current.task.run().unwrap();
    assert_eq!(run.launch().instance, instance);
    assert_eq!(run.report(), Some(&report));
    assert!(run.report_reminder_for().is_none());
    assert_eq!(ended.0.load(Ordering::Relaxed), 0);
    server.abort();
}

impl TaskHost for Due {
    async fn terminal_orphans(
        &self,
        _: &Path,
        _: &Path,
    ) -> Result<nucleus_hosts::OrphanScan, HostError> {
        unreachable!()
    }

    async fn terminal_helpers(
        &self,
        _: &[std::path::PathBuf],
        _: &Path,
    ) -> Result<Vec<nucleus_hosts::OrphanProcess>, HostError> {
        unreachable!("no retirement in the replay fixture")
    }

    async fn profile_catalog(&self) -> Result<&nucleus_hosts::ProfileCatalog, HostError> {
        unreachable!("only revoked runs are exercised")
    }

    fn prepare_launch(
        &self,
        _: nucleus_hosts::LaunchRequest<'_>,
    ) -> Result<LaunchInputs, HostError> {
        unreachable!("no new reservation in the replay fixture")
    }

    async fn observe_retained_role(&self, _: &Binding, _: &str) -> Result<Host, HostError> {
        unreachable!("only replay gate is exercised")
    }
    async fn observe_run(&self, run: &Run, _: u64) -> Result<RunObservation, HostError> {
        Ok(RunObservation {
            host: Host::Current {
                instance: run.launch().instance.clone(),
                state: self.1.ok_or(HostError::Uncertain)?,
            },
            activity: None,
            provider_limit: None,
            routing: None,
        })
    }

    async fn authorize_send(&self, _: &Run) -> Result<ReplayAuthorization, HostError> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Err(HostError::Uncertain)
    }

    async fn send(
        &self,
        _: RunDispatch,
        _: impl FnMut(nucleus_hosts::SnoozeUpdate) -> Result<(), HostError> + Send,
    ) -> Result<SendOutcome, HostError> {
        unreachable!("fixture probes the decision before the send marker")
    }

    async fn write_control(&self, _: ControlDispatch) -> Result<(), HostError> {
        unreachable!("fixture probes the decision before any native write")
    }

    async fn stop(&self, _: &Run, _: &Binding, _: u64, _: bool) -> Result<StopProgress, HostError> {
        Ok(StopProgress::ReplayDue)
    }
}

#[tokio::test]
async fn a_move_during_the_forge_read_prevents_stale_launch() {
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let source = {
        let (entered, release) = (Arc::clone(&entered), Arc::clone(&release));
        Router::new().route(
            &format!("/repos/{REPOSITORY}/pulls"),
            get(move || async move {
                entered.notify_one();
                release.notified().await;
                Json(Vec::<Value>::new())
            }),
        )
    };
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("fixture forge");
    let forge =
        GitHub::loopback_fixture(listener.local_addr().expect("forge address")).expect("client");
    let server = tokio::spawn(async move {
        axum::serve(listener, source).await.expect("server");
    });
    let (_home, service) = fixture(forge);
    let id = "stale-read";
    let mut task = Task::new(
        Identity {
            id: id.into(),
            reference: id.into(),
            repository: REPOSITORY.into(),
            base: "main".into(),
            entry: Entry::Brief,
            origin_thread: None,
        },
        "Synthetic task".into(),
        None,
    );
    let observation = Observation {
        host: Observed::Unknown,
        forge: Observed::Unknown,
        workspace: Observed::Unknown,
    };
    let _ = task.reconcile(&observation);
    service
        .state
        .lock()
        .await
        .store
        .create_with_facts(
            &task,
            &event("fixture"),
            nucleus_store::TaskAdmissionFacts::default(),
        )
        .expect("seed");
    let stale = service.task(id).await.expect("old version");
    let (result, moved) = tokio::join!(service.pass(), async {
        entered.notified().await;
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            service.command(
                id,
                &Authority::Operator {
                    actor: "fixture".into(),
                },
                Command::Move(nucleus_core::Phase::Queued),
            ),
        )
        .await;
        release.notify_one();
        outcome
            .expect("the command is independent of the pending read")
            .expect("move")
    },);
    let results = result.expect("pass outcome");
    assert!(matches!(
        results.as_slice(),
        [PassOutcome { task, result: Err(ServiceError::Store(StoreError::StaleTask)) }] if task == id
    ));

    assert_eq!(moved.version, stale.version + 1);
    assert_eq!(service.task(id).await.expect("current row"), moved);
    assert_eq!(
        service
            .state
            .lock()
            .await
            .schedule
            .take_ready(Instant::now(), &BTreeSet::new(), None)
            .map(|task| task.id),
        Some(id.into())
    );
    let worktrees = service.worktrees();
    let checkout = worktrees
        .checkout(&service.fixture().checkout, REPOSITORY, id)
        .expect("checkout");
    assert_eq!(
        checkout.observe().expect("worktree state"),
        Workspace::Absent
    );
    server.abort();
}

#[tokio::test]
async fn a_cold_pass_consumes_an_authenticated_report_despite_an_old_custody_block() {
    for question in [false, true] {
        let (_home, mut service) = fixture(GitHub::new("fixture").unwrap());
        let head = service.fixture().start.clone();
        let (forge, _, server) = forge_fixture_for_branch(&head, "ns-worker").await;
        service.forge = forge;
        let worktrees = service.worktrees();
        let checkout = worktrees
            .checkout(&service.fixture().checkout, REPOSITORY, "worker")
            .unwrap();
        checkout.allocate(&head).unwrap();
        let admin =
            std::path::PathBuf::from(git(checkout.path(), &["rev-parse", "--absolute-git-dir"]));
        std::fs::write(admin.join("index"), b"unreadable checkout").unwrap();
        assert!(checkout.observe().is_err());
        let (mut task, credential, _) = reservation("worker", Entry::Brief, &head);
        let instance = task.run().unwrap().launch().instance.clone();
        task.record_send(&instance, 1).unwrap();
        let report = if question {
            nucleus_core::Report::Question {
                prompt: "Choose the scope".into(),
                options: vec!["Small".into(), "Large".into()],
            }
        } else {
            nucleus_core::Report::Work(
                PullRequest {
                    url: PR.into(),
                    head,
                }
                .into(),
            )
        };
        task.record_report(&instance, credential.as_bytes(), report)
            .unwrap();
        {
            let mut state = service.state.lock().await;
            let version = state
                .store
                .create_with_facts(
                    &task,
                    &event("fixture"),
                    nucleus_store::TaskAdmissionFacts::default(),
                )
                .unwrap();
            let mut blocked = event("host_observation_blocked");
            blocked.detail = serde_json::json!({
                "version": version, "deliveryPending": false,
                "reason": "Retained thread lacks idle coverage",
                "session": format!("{}/previous-engine", service.host.runtime_identity().unwrap()),
            })
            .to_string();
            state
                .store
                .claim_task_effect("worker", &blocked, false)
                .unwrap();
        }
        let initial = service.task("worker").await.unwrap();
        let outcomes = service.pass().await.unwrap();
        let [outcome] = outcomes.try_into().ok().expect("one scheduled task");
        let result = outcome.result.unwrap();
        let next = service.task("worker").await.unwrap();
        assert_eq!(next.version, initial.version + 1);
        assert!(service.state.lock().await.last_pass_calls.is_empty());
        assert_eq!(
            next.task.threads().get(nucleus_core::Role::Worker),
            Some("thread:worker")
        );
        if question {
            assert!(matches!(
                result,
                Action::Ask(nucleus_core::Question::Work { .. })
            ));
            assert!(matches!(
                next.task.question(),
                Some(nucleus_core::Question::Work { .. })
            ));
        } else {
            assert_eq!(result, Action::Advance(Phase::Reviewing));
            assert_eq!(next.task.phase(), Phase::Reviewing);
        }
        assert!(next.task.run().is_none());
        assert_eq!(
            std::fs::read(admin.join("index")).unwrap(),
            b"unreadable checkout"
        );
        server.abort();
    }
}

#[tokio::test]
async fn proven_unsent_preflights_replan_without_fencing_the_task_version() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    let row = {
        let (task, _, _) = reservation("unsent", Entry::Brief, &service.fixture().start);
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        let row = service.lookup(&state, "unsent").unwrap();
        state.set_wait("unsent", Some(WaitReason::HostObservationBlocked));
        row
    };
    let refused = Err(service.parent_not_sent("preflight custody revision no longer matches"));
    let before_role_send = Err(ServiceError::Host(HostError::Uncertain));
    for result in [&refused, &before_role_send, &before_role_send] {
        service
            .schedule_result(&row, result, Priority::Decision)
            .await
            .unwrap();
        let mut state = service.state.lock().await;
        let due = state.schedule.due("unsent").unwrap();
        let scheduled = state
            .schedule
            .take_ready(due, &BTreeSet::new(), None)
            .unwrap();
        assert_eq!(scheduled.id, "unsent");
        assert_eq!(
            service.lookup(&state, "unsent").unwrap().version,
            row.version
        );
        assert_eq!(state.wait_reason("unsent"), Some(WaitReason::HostUnknown));
        assert!(matches!(
            state.wait_detail("unsent"),
            Some(crate::WaitDetail::BeforeSend(_))
        ));
        assert_eq!(service.acp_turn_view(&state, &row).unwrap(), (None, false));
        assert_eq!(
            state.task_attention(&row).unwrap(),
            crate::attention::TaskAttention::Waiting
        );
    }
    {
        let mut state = service.state.lock().await;
        // Distinct from this pass even if two writes share one wall-clock millisecond.
        state.store.record_board_entry("unsent", 123).unwrap();
        let board_times = state.store.board_times("unsent").unwrap();
        assert_eq!(board_times.since, Some(123));
        let since = state.waits["unsent"].since;
        assert!(
            state
                .observe_wait_detail(
                    &row.task,
                    Some(WaitReason::HostUnknown),
                    Some(crate::WaitDetail::BeforeSend(Some("Checking T3"))),
                )
                .unwrap()
        );
        assert_eq!(state.store.board_times("unsent").unwrap(), board_times);
        assert_eq!(state.waits["unsent"].since, since);
    }
    assert!(
        !service
            .history("unsent", None, 100)
            .await
            .unwrap()
            .iter()
            .any(|event| event.content.kind == "host_observation_blocked")
    );
}

#[tokio::test]
async fn a_generic_runless_check_cannot_replace_a_proven_refusal_with_a_fence() {
    let (_home, service) = fixture(GitHub::new("fixture").unwrap());
    let (reserved, _, _) = reservation("runless", Entry::Brief, &service.fixture().start);
    let task = Task::new(reserved.identity().clone(), "Fixture".into(), None);
    let row = {
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        service.lookup(&state, "runless").unwrap()
    };
    let refusal = Err(service.parent_not_sent("parent proof changed"));
    let unknown = Err(ServiceError::Host(HostError::Uncertain));
    let process = Err(ServiceError::Host(HostError::ProcessCoverage(
        nucleus_hosts::ProcessEvidenceFailure::Cwd { pid: 41 },
    )));
    for result in [&refusal, &unknown, &unknown, &process, &process] {
        service
            .schedule_result(&row, result, Priority::Decision)
            .await
            .unwrap();
        let mut state = service.state.lock().await;
        let due = state.schedule.due("runless").expect("still eligible");
        assert_eq!(
            state
                .schedule
                .take_ready(due, &BTreeSet::new(), None)
                .unwrap()
                .id,
            "runless"
        );
        assert_eq!(
            service.lookup(&state, "runless").unwrap().version,
            row.version
        );
    }
    let observations: Vec<_> = service
        .history("runless", None, 20)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.content.kind == "host_observation_incomplete")
        .collect();
    assert_eq!(observations.len(), 1);
    let detail: serde_json::Value = serde_json::from_str(&observations[0].content.detail).unwrap();
    assert_eq!(detail["stage"], "cwd_followup");
    assert_eq!(detail["pid"], 41);
    let state = service.state.lock().await;
    assert!(matches!(
        state.wait_detail("runless"),
        Some(crate::WaitDetail::BeforeSend(Some(
            "Checking whether the checkout is idle."
        )))
    ));
}

#[tokio::test]
async fn a_settled_run_wakes_the_oldest_slot_waiter() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    for id in ["z-first", "a-second"] {
        let (task, _, _) = reservation(id, Entry::Brief, &service.fixture().start);
        service
            .state
            .lock()
            .await
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .expect("seed waiter");
        let row = service.task(id).await.expect("waiter");
        service
            .schedule_result(
                &row,
                &Ok(Action::Wait(WaitReason::Capacity)),
                Priority::Effect,
            )
            .await
            .expect("schedule capacity backstop");
    }
    let (mut holder, _, _) = reservation("holder", Entry::Brief, &service.fixture().start);
    let instance = holder
        .run()
        .expect("reserved run")
        .launch()
        .instance
        .clone();
    holder.record_send(&instance, 1).expect("slot occupied");
    service
        .state
        .lock()
        .await
        .store
        .create_with_facts(
            &holder,
            &event("fixture"),
            nucleus_store::TaskAdmissionFacts::default(),
        )
        .expect("seed holder");
    let actor = Authority::Operator {
        actor: "fixture".into(),
    };
    let revoked = service
        .command("holder", &actor, Command::Cancel)
        .await
        .expect("cancel");
    {
        let now = Instant::now();
        let state = service.state.lock().await;
        assert!(!state.schedule.effect_ready("z-first", now));
        assert!(state.schedule.due("z-first").expect("backstop") > now + Duration::from_secs(55));
    }
    let mut settled = revoked.task.clone();
    settled.reconcile(&Observation {
        host: Observed::Known(Host::Current {
            instance,
            state: nucleus_core::RunState::Ended,
        }),
        forge: Observed::Unknown,
        workspace: Observed::Unknown,
    });
    assert!(settled.run().is_none());
    service
        .save(&revoked, settled, &event("phase_reconciled"))
        .await
        .expect("release slot");
    let state = service.state.lock().await;
    let now = Instant::now();
    assert!(state.schedule.effect_ready("z-first", now));
    assert!(!state.schedule.effect_ready("a-second", now));
}

pub(super) fn verified_native_fixture(host: T3, root: &std::path::Path) -> T3 {
    described_native_fixture(host, root, std::process::id())
}

pub(super) fn described_native_fixture(host: T3, root: &std::path::Path, pid: u32) -> T3 {
    let descriptor = root.join("native-runtime.json");
    if !descriptor.exists() {
        // The local proof reads process start time at whole-second resolution.
        std::thread::sleep(Duration::from_secs(1));
        let timestamp = Process::new("/bin/date")
            .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
            .output()
            .unwrap();
        assert!(timestamp.status.success());
        std::fs::write(
            &descriptor,
            json!({
                "origin": host.endpoint(), "pid": pid,
                "startedAt": std::str::from_utf8(&timestamp.stdout).unwrap().trim(),
            })
            .to_string(),
        )
        .unwrap();
    }
    host.with_runtime_descriptor(descriptor)
}

pub(super) async fn native_fixture(
    response: impl Fn(&Value) -> Value + Clone + Send + Sync + 'static,
) -> (T3, tokio::task::JoinHandle<()>) {
    native_fixture_with_traffic(response, None).await
}

pub(super) fn archive_snapshot_reply(request: &Value, sequence: u64, threads: &[Value]) -> Value {
    assert_eq!(request["tag"], "orchestration.getArchivedShellSnapshot");
    json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success","value":{
        "schemaVersion":2,"snapshotSequence":sequence,"projects":[],"threads":threads
    }}})
}

pub(super) async fn empty_archive_fixture(sequence: u64) -> (T3, tokio::task::JoinHandle<()>) {
    native_fixture(move |request| archive_snapshot_reply(request, sequence, &[])).await
}

pub(super) fn archived_checkout_rows(binding: &Binding, task: &Task) -> Vec<Value> {
    let parent = nucleus_hosts::parent_thread(Path::new(&binding.worktree_path));
    [Role::Reviewer, Role::Worker]
        .into_iter()
        .filter_map(|role| task.threads().get(role))
        .chain(std::iter::once(parent.as_str()))
        .map(|id| {
            json!({
                "id":id, "projectId":binding.project_id, "branch":binding.branch,
                "worktreePath":binding.worktree_path, "archivedAt":"2026-11-27T12:00:00Z",
                "deletedAt":null, "status":"completed", "activeRunId":null,
                "pendingRuntimeRequest":null, "pendingBackgroundTasks":[]
            })
        })
        .collect()
}

pub(super) fn assert_scheduled_wait(
    state: &mut State,
    task: &str,
    reason: WaitReason,
    pass_started: Instant,
    delay: Duration,
) -> Instant {
    let due = state.schedule.due(task).expect("recorded recheck");
    let wait = &state.waits[task];
    assert_eq!(wait.reason, Some(reason));
    assert!((pass_started + delay..=wait.since + delay).contains(&due));
    assert!(
        state
            .schedule
            .take_ready(due - Duration::from_nanos(1), &BTreeSet::new(), None)
            .is_none()
    );
    due
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "one fixture trace covers a complete lifecycle"
)]
async fn interrupted_initialization_recovers_on_the_new_base_before_launch() {
    let (forge, forge_server) = serve_forge(Router::new().route(
        &format!("/repos/{REPOSITORY}/pulls"),
        get(|| async { Json(Vec::<Value>::new()) }),
    ))
    .await;
    let (_home, mut service) = fixture(forge);
    let repo = service.fixture().checkout.clone();
    let old_head = service.fixture().start.clone();
    let worktrees = service.worktrees();
    let checkout = worktrees.checkout(&repo, REPOSITORY, "partial").unwrap();
    checkout.allocate(&old_head).unwrap();
    let path = checkout.path().to_owned();
    let admin = std::path::PathBuf::from(git(&path, &["rev-parse", "--absolute-git-dir"]));
    std::fs::remove_file(admin.join("index")).unwrap();
    std::fs::write(admin.join("index.lock"), "").unwrap();
    std::fs::write(admin.join("locked"), "initializing").unwrap();
    std::fs::write(path.join("draft.md"), "untracked draft").unwrap();
    let sibling = worktrees.checkout(&repo, REPOSITORY, "sibling").unwrap();
    sibling.allocate(&old_head).unwrap();
    let sibling_path = sibling.path().to_str().unwrap();
    let sibling_admin =
        std::path::PathBuf::from(git(sibling.path(), &["rev-parse", "--absolute-git-dir"]));
    // A repository-wide prune would remove this unrelated stale registration.
    std::fs::rename(sibling_path, repo.parent().unwrap().join("sibling-moved")).unwrap();
    drop(worktrees);
    create_fixture_commit(&repo, "Advance the base");
    let new_head: Head = git(&repo, &["rev-parse", "HEAD"]).parse().unwrap();
    assert_ne!(old_head, new_head);
    git(&repo, &["push", "origin", "main"]);

    let (mut task, _, mut observation) = reservation("partial", Entry::Brief, &old_head);
    observation.host = Observed::Known(Host::Current {
        instance: task.run().unwrap().launch().instance.clone(),
        state: nucleus_core::RunState::ReadyToSend,
    });
    assert!(task.discard_paused_reservation(&observation));
    assert!(task.dispatch_started());
    {
        let mut state = service.state.lock().await;
        let State {
            store,
            schedule,
            capacity_waiters,
            ..
        } = &mut *state;
        store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        let now = Instant::now();
        schedule
            .seed(
                store,
                now,
                service.acp_provider().is_some(),
                capacity_waiters,
            )
            .unwrap();
        assert_eq!(schedule.due("partial"), Some(now));
    }
    let pass_started = Instant::now();
    let first = service.pass().await.unwrap();
    assert!(matches!(
        first[0].result,
        Err(ServiceError::Workspace(
            nucleus_work::WorkError::Initializing
        ))
    ));
    assert_eq!(git(&path, &["rev-parse", "HEAD"]), old_head.as_str());
    assert!(admin.join("index.lock").exists());
    assert!(service.host.host_calls().is_empty());

    let root = repo.clone();
    let runs = Arc::new(std::sync::Mutex::new(
        crate::profiles::tests::NativeRuns::default(),
    ));
    let (host, native) = native_fixture(move |request| {
        crate::profiles::tests::native_response(request, &root, &mut runs.lock().unwrap())
    })
    .await;
    service.host = host;
    crate::profiles::tests::publish_parent_shell(&service).await;
    let second = run_workspace_recheck(&service, "partial", pass_started).await;
    assert!(
        matches!(second, Ok(Action::Wait(WaitReason::Starting))),
        "{second:?}"
    );
    let row = service.task("partial").await.unwrap();
    assert!(row.task.run().is_none());
    assert_eq!(git(&path, &["rev-parse", "HEAD"]), new_head.as_str());
    assert!(admin.join("index").is_file());
    assert!(!admin.join("locked").exists());
    assert!(!admin.join("index.lock").exists());
    assert!(!path.join("draft.md").exists());
    let quarantine = service.storage.scratch().path().join("quarantine");
    let saved = std::fs::read_dir(quarantine)
        .unwrap()
        .find_map(|entry| std::fs::read_to_string(entry.unwrap().path().join("draft.md")).ok());
    assert_eq!(saved.as_deref(), Some("untracked draft"));
    assert!(sibling_admin.is_dir());
    native.abort();
    forge_server.abort();
}

fn checkouts(service: &Service) -> usize {
    std::fs::read_dir(service.storage.work().path())
        .expect("work root")
        .count()
}

async fn run_workspace_recheck(
    service: &Service,
    task: &str,
    pass_started: Instant,
) -> Result<Action, ServiceError> {
    let recovery = {
        let mut state = service.state.lock().await;
        let due = assert_scheduled_wait(
            &mut state,
            task,
            WaitReason::WorkspaceUnknown,
            pass_started,
            nucleus_hosts::T3_RETRY_DELAY,
        );
        service
            .take_ready(&mut state, due, &BTreeSet::new())
            .expect("workspace recheck is ready at its deadline")
    };
    assert_eq!(recovery.id, task);
    assert_eq!(recovery.priority, Priority::Effect);
    let host = service.host.pass(service.storage.scratch().path());
    service
        .run_due_task(&recovery, &host)
        .await
        .unwrap()
        .expect("workspace recovery outcome")
}

#[tokio::test]
async fn interrupted_checkout_with_a_sent_worker_is_preserved() {
    let (forge, server) = serve_forge(Router::new().route(
        &format!("/repos/{REPOSITORY}/pulls"),
        get(|| async { Json(Vec::<Value>::new()) }),
    ))
    .await;
    let (_home, service) = fixture(forge);
    let worktrees = service.worktrees();
    let checkout = worktrees
        .checkout(&service.fixture().checkout, REPOSITORY, "sent")
        .unwrap();
    let head = &service.fixture().start;
    checkout.allocate(head).unwrap();
    let admin =
        std::path::PathBuf::from(git(checkout.path(), &["rev-parse", "--absolute-git-dir"]));
    std::fs::remove_file(admin.join("index")).unwrap();
    std::fs::write(admin.join("index.lock"), "").unwrap();
    std::fs::write(admin.join("locked"), "initializing").unwrap();
    let (mut task, _, mut observation) = reservation("sent", Entry::Brief, head);
    let instance = task.run().unwrap().launch().instance.clone();
    task.record_send(&instance, 2).unwrap();
    observation.host = Observed::Known(Host::Current {
        instance,
        state: nucleus_core::RunState::Gone,
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Relaunch(nucleus_core::Role::Worker)
    );
    assert!(task.run().is_none());
    {
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        state
            .observe_wait(&task, Some(WaitReason::WorkspaceUnknown))
            .unwrap();
    }
    let row = service.task("sent").await.unwrap();
    let result = Box::pin(service.advance_due_task(&row, &service.host.fixture_pass())).await;
    assert!(matches!(
        result,
        Err(ServiceError::Workspace(
            nucleus_work::WorkError::Initializing
        ))
    ));
    assert_eq!(service.task("sent").await.unwrap(), row);
    assert!(admin.join("locked").exists());
    assert!(admin.join("index.lock").exists());
    assert_eq!(git(checkout.path(), &["rev-parse", "HEAD"]), head.as_str());
    assert!(service.host.host_calls().is_empty());
    server.abort();
}

#[tokio::test]
async fn a_bounced_worker_keeps_admission_order_and_its_native_parent() {
    Box::pin(exercise_queue_parent(false)).await;
}

#[tokio::test]
async fn a_lost_parent_reply_keeps_one_native_launch_across_capacity() {
    Box::pin(exercise_queue_parent(true)).await;
}

#[expect(
    clippy::too_many_lines,
    reason = "exercise the same native parent through capacity, restart and dispatch"
)]
async fn exercise_queue_parent(lose_launch_reply: bool) {
    let (forge, forge_server) = serve_forge(Router::new().route(
        &format!("/repos/{REPOSITORY}/pulls"),
        get(|| async { Json(Vec::<Value>::new()) }),
    ))
    .await;
    let (home, mut service) = fixture(forge);
    service.state.lock().await.settings.dispatch = Some(nucleus_store::DispatchSettings {
        total_slots: 1,
        heavy_slots: 1,
        ..nucleus_store::DispatchSettings::default()
    });
    service.set_fixture_acp_provider(Some("fixture-acp"));
    let project = service.fixture().clone();
    let shell = json!({"projects":[{
        "id":project.host_project, "workspaceRoot":project.checkout
    }], "threads":[]});
    let launches = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let holds = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let children = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let old_present = Arc::new(AtomicUsize::new(0));
    let (writes, messages, workers, progress) = (
        Arc::clone(&launches),
        Arc::clone(&holds),
        Arc::clone(&children),
        Arc::clone(&old_present),
    );
    let (host, native) = native_fixture(move |request| {
        let id = &request["id"];
        let payload = &request["payload"];
        let value = match request["tag"].as_str() {
            Some("server.getConfig") => json!({
                "environment":{"orchestrationProtocolVersion":2},
                "providers":[
                    {"instanceId":"provider","driver":"codex","enabled":true,"status":"ready","models":[{"slug":"fixture"}]},
                    {"instanceId":"fixture-acp","driver":"acpRegistry","enabled":true,"status":"ready","models":[{"slug":"nucleus"}]}
                ]
            }),
            Some("orchestration.subscribeThread") => {
                let thread = payload["threadId"].as_str().unwrap();
                let launches = writes.lock().unwrap();
                let stage = progress.load(Ordering::Relaxed);
                if let Some(parent) = launches.first().filter(|launch| stage > 0 && launch["threadId"] == thread) {
                    let mut runs = vec![json!({
                        "id":"old-run","status":if stage == 2 {"completed"} else {"running"},
                        "rootNodeId":"old-node","userMessageId":parent["initialMessage"]["messageId"],
                    })];
                    let messages: Vec<_> = messages.lock().unwrap().iter()
                        .map(|hold| json!({"id":hold["messageId"]})).collect();
                    if stage == 2 {
                        runs.push(json!({"id":"new-run","status":"running","rootNodeId":"new-node",
                            "userMessageId":messages[0]["id"]}));
                    }
                    return json!({"_tag":"Chunk","requestId":id,"values":[
                        {"kind":"snapshot","snapshotSequence":17,"projection":{
                            "thread":{"id":thread,"projectId":parent["projectId"],
                                "branch":parent["workspaceStrategy"]["branch"],
                                "worktreePath":parent["workspaceStrategy"]["worktreePath"],
                                "modelSelection":parent["modelSelection"],
                                "providerInstanceId":parent["modelSelection"]["instanceId"]},
                            "runs":runs,"messages":messages,"runtimeRequests":[],"providerThreads":[],"turnItems":[]
                        }},
                        {"kind":"synchronized"}
                    ]});
                }
                return json!({"_tag":"Exit","requestId":id,"exit":{"_tag":"Failure","cause":[
                    {"_tag":"Fail","error":{"_tag":"OrchestrationV2GetThreadProjectionError","threadId":thread,
                        "cause":{"name":"ProjectionStoreThreadNotFoundError",
                            "message":format!("No orchestration projection exists for thread {thread}.")}}}
                ]}});
            }
            Some("orchestration.launchThread") => {
                writes.lock().unwrap().push(payload.clone());
                if lose_launch_reply { return Value::Null; }
                json!({"sequence":1})
            }
            Some("orchestration.dispatchCommand") if payload["type"] == "message.dispatch" => {
                messages.lock().unwrap().push(payload.clone());
                json!({"sequence":18})
            }
            Some("orchestration.dispatchCommand") if payload["type"] == "delegated_task.request" => {
                workers.lock().unwrap().push(payload.clone());
                json!({"sequence":19})
            }
            tag => panic!("unexpected queue RPC {tag:?}"),
        };
        json!({"_tag":"Exit","requestId":id,"exit":{"_tag":"Success","value":value}})
    }).await;
    host.fixture_project_shell(&shell, "fixture-acp");
    service.host = verified_native_fixture(host, home.path());
    let show_parent = |service: &Service, status: &str, run: &str| {
        let launches = launches.lock().unwrap();
        let launch = &launches[0];
        let mut seen = shell.clone();
        seen["snapshotSequence"] = json!(17);
        let active = status == "running";
        let now = time::OffsetDateTime::now_utc();
        let format = &time::format_description::well_known::Rfc3339;
        seen["threads"] = json!([{
            "id":launch["threadId"], "projectId":launch["projectId"],
            "branch":launch["workspaceStrategy"]["branch"], "worktreePath":launch["workspaceStrategy"]["worktreePath"],
            "modelSelection":launch["modelSelection"], "providerInstanceId":launch["modelSelection"]["instanceId"],
            "status":status, "activeRunId":active.then_some(run), "latestRunId":run,
            "latestRunStartedAt":(now - time::Duration::seconds(3)).format(format).unwrap(),
            "latestRunCompletedAt":(!active).then(|| now.format(format).unwrap()),
            "pendingRuntimeRequest":null, "pendingBackgroundTasks":[]
        }]);
        service.host.fixture_project_shell(&seen, "fixture-acp");
    };
    let oldest = "z-oldest";
    let newest = ["m-next", "a-last"];
    let head = &project.start;
    let queued = |id| {
        let (shape, _, _) = reservation(id, Entry::Brief, head);
        Task::new(shape.identity().clone(), shape.brief().text.clone(), None)
    };
    let pass = async |service: &Service| service.pass().await.expect("queue pass");
    assert_eq!(checkouts(&service), 0);
    service
        .state
        .lock()
        .await
        .store
        .create_with_facts(
            &queued(oldest),
            &event("fixture"),
            nucleus_store::TaskAdmissionFacts::default(),
        )
        .unwrap();
    assert!(matches!(
        pass(&service).await[0].result,
        Ok(Action::Advance(Phase::Working))
    ));
    assert!(launches.lock().unwrap().is_empty());
    let outcomes = pass(&service).await;
    if lose_launch_reply {
        assert!(
            matches!(outcomes[0].result, Err(ServiceError::ParentRetry { .. })),
            "{:?}",
            outcomes[0].result
        );
    } else {
        assert!(
            matches!(outcomes[0].result, Ok(Action::Wait(WaitReason::Starting))),
            "{:?}",
            outcomes[0].result
        );
    }
    assert_eq!(launches.lock().unwrap().len(), 1);
    let preparing = service.task(oldest).await.unwrap();
    assert!(preparing.task.run().is_none());

    let (mut winner, _, _) = reservation("winner", Entry::Brief, head);
    let instance = winner.run().unwrap().launch().instance.clone();
    winner.record_send(&instance, 2).unwrap();
    {
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &winner,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        state.schedule.park("winner");
        // The next oldest-task decision follows the fixture's capacity or native evidence.
        state.schedule.park(oldest);
        for id in newest {
            state
                .store
                .create_with_facts(
                    &queued(id),
                    &event("fixture"),
                    nucleus_store::TaskAdmissionFacts::default(),
                )
                .unwrap();
            state.schedule.wake(id, Instant::now(), Priority::Wake);
        }
    }
    if lose_launch_reply {
        // Run the normal task decision when an already scheduled recheck becomes due.
        let result =
            Box::pin(service.advance_due_task(&preparing, &service.host.fixture_pass())).await;
        assert!(matches!(result, Ok(Action::Wait(WaitReason::Capacity))));
        service
            .schedule_result(&preparing, &result, Priority::Effect)
            .await
            .unwrap();
        assert_eq!(service.task(oldest).await.unwrap(), preparing);
    } else {
        let mut waiting = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            while waiting.len() < newest.len() {
                waiting.extend(pass(&service).await);
            }
        })
        .await
        .expect("both capacity waiters are examined");
        assert_eq!(waiting.len(), newest.len());
        assert!(waiting.iter().all(|outcome| {
            newest.contains(&outcome.task.as_str())
                && matches!(outcome.result, Ok(Action::Wait(WaitReason::Capacity)))
        }));
        assert!(service.state.lock().await.last_pass_calls.is_empty());
        old_present.store(1, Ordering::Relaxed);
        service
            .state
            .lock()
            .await
            .schedule
            .wake(oldest, Instant::now(), Priority::Wake);
        assert!(matches!(
            pass(&service).await[0].result,
            Ok(Action::Wait(WaitReason::Capacity))
        ));
        let bounced = service.task(oldest).await.unwrap();
        assert_eq!(bounced.task.phase(), Phase::Queued);
        assert!(bounced.task.run().is_none());
        assert_eq!(
            service
                .state
                .lock()
                .await
                .capacity_waiters
                .iter()
                .map(|(_, _, _, id)| id.as_str())
                .collect::<Vec<_>>(),
            [oldest, newest[0], newest[1]]
        );
    }

    let endpoint = service.host.endpoint().to_owned();
    let mut host = T3::new(&endpoint, "fixture").unwrap();
    if lose_launch_reply {
        host = host.with_runtime_descriptor(home.path().join("missing-host-descriptor"));
        assert!(host.runtime_identity().is_none());
    }
    host.fixture_project_shell(&shell, "fixture-acp");
    let forge = std::mem::replace(&mut service.forge, GitHub::new("fixture").unwrap());
    drop(service);
    let settings = SettingsFile::open(&home.path().canonicalize().unwrap()).unwrap();
    let mut service = Service::open_projects(
        settings.lock_profile().unwrap(),
        "fixture-acp".into(),
        host,
        forge,
        "127.0.0.1:9".parse().unwrap(),
        std::env::current_exe().unwrap(),
    )
    .unwrap();
    service.state.lock().await.settings.dispatch = Some(nucleus_store::DispatchSettings {
        total_slots: 1,
        heavy_slots: 1,
        ..nucleus_store::DispatchSettings::default()
    });
    service.state.lock().await.schedule.park("winner");
    let mut outcomes = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while outcomes.len() < 3 {
            outcomes.extend(pass(&service).await);
        }
    })
    .await
    .expect("capacity waiters resume after restart");
    assert_eq!(
        outcomes
            .iter()
            .map(|outcome| outcome.task.as_str())
            .collect::<Vec<_>>(),
        [oldest, newest[0], newest[1]]
    );
    assert!(
        outcomes
            .iter()
            .all(|outcome| matches!(outcome.result, Ok(Action::Wait(WaitReason::Capacity))))
    );
    assert!(service.state.lock().await.last_pass_calls.is_empty());

    if lose_launch_reply {
        assert_eq!(service.task(oldest).await.unwrap(), preparing);
        service
            .state
            .lock()
            .await
            .schedule
            .wake(oldest, Instant::now(), Priority::Wake);
        assert!(matches!(
            pass(&service).await[0].result,
            Ok(Action::Wait(WaitReason::Capacity))
        ));
        assert!(service.host.host_calls().is_empty());
        assert_eq!(service.task(oldest).await.unwrap(), preparing);
        assert!(
            service
                .state
                .lock()
                .await
                .store
                .pending_parent_preparation(oldest, preparing.version)
                .unwrap()
        );
        let descriptor = home.path().join("replacement-runtime.json");
        std::fs::write(
            &descriptor,
            json!({
                "origin": endpoint, "pid": std::process::id(), "startedAt":"2020-01-02T00:00:00Z"
            })
            .to_string(),
        )
        .unwrap();
        service.host = T3::new(&endpoint, "fixture")
            .unwrap()
            .with_runtime_descriptor(descriptor);
        service.host.fixture_project_shell(&shell, "fixture-acp");
        // Capacity wakes the recovery read after the exact native message becomes visible.
        old_present.store(1, Ordering::Relaxed);
        show_parent(&service, "running", "old-run");
    }

    let revoked = service
        .command(
            "winner",
            &Authority::Operator {
                actor: "fixture".into(),
            },
            Command::Cancel,
        )
        .await
        .unwrap();
    let mut settled = revoked.task.clone();
    settled.reconcile(&Observation {
        host: Observed::Known(Host::Current {
            instance,
            state: nucleus_core::RunState::Ended,
        }),
        forge: Observed::Unknown,
        workspace: Observed::Unknown,
    });
    assert!(settled.run().is_none());
    service
        .state
        .lock()
        .await
        .schedule
        .wake(newest[0], Instant::now(), Priority::Effect);
    service
        .save(&revoked, settled, &event("stopped"))
        .await
        .unwrap();
    let released = pass(&service).await;
    // The settled holder can receive a closeout turn in the same pass.
    let admission = released
        .iter()
        .find(|outcome| outcome.task != "winner")
        .expect("released capacity reaches an admission decision");
    assert_eq!(admission.task, oldest);
    let advance = async |service: &Service| {
        let row = service.task(oldest).await.unwrap();
        Box::pin(service.advance_due_task(&row, &service.host.fixture_pass())).await
    };
    if lose_launch_reply {
        assert!(
            matches!(admission.result, Ok(Action::Launch { .. })),
            "{:?}",
            admission.result
        );
        assert_eq!(launches.lock().unwrap().len(), 1);
        assert!(holds.lock().unwrap().is_empty());
    } else {
        assert_eq!(
            service.task(oldest).await.unwrap().task.phase(),
            Phase::Working
        );
        show_parent(&service, "completed", "old-run");
        assert!(matches!(
            advance(&service).await.unwrap(),
            Action::Wait(WaitReason::Starting)
        ));
        assert_eq!(holds.lock().unwrap().len(), 1);
        assert_eq!(
            holds.lock().unwrap()[0]["threadId"],
            launches.lock().unwrap()[0]["threadId"]
        );
        old_present.store(2, Ordering::Relaxed);
        show_parent(&service, "running", "new-run");
    }
    assert!(matches!(
        advance(&service).await.unwrap(),
        Action::Launch { .. }
    ));
    if lose_launch_reply {
        assert!(
            !service
                .state
                .lock()
                .await
                .store
                .pending_parent_preparation(oldest, preparing.version)
                .unwrap()
        );
    }
    let row = service.task(oldest).await.unwrap();
    let wire: Value = serde_json::from_str(&row.task.run().unwrap().launch().input).unwrap();
    let (run, node) = if lose_launch_reply {
        ("old-run", "old-node")
    } else {
        ("new-run", "new-node")
    };
    assert_eq!(wire["payload"]["parentRunId"], run);
    assert_eq!(wire["payload"]["parentNodeId"], node);
    if !lose_launch_reply {
        assert!(matches!(
            advance(&service).await.unwrap(),
            Action::Launch { .. }
        ));
    }
    assert_eq!(launches.lock().unwrap().len(), 1);
    assert_eq!(holds.lock().unwrap().len(), usize::from(!lose_launch_reply));
    assert_eq!(
        children.lock().unwrap().as_slice(),
        &[wire["payload"].clone()]
    );
    native.abort();
    forge_server.abort();
}

#[tokio::test]
async fn full_checkout_budget_does_not_peek_at_t3() {
    let (_home, mut service) = fixture(GitHub::new("unused").unwrap());
    let (host, native) = native_fixture(|request| {
        panic!("queued checkout wait called T3: {}", request["tag"]);
    })
    .await;
    service.host = host;
    service.set_fixture_acp_provider(Some("fixture-acp"));
    service.state.lock().await.settings.dispatch = Some(nucleus_store::DispatchSettings {
        heavy_slots: 1,
        total_slots: 1,
        project_default_slots: 1,
        ..nucleus_store::DispatchSettings::default()
    });
    assert_eq!(checkouts(&service), 0, "the fresh profile has no checkouts");
    let head = &service.fixture().start;
    let checkout_repo = &service.fixture().checkout;
    let worktrees = service.worktrees();
    for id in ["first-owned", "second-owned"] {
        let (shape, _, observation) = reservation(id, Entry::Brief, head);
        let mut task = Task::new(shape.identity().clone(), "Fixture".into(), None);
        task.command(
            Command::Hold("Retain the checkout".into()),
            &Authority::Operator {
                actor: "fixture".into(),
            },
            &observation,
        )
        .unwrap();
        worktrees
            .checkout(checkout_repo, REPOSITORY, id)
            .unwrap()
            .allocate(head)
            .unwrap();
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        state.schedule.park(id);
    }
    let (shape, _, _) = reservation("queued", Entry::Brief, head);
    let queued = Task::new(shape.identity().clone(), "Fixture".into(), None);
    {
        let mut state = service.state.lock().await;
        assert_eq!(state.store.occupied_slots("").unwrap().total, 0);
        state
            .store
            .create_with_facts(
                &queued,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
    }
    for _ in 0..2 {
        let outcomes = service.pass().await.unwrap();
        assert!(matches!(
            outcomes.as_slice(),
            [PassOutcome {
                result: Ok(Action::Wait(WaitReason::Capacity)),
                ..
            }]
        ));
        let row = service.task("queued").await.unwrap();
        assert_eq!(row.task, queued);
        assert_eq!(row.version, 1);
        let mut state = service.state.lock().await;
        assert!(state.last_pass_calls.is_empty());
        state
            .schedule
            .wake("queued", Instant::now(), Priority::Wake);
    }
    assert!(service.host.host_calls().is_empty());
    native.abort();
}

#[tokio::test]
async fn paused_passes_leave_twenty_runless_rows_and_native_traffic_unchanged() {
    let (forge, forge_server) = serve_forge(Router::new().route(
        &format!("/repos/{REPOSITORY}/pulls"),
        get(|| async { Json(Vec::<Value>::new()) }),
    ))
    .await;
    let (_home, mut service) = fixture(forge);
    let (host, native_server) = native_fixture(|request| {
        panic!(
            "paused idle rows must make no native requests: {}",
            request["tag"]
        );
    })
    .await;
    service.host = host;
    let ids: Vec<_> = (0..20).map(|index| format!("paused-{index:02}")).collect();
    {
        let mut state = service.state.lock().await;
        state
            .settings
            .dispatch
            .get_or_insert_with(Default::default)
            .mode = DispatchMode::Paused;
        for id in &ids {
            let (mut task, _, mut observation) =
                reservation(id, Entry::Brief, &service.fixture().start);
            let instance = task.run().unwrap().launch().instance.clone();
            task.record_send(&instance, 2).unwrap();
            observation.host = Observed::Known(Host::Current {
                instance,
                state: nucleus_core::RunState::Gone,
            });
            assert_eq!(
                task.reconcile(&observation),
                Action::Relaunch(nucleus_core::Role::Worker)
            );
            assert!(task.run().is_none());
            assert!(task.threads().get(nucleus_core::Role::Worker).is_some());
            state
                .store
                .create_with_facts(
                    &task,
                    &event("fixture"),
                    nucleus_store::TaskAdmissionFacts::default(),
                )
                .unwrap();
        }
    }
    for _ in 0..2 {
        let mut count = 0;
        while count < ids.len() {
            let pass = service.pass().await.unwrap();
            count += pass.len();
            for outcome in pass {
                assert!(
                    matches!(outcome.result, Ok(Action::Wait(WaitReason::Capacity))),
                    "{}",
                    outcome.task
                );
            }
            assert!(service.state.lock().await.last_pass_calls.is_empty());
        }
        let mut state = service.state.lock().await;
        for id in &ids {
            assert_eq!(state.store.history(id, None, 10).unwrap().len(), 1);
            state.schedule.wake(id, Instant::now(), Priority::Wake);
        }
    }
    assert!(service.host.host_calls().is_empty());
    native_server.abort();
    forge_server.abort();
}

#[derive(Default)]
pub(super) struct NativeTraffic {
    pub(super) received: AtomicUsize,
    pub(super) sent: AtomicUsize,
    pub(super) received_frames: AtomicUsize,
    pub(super) frame_received: Notify,
}

pub(super) async fn native_fixture_with_traffic(
    response: impl Fn(&Value) -> Value + Clone + Send + Sync + 'static,
    traffic: Option<Arc<NativeTraffic>>,
) -> (T3, tokio::task::JoinHandle<()>) {
    native_fixture_inner(response, traffic, None).await
}

pub(super) async fn native_fixture_with_ticket_gate(
    reject_tickets: Arc<std::sync::atomic::AtomicBool>,
    response: impl Fn(&Value) -> Value + Clone + Send + Sync + 'static,
) -> (T3, tokio::task::JoinHandle<()>) {
    native_fixture_inner(response, None, Some(reject_tickets)).await
}

async fn native_fixture_inner(
    response: impl Fn(&Value) -> Value + Clone + Send + Sync + 'static,
    traffic: Option<Arc<NativeTraffic>>,
    reject_tickets: Option<Arc<std::sync::atomic::AtomicBool>>,
) -> (T3, tokio::task::JoinHandle<()>) {
    let app = Router::new()
        .route(
            "/api/auth/websocket-ticket/rpc",
            post(move || {
                let reject_tickets = reject_tickets.clone();
                async move {
                    if reject_tickets
                        .as_ref()
                        .is_some_and(|flag| flag.load(Ordering::Relaxed))
                    {
                        (axum::http::StatusCode::SERVICE_UNAVAILABLE, Json(json!({})))
                    } else {
                        (
                            axum::http::StatusCode::OK,
                            Json(json!({"ticket":"fixture"})),
                        )
                    }
                }
            }),
        )
        .route(
            "/ws",
            get(move |upgrade: WebSocketUpgrade| async move {
                upgrade.on_upgrade(move |mut ws| async move {
                    while let Some(Ok(Message::Text(frame))) = ws.recv().await {
                        if let Some(traffic) = &traffic {
                            traffic.received.fetch_add(frame.len(), Ordering::Relaxed);
                            traffic.received_frames.fetch_add(1, Ordering::Relaxed);
                            traffic.frame_received.notify_one();
                        }
                        let req: Value = serde_json::from_str(&frame).expect("Effect request");
                        if req["_tag"] == "Request" {
                            let reply = response(&req);
                            if reply.is_null() {
                                break;
                            }
                            let reply = reply.to_string();
                            let bytes = reply.len();
                            ws.send(Message::Text(reply.into())).await.expect("reply");
                            if let Some(traffic) = &traffic {
                                traffic.sent.fetch_add(bytes, Ordering::Relaxed);
                            }
                        }
                    }
                })
            }),
        );
    let tcp = TcpListener::bind("127.0.0.1:0").await.expect("listen");
    let host = T3::new(
        &format!("http://{}", tcp.local_addr().expect("address")),
        "fixture",
    )
    .expect("native client");
    (
        host,
        tokio::spawn(async {
            axum::serve(tcp, app).await.expect("native server");
        }),
    )
}

#[tokio::test]
async fn a_due_task_stays_queued_when_its_row_cannot_be_used() {
    let (_home, service) = fixture(GitHub::new("fixture").unwrap());
    let (task, _, _) = reservation("bad-scope", Entry::Brief, &service.fixture().start);
    let mut identity = task.identity().clone();
    identity.repository = "example/other".into();
    let task = Task::new(identity, "Fixture".into(), None);
    {
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        state
            .schedule
            .wake("bad-scope", Instant::now(), Priority::Wake);
    }
    let outcomes = service.pass().await.unwrap();
    assert!(
        matches!(outcomes.as_slice(), [PassOutcome { task, result: Err(ServiceError::Project) }] if task == "bad-scope")
    );
    let mut state = service.state.lock().await;
    let due = state
        .schedule
        .due("bad-scope")
        .expect("failed task has a retry");
    assert!(due > Instant::now());
    assert_eq!(
        state
            .schedule
            .take_ready(due, &BTreeSet::new(), None)
            .unwrap()
            .id,
        "bad-scope"
    );
    assert_eq!(state.scheduler_error, None);
    assert!(state.last_pass_calls.is_empty());
}

#[tokio::test]
async fn recorded_role_send_time_does_not_extend_an_observation_outage() {
    let (_home, service) = fixture(GitHub::new("fixture").unwrap());
    let (mut task, _, _) = reservation("sent", Entry::Brief, &service.fixture().start);
    let instance = task.run().unwrap().launch().instance.clone();
    task.record_send(&instance, now_ms()).unwrap();
    let row = {
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        service.lookup(&state, "sent").unwrap()
    };
    let deadline = Instant::now() + Duration::from_mins(2);
    for error in [
        HostError::Unavailable,
        HostError::Deferred { until: deadline },
        HostError::RoleReplyPending { until: deadline },
    ] {
        service
            .schedule_result(&row, &Err(ServiceError::Host(error)), Priority::Effect)
            .await
            .unwrap();
        let mut state = service.state.lock().await;
        let due = state.schedule.due("sent").unwrap();
        match error {
            HostError::Unavailable => assert!(due < deadline),
            _ => assert_eq!(due, deadline),
        }
        assert_eq!(
            state
                .schedule
                .take_ready(due, &BTreeSet::new(), None)
                .unwrap()
                .id,
            "sent"
        );
    }
}

#[tokio::test]
async fn done_archive_keeps_its_cause_and_respects_host_deferral() {
    let (_home, mut service) = fixture(GitHub::new("fixture").unwrap());
    service.set_fixture_acp_provider(Some("fixture-acp"));
    let (task, _, _) = reservation("archive", Entry::Brief, &service.fixture().start);
    let task = Task::new(task.identity().clone(), "Fixture".into(), None);
    let mut snapshot = serde_json::to_value(task).unwrap();
    snapshot["phase"] = json!("done");
    let task = serde_json::from_value(snapshot).unwrap();
    let row = {
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        service.lookup(&state, "archive").unwrap()
    };
    let until = Instant::now() + Duration::from_mins(1);
    service
        .schedule_result(
            &row,
            &Err(ServiceError::Host(HostError::Deferred { until })),
            Priority::Effect,
        )
        .await
        .unwrap();
    let state = service.state.lock().await;
    assert_eq!(state.schedule.due("archive"), Some(until));
    assert!(
        matches!(state.wait_detail("archive"), Some(WaitDetail::Archive(cause)) if cause.contains("host deferred"))
    );
}

#[tokio::test]
async fn host_backoff_does_not_delay_a_local_task_decision() {
    let (_home, service) = fixture(GitHub::new("fixture").unwrap());
    let host = service.host.pass(service.storage.scratch().path());
    assert!(host.profile_catalog().await.is_err());
    assert!(service.host.request_retry_at().is_some());
    let (task, _, _) = reservation("local", Entry::Brief, &service.fixture().start);
    let task = Task::new(task.identity().clone(), "Fixture".into(), None);
    {
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
    }
    service
        .command(
            "local",
            &Authority::Operator {
                actor: "fixture".into(),
            },
            Command::Cancel,
        )
        .await
        .unwrap();
    let outcomes = tokio::time::timeout(Duration::from_secs(2), service.pass())
        .await
        .expect("local work must not wait for T3")
        .unwrap();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].task, "local");
    assert_eq!(outcomes[0].result.as_ref().unwrap(), &Action::Nothing);
    assert!(service.state.lock().await.last_pass_calls.is_empty());
}

mod close_requests;
mod work_volume;

#[tokio::test]
async fn wait_retention_tracks_the_question_even_when_its_title_stays_the_same() {
    let (_home, service) = fixture(GitHub::new("fixture").unwrap());
    let (reserved, _, obs) = reservation("same-title", Entry::Brief, &service.fixture().start);
    let mut task = Task::new(reserved.identity().clone(), "Initial brief".into(), None);
    assert!(task.ask_allowance(20, 10));
    let mut state = service.state.lock().await;
    state
        .store
        .create_with_facts(
            &task,
            &event("admitted"),
            nucleus_store::TaskAdmissionFacts::default(),
        )
        .unwrap();
    let id = &task.identity().id;
    state.set_wait(id, Some(WaitReason::Question));
    let deadline = Instant::now() + Duration::from_mins(1);
    state.schedule.wake(id, deadline, Priority::Effect);
    let mut amended = task.clone();
    amended
        .command(
            Command::Amend("Updated brief".into()),
            &Authority::Planner {
                actor: "planner".into(),
            },
            &obs,
        )
        .unwrap();
    let row = service.lookup(&state, id).unwrap();
    service
        .commit(&mut state, &row, &amended, &event("fixture"), None)
        .unwrap();
    assert_eq!(state.wait_reason(id), Some(WaitReason::Question));
    let row = service.lookup(&state, id).unwrap();
    let mut changed = row.task.clone();
    assert!(changed.clear_allowance_question());
    assert!(changed.ask_allowance(35, 30));
    let before = titles::task_state_label(&row.task, state.wait_reason(id), state.wait_detail(id));
    let (reason, label_changed) = state.task_wait_transition(&row.task, &changed).unwrap();
    assert_eq!(reason, None);
    assert!(!label_changed);
    assert_eq!(
        before,
        titles::task_state_label(&changed, reason, state.wait_detail(id))
    );
    service
        .commit(&mut state, &row, &changed, &event("fixture"), None)
        .unwrap();
    assert_eq!(state.wait_reason(id), None);
}
