//! Launch slots (Spec 070 rulings 66 and 68): admitted tasks, launches and
//! the label `nucleus next` returns.

use std::collections::BTreeSet;

use axum::{
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode},
};
use nucleus_core::{QueuePriority, profiles::TaskWeight};

use super::*;
use crate::web::Controller;

const KEY: [u8; 32] = [2; 32];
const WAITING_HEAVY: &str = "Waiting for a heavy slot (1/1)";
const FULL: &str = "Queued · capacity";
const SIBLING_REPO: &str = "example/sibling";
const SECOND_REPO: &str = "example/second";
const THIRD_REPO: &str = "example/third";

struct Fleet {
    service: Arc<Service>,
    api: Router,
    project_slots: u32,
    servers: Servers,
    home: tempfile::TempDir,
}

struct Servers([tokio::task::JoinHandle<()>; 2]);

impl Drop for Servers {
    fn drop(&mut self) {
        for server in &self.0 {
            server.abort();
        }
    }
}

fn brief(weight: Option<&str>, priority: QueuePriority, body: &str) -> String {
    let weight = weight.map_or_else(String::new, |weight| format!("  weight: {weight}\n"));
    let priority = if priority.is_promoted() {
        "  priority: promoted\n"
    } else {
        ""
    };
    format!("---\nqueue:\n  complexity: medium\n{weight}{priority}---\n{body}")
}

/// A service with these heavy and total slots, launching on a fixture host.
async fn fleet(slots: (u32, u32), project: u32) -> Fleet {
    let (forge, forge_server) = serve_forge(Router::new().route(
        &format!("/repos/{REPOSITORY}/pulls"),
        get(|| async { Json(Vec::<Value>::new()) }),
    ))
    .await;
    let (home, mut service) = fixture(forge);
    let root = service.fixture().checkout.clone();
    let runs = Arc::new(Mutex::new(NativeRuns::default()));
    let (host, native_server) = crate::tests::native_fixture(move |request| {
        native_response(request, &root, &mut runs.lock().expect("native runs"))
    })
    .await;
    service.host = host;
    assemble(
        service,
        slots,
        project,
        Servers([forge_server, native_server]),
        home,
    )
    .await
}

async fn assemble(
    service: Service,
    (heavy, total): (u32, u32),
    project: u32,
    servers: Servers,
    home: tempfile::TempDir,
) -> Fleet {
    {
        let mut state = service.state.lock().await;
        state.settings.dispatch = Some(DispatchSettings {
            heavy_slots: heavy,
            total_slots: total,
            project_default_slots: project,
            ..DispatchSettings::default()
        });
        state.settings.profiles = Some(Arc::new(
            serde_json::from_value(json!({"profiles": [
                {"name":"Worker","selection":{"id":"worker","provider":"codex","model":"first"}},
                {"name":"Reviewer","selection":{"id":"review","provider":"codex","model":"second",
                    "capability":"mechanical"}}
            ]}))
            .expect("profiles"),
        ));
    }
    let service = Arc::new(service);
    let api = crate::web::router(
        Arc::clone(&service),
        [Controller {
            credential: KEY,
            authority: Authority::Operator {
                actor: "fixture".into(),
            },
        }],
    );
    Fleet {
        service,
        api,
        project_slots: project,
        servers,
        home,
    }
}

impl Fleet {
    /// Open a new service over the same stored rows, as a process restart does.
    async fn restart(self, slots: (u32, u32), prepare: impl FnOnce(&mut Service)) -> Self {
        let Self {
            service,
            api,
            project_slots,
            servers,
            home,
        } = self;
        drop(api);
        let Ok(mut old) = Arc::try_unwrap(service) else {
            panic!("the stopped service is still shared");
        };
        let settings = old.settings.clone();
        let host = nucleus_hosts::T3::new(old.host.endpoint(), "fixture").expect("fixture host");
        let unused = nucleus_forge::GitHub::new("unused-fixture").expect("unused forge");
        let forge = std::mem::replace(&mut old.forge, unused);
        let (callback, command) = (old.callback, old.report_command.clone());
        drop(old);
        let mut service = Service::open_projects(
            settings.lock_profile().unwrap(),
            "fixture-acp".into(),
            host,
            forge,
            callback,
            command,
        )
        .expect("restarted service");
        prepare(&mut service);
        assemble(service, slots, project_slots, servers, home).await
    }

    /// Store a new task without running any decision for it.
    async fn queue(&self, id: &str, weight: &str) {
        self.service
            .admit_to(
                Some(crate::tests::REPOSITORY),
                id.into(),
                id.into(),
                brief(Some(weight), QueuePriority::Normal, "Fixture"),
                &Authority::Operator {
                    actor: "fixture".into(),
                },
            )
            .await
            .expect("admit task");
    }

    async fn admit(&self, id: &str, weight: Option<&str>, priority: QueuePriority) {
        self.service
            .admit_to(
                Some(crate::tests::REPOSITORY),
                id.into(),
                id.into(),
                brief(weight, priority, "Fixture"),
                &Authority::Operator {
                    actor: "fixture".into(),
                },
            )
            .await
            .expect("admit task");
        self.settle().await;
    }

    async fn add(&self, id: &str, weight: &str) {
        self.admit(id, Some(weight), QueuePriority::Normal).await;
    }

    /// Run every due decision. Waiting and running tasks then wait for a later one.
    async fn settle(&self) {
        for _ in 0..64 {
            // A pass with nothing due would sleep until the next recheck.
            if self.service.state.lock().await.schedule.next() > tokio::time::Instant::now() {
                return;
            }
            pass(&self.service).await;
        }
        panic!("the scheduler did not settle");
    }

    /// The tasks holding a slot, with the run each one holds.
    async fn running(&self) -> BTreeMap<String, String> {
        let state = self.service.state.lock().await;
        state
            .store
            .run_ids()
            .expect("run rows")
            .into_iter()
            .filter_map(|id| {
                let row = state.store.row(&id).expect("row").expect("running task");
                let run = row.task.run().expect("run");
                run.last_send_at_ms()
                    .map(|_| (id, run.launch().instance.clone()))
            })
            .collect()
    }

    async fn assert_running(&self, expected: &[&str]) {
        let mut expected = expected.to_vec();
        expected.sort_unstable();
        assert_eq!(
            self.running().await.keys().collect::<Vec<_>>(),
            expected.iter().collect::<Vec<_>>()
        );
    }

    /// Finish a running task, which frees its slot.
    async fn finish(&self, id: &str) {
        finish_slot_task(&self.service, id).await;
        self.settle().await;
    }

    async fn request(&self, method: Method, path: &str, body: &Value) -> Value {
        let response = self
            .api
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("host", "127.0.0.1:9")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {}", hex::encode(KEY)))
                    .body(Body::from(body.to_string()))
                    .expect("request"),
            )
            .await
            .expect("response");
        let status = response.status();
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("response bytes");
        let body: Value = serde_json::from_slice(&body).expect("response JSON");
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        body
    }

    async fn next(&self, id: &str) -> Value {
        self.request(Method::GET, &format!("/v1/tasks/{id}/next"), &Value::Null)
            .await
    }

    /// Re-decide a waiting task and return the label it then shows.
    async fn label(&self, id: &str) -> String {
        wake(&self.service, &[id]).await;
        self.settle().await;
        self.next(id).await["stateLabel"]
            .as_str()
            .expect("state label")
            .to_owned()
    }

    async fn amend(&self, id: &str, weight: &str) {
        self.request(
            Method::POST,
            &format!("/v1/tasks/{id}/commands"),
            &json!({"amend": brief(Some(weight), QueuePriority::Normal, "Amended")}),
        )
        .await;
        self.settle().await;
    }

    async fn save_slots(&self, heavy: u32, total: u32) {
        let path = "/v1/settings/dispatch";
        let current = self.request(Method::GET, path, &Value::Null).await;
        // The fixture's settings are in memory, so the file still holds defaults.
        let held = self.service.state.lock().await.settings.dispatch.clone();
        let mut value = serde_json::to_value(held.expect("dispatch settings")).expect("value");
        value["heavySlots"] = json!(heavy);
        value["totalSlots"] = json!(total);
        self.request(
            Method::PUT,
            path,
            &json!({"revision": current["revision"], "value": value}),
        )
        .await;
        self.settle().await;
    }

    /// No slot idles while a waiting task fits it.
    async fn assert_no_idle_slot(&self) {
        let state = self.service.state.lock().await;
        let limits = state.settings.dispatch.as_ref().expect("dispatch").slots();
        let occupied = state.store.occupied_slots("").expect("occupied slots");
        assert!(!state.capacity_waiters.is_empty());
        for (_, _, _, id) in &state.capacity_waiters {
            let row = state
                .store
                .row(id)
                .expect("read waiter")
                .expect("waiting task");
            assert!(
                limits.blocks(occupied, row.task.weight()).is_some(),
                "{id} fits {limits:?} with {occupied:?}"
            );
        }
    }
}

/// Scheduler fixtures use persisted tasks and synthetic send records.
async fn project_slots(total: u32) -> (tempfile::TempDir, Service) {
    let (home, service) =
        crate::tests::registry_fixture(nucleus_forge::GitHub::new("fixture").unwrap());
    {
        let mut state = service.state.lock().await;
        state.settings.dispatch = Some(DispatchSettings {
            heavy_slots: total,
            total_slots: total,
            project_default_slots: total,
            ..DispatchSettings::default()
        });
        let projects = &mut state.settings.projects.as_mut().unwrap().projects;
        let first_project = projects.values_mut().next().unwrap();
        let fixture = first_project.clone();
        let mut sibling = fixture.repositories[0].clone();
        sibling.origin = SIBLING_REPO.into();
        first_project.repositories.push(sibling);
        for repository in [SECOND_REPO, THIRD_REPO] {
            let mut project = fixture.clone();
            project.repositories[0].origin = repository.into();
            projects.insert(repository.into(), project);
        }
    }
    (home, service)
}

async fn store_slot_task(
    service: &Service,
    (repository, id, weight): (&str, &str, &str),
    priority: QueuePriority,
) {
    let mut state = service.state.lock().await;
    let task = Task::new(
        Identity {
            id: id.into(),
            reference: id.into(),
            repository: repository.into(),
            base: "main".into(),
            entry: Entry::Brief,
            origin_thread: None,
        },
        brief(Some(weight), priority, "Fixture"),
        None,
    );
    state
        .store
        .create_with_facts(
            &task,
            &crate::event("fixture"),
            nucleus_store::TaskAdmissionFacts::default(),
        )
        .unwrap();
    state
        .observe_wait(&task, Some(WaitReason::Capacity))
        .unwrap();
    state.schedule.park(id);
}

fn record_slot_send(task: &mut Task, observation: &Observation) -> Role {
    task.reconcile(observation);
    task.reserve_grouped_launch(
        observation,
        LaunchInputs {
            scratch: None,
            thread: "fixture-role".into(),
            started_at: 1,
            input: "fixture wire".into(),
        },
        &[3; 32],
        None,
        "fixture-group".into(),
    )
    .unwrap();
    let launch = task.run().unwrap().launch();
    let role = launch.role;
    let instance = launch.instance.clone();
    task.record_send(&instance, 1).unwrap();
    role
}

async fn occupy_worker_slot(service: &Service, id: &str) {
    let row = service.task(id).await.unwrap();
    let mut task = row.task.clone();
    let observation = Observation {
        forge: Observed::Known(Forge::Absent),
        host: Observed::Unknown,
        workspace: Observed::Known(Workspace::Clean(service.fixture().start)),
    };
    assert_eq!(record_slot_send(&mut task, &observation), Role::Worker);
    service
        .save(&row, task, &crate::event("host_send"))
        .await
        .unwrap();
    service.state.lock().await.schedule.park(id);
}

async fn finish_slot_task(service: &Service, id: &str) {
    let row = service.task(id).await.unwrap();
    let mut done = serde_json::to_value(&row.task).unwrap();
    done["phase"] = json!("done");
    done["run"] = Value::Null;
    service
        .save(
            &row,
            serde_json::from_value(done).unwrap(),
            &crate::event("done"),
        )
        .await
        .unwrap();
    service.state.lock().await.schedule.park(id);
}

async fn assert_next_slot(service: &Service, expected: &str) {
    let mut state = service.state.lock().await;
    let due = service
        .take_ready(&mut state, tokio::time::Instant::now(), &BTreeSet::new())
        .unwrap();
    assert_eq!(due.id, expected);
}

#[tokio::test]
async fn a_project_with_no_runs_takes_the_freed_slot_ahead_of_a_project_with_three() {
    let (_home, service) = project_slots(4).await;
    for id in ["running-a", "running-b", "running-c", "blocker"] {
        store_slot_task(&service, (REPOSITORY, id, "normal"), QueuePriority::Normal).await;
        occupy_worker_slot(&service, id).await;
    }
    store_slot_task(
        &service,
        (REPOSITORY, "busy-heavy", "heavy"),
        QueuePriority::Normal,
    )
    .await;
    store_slot_task(
        &service,
        (SECOND_REPO, "idle-normal", "normal"),
        QueuePriority::Normal,
    )
    .await;

    finish_slot_task(&service, "blocker").await;
    assert_next_slot(&service, "idle-normal").await;
}

#[tokio::test]
async fn promoted_work_goes_first_and_a_running_reviewer_counts_toward_its_project() {
    let (_home, service) = project_slots(2).await;
    let head = service.fixture().start;
    let pr = PullRequest {
        url: format!("https://github.com/{SIBLING_REPO}/pull/1"),
        head: head.clone(),
    };
    let mut review = Task::new(
        Identity {
            id: "review".into(),
            reference: "review".into(),
            repository: SIBLING_REPO.into(),
            base: "main".into(),
            entry: Entry::ReviewEntry,
            origin_thread: None,
        },
        brief(Some("normal"), QueuePriority::Normal, "Fixture"),
        Some(pr.clone()),
    );
    let observation = Observation {
        forge: Observed::Known(Forge::Open {
            pr,
            checks: CheckState::Ready,
        }),
        host: Observed::Unknown,
        workspace: Observed::Known(Workspace::Clean(head)),
    };
    assert_eq!(record_slot_send(&mut review, &observation), Role::Reviewer);
    service
        .state
        .lock()
        .await
        .store
        .create_with_facts(
            &review,
            &crate::event("fixture"),
            nucleus_store::TaskAdmissionFacts::default(),
        )
        .unwrap();

    store_slot_task(
        &service,
        (REPOSITORY, "blocker", "normal"),
        QueuePriority::Normal,
    )
    .await;
    occupy_worker_slot(&service, "blocker").await;
    store_slot_task(
        &service,
        (REPOSITORY, "busy-heavy", "heavy"),
        QueuePriority::Normal,
    )
    .await;
    store_slot_task(
        &service,
        (SECOND_REPO, "idle-normal", "normal"),
        QueuePriority::Normal,
    )
    .await;
    store_slot_task(
        &service,
        (REPOSITORY, "busy-promoted", "light"),
        QueuePriority::Promoted,
    )
    .await;

    finish_slot_task(&service, "blocker").await;
    assert_next_slot(&service, "busy-promoted").await;
    occupy_worker_slot(&service, "busy-promoted").await;
    finish_slot_task(&service, "busy-promoted").await;
    assert_next_slot(&service, "idle-normal").await;
}

#[tokio::test]
async fn a_burst_of_free_slots_gives_each_waiting_project_one_run() {
    let (_home, service) = project_slots(3).await;
    for id in ["running-a", "running-b", "running-c"] {
        store_slot_task(&service, (REPOSITORY, id, "normal"), QueuePriority::Normal).await;
        occupy_worker_slot(&service, id).await;
    }
    for (repository, id) in [
        (REPOSITORY, "a-first"),
        (REPOSITORY, "a-next"),
        (SECOND_REPO, "b-first"),
        (SECOND_REPO, "b-next"),
        (THIRD_REPO, "c-first"),
    ] {
        store_slot_task(&service, (repository, id, "normal"), QueuePriority::Normal).await;
    }
    for id in ["running-a", "running-b", "running-c"] {
        finish_slot_task(&service, id).await;
    }
    for id in ["a-first", "b-first", "c-first"] {
        assert_next_slot(&service, id).await;
        occupy_worker_slot(&service, id).await;
    }
    let mut state = service.state.lock().await;
    assert!(
        service
            .take_ready(&mut state, tokio::time::Instant::now(), &BTreeSet::new())
            .is_none()
    );
}

#[tokio::test]
async fn within_one_project_a_freed_slot_goes_to_promoted_then_heaviest_then_oldest() {
    let fleet = fleet((1, 1), 32).await;
    fleet.add("blocker", "normal").await;
    for (id, weight, priority) in [
        ("light-old", "light", QueuePriority::Normal),
        ("normal", "normal", QueuePriority::Normal),
        ("light-promoted", "light", QueuePriority::Promoted),
        ("heavy", "heavy", QueuePriority::Normal),
        ("heavy-newer", "heavy", QueuePriority::Normal),
    ] {
        fleet.admit(id, Some(weight), priority).await;
    }
    fleet.assert_running(&["blocker"]).await;
    assert_eq!(fleet.label("heavy").await, FULL);

    let mut running = "blocker";
    for next in [
        "light-promoted",
        "heavy",
        "heavy-newer",
        "light-old",
        "normal",
    ] {
        fleet.finish(running).await;
        fleet.assert_running(&[next]).await;
        running = next;
    }
}

#[tokio::test]
async fn a_new_slot_goes_to_the_heavy_task_when_every_waiter_wakes() {
    let fleet = fleet((1, 1), 32).await;
    fleet.add("blocker", "normal").await;
    fleet.add("a-light", "light").await;
    fleet.add("b-normal", "normal").await;
    fleet.add("c-heavy", "heavy").await;

    // One heavy slot becomes free beside the running task.
    fleet.save_slots(2, 2).await;
    fleet.assert_running(&["blocker", "c-heavy"]).await;
    fleet.assert_no_idle_slot().await;
}

#[tokio::test]
async fn a_full_heavy_cap_leaves_all_remaining_slots_available() {
    let fleet = fleet((1, 4), 32).await;
    fleet.add("heavy-run", "heavy").await;
    fleet.add("heavy-wait", "heavy").await;
    assert_eq!(fleet.label("heavy-wait").await, WAITING_HEAVY);
    let next = fleet.next("heavy-wait").await;
    assert_eq!(next["wait"], "capacity");
    assert_eq!(next["waitDetail"], WAITING_HEAVY);

    fleet.add("normal-run", "normal").await;
    fleet.add("second-normal", "normal").await;
    fleet.add("light-run", "light").await;
    fleet.add("normal-wait", "normal").await;
    fleet
        .assert_running(&["heavy-run", "light-run", "normal-run", "second-normal"])
        .await;
    assert_eq!(fleet.label("normal-wait").await, FULL);
    assert_eq!(fleet.label("heavy-wait").await, FULL);
    fleet.assert_no_idle_slot().await;

    // A freed slot goes to the fitting waiter even with a heavy task ahead of it.
    fleet.finish("light-run").await;
    fleet
        .assert_running(&["heavy-run", "normal-run", "normal-wait", "second-normal"])
        .await;
    fleet.finish("normal-run").await;
    assert_eq!(fleet.label("heavy-wait").await, WAITING_HEAVY);
    fleet.assert_no_idle_slot().await;
}

#[tokio::test]
async fn a_missing_weight_is_normal() {
    let fleet = fleet((0, 2), 32).await;
    fleet.admit("first", None, QueuePriority::Normal).await;
    fleet.admit("second", None, QueuePriority::Normal).await;
    fleet.assert_running(&["first", "second"]).await;
    assert_eq!(
        fleet.service.task("second").await.unwrap().task.weight(),
        TaskWeight::Normal
    );
}

#[tokio::test]
async fn project_caps_apply_to_a_task_which_fits_its_weight() {
    let fleet = fleet((2, 6), 1).await;
    fleet.add("first", "heavy").await;
    fleet.add("second", "light").await;
    fleet.assert_running(&["first"]).await;
    assert_eq!(fleet.label("second").await, FULL);
}

#[tokio::test]
async fn running_work_is_never_preempted_and_a_new_weight_counts_at_once() {
    let fleet = fleet((1, 2), 32).await;
    fleet.add("first", "heavy").await;
    fleet.add("second", "light").await;
    let held = fleet.running().await;
    fleet.add("third", "heavy").await;
    fleet.add("fourth", "normal").await;
    assert_eq!(fleet.running().await, held);

    // Lowering a limit and making a running task heavier stop nothing.
    fleet.save_slots(0, 1).await;
    assert_eq!(fleet.running().await, held);
    fleet.save_slots(1, 2).await;
    fleet.amend("second", "heavy").await;
    assert_eq!(fleet.running().await, held);
    // Two heavy runs exceed the heavy cap. Normal work still takes the new slot.
    fleet.save_slots(1, 3).await;
    fleet.assert_running(&["first", "fourth", "second"]).await;

    // Running heavy work made light frees the heavy cap for the waiter.
    fleet.finish("fourth").await;
    assert_eq!(fleet.label("third").await, "Waiting for a heavy slot (2/1)");
    fleet.amend("first", "light").await;
    fleet.amend("second", "light").await;
    fleet.assert_running(&["first", "second", "third"]).await;
}

#[tokio::test]
async fn a_restart_ranks_a_heavy_task_beyond_the_first_scan_page() {
    let fleet = fleet((0, 0), 32).await;
    fleet.queue("early-light", "light").await;
    // One scan page holds 32 tasks, so the heavy task is on the next one.
    for number in 0..32 {
        fleet.queue(&format!("filler-{number:02}"), "light").await;
    }
    fleet.queue("late-heavy", "heavy").await;
    fleet.settle().await;
    fleet.assert_running(&[]).await;

    let fleet = fleet.restart((1, 1), |_| {}).await;
    fleet.settle().await;
    fleet.assert_running(&["late-heavy"]).await;
}

#[tokio::test]
async fn a_restart_ranks_a_waiting_heavy_reviewer_before_an_earlier_light_task() {
    let profile = |id: &str, model: &str| -> Profile {
        serde_json::from_value(json!({"id": id, "provider": "codex", "model": model}))
            .expect("profile")
    };
    let (author, reviewer) = (profile("author", "first"), profile("review", "second"));
    let fleet = fleet((0, 0), 32).await;
    fleet.queue("early-light", "light").await;
    // A stored task between its second worker report and the next review. The
    // stopped service never decided either task.
    let (task, binding) = retained_role_task(
        &fleet.service,
        "heavy-review",
        &author,
        &reviewer,
        Role::Reviewer,
        "---\nqueue: {complexity: medium, weight: heavy}\n---\nFix a typo.",
    );
    assert_eq!(task.phase(), Phase::Reviewing);
    assert!(task.run().is_none());
    fleet
        .service
        .state
        .lock()
        .await
        .store
        .create_with_facts(
            &task,
            &crate::event("fixture"),
            nucleus_store::TaskAdmissionFacts::default(),
        )
        .expect("stored reviewer");

    let published = task.pull_request().expect("published pull").clone();
    let mut pull = forge_pull(&published.head);
    pull["head"]["ref"] = json!(binding.branch);
    let checks = forge_checks(&published.head);
    let (forge, forge_server) = serve_forge(
        Router::new()
            .route(
                &format!("/repos/{REPOSITORY}/pulls"),
                get(|| async { Json(Vec::<Value>::new()) }),
            )
            .route(
                &format!("/repos/{REPOSITORY}/pulls/1"),
                get(move || async { Json(pull) }),
            )
            .route("/graphql", post(move || async { Json(checks) })),
    )
    .await;
    let fleet = fleet.restart((1, 1), |service| service.forge = forge).await;
    fleet.settle().await;
    fleet.assert_running(&["heavy-review"]).await;
    let row = fleet.service.task("heavy-review").await.expect("review");
    assert_eq!(
        row.task.run().expect("review run").launch().role,
        Role::Reviewer
    );
    forge_server.abort();
}
