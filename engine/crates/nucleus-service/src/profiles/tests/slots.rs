//! Task weight slots (Spec 070 ruling 63): admitted tasks, real launches and
//! the label `nucleus next` returns.

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

struct Fleet {
    service: Arc<Service>,
    api: Router,
    servers: [tokio::task::JoinHandle<()>; 2],
    _home: tempfile::TempDir,
}

impl Drop for Fleet {
    fn drop(&mut self) {
        for server in &self.servers {
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

/// A service with these heavy, normal and light slots, launching on a fixture host.
async fn fleet((heavy, normal, light): (u32, u32, u32), project: u32) -> Fleet {
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
    {
        let mut state = service.state.lock().await;
        state.settings.dispatch = Some(DispatchSettings {
            heavy_slots: heavy,
            normal_slots: normal,
            light_slots: light,
            project_default_slots: project,
            ..DispatchSettings::default()
        });
        state.settings.profiles = Some(Arc::new(
            serde_json::from_value(json!({"profiles": [
                {"name":"Worker","selection":{"id":"worker","provider":"codex","model":"first"}}
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
        servers: [forge_server, native_server],
        _home: home,
    }
}

impl Fleet {
    async fn admit(&self, id: &str, weight: Option<&str>, priority: QueuePriority) {
        self.service
            .admit(
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
        let row = self.service.task(id).await.expect("running task");
        let mut done = serde_json::to_value(&row.task).expect("task value");
        done["phase"] = json!("done");
        done["run"] = Value::Null;
        self.service
            .save(
                &row,
                serde_json::from_value(done).expect("finished task"),
                &crate::event("done"),
            )
            .await
            .expect("finish task");
        self.service.state.lock().await.schedule.park(id);
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

    async fn save_slots(&self, heavy: u32, normal: u32, light: u32) {
        let path = "/v1/settings/dispatch";
        let current = self.request(Method::GET, path, &Value::Null).await;
        // The fixture's settings are in memory, so the file still holds defaults.
        let held = self.service.state.lock().await.settings.dispatch.clone();
        let mut value = serde_json::to_value(held.expect("dispatch settings")).expect("value");
        value["heavySlots"] = json!(heavy);
        value["normalSlots"] = json!(normal);
        value["lightSlots"] = json!(light);
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
        for (weight, _, _, id) in &state.capacity_waiters {
            assert!(
                limits.blocks(occupied, *weight).is_some(),
                "{id} fits {limits:?} with {occupied:?}"
            );
        }
    }
}

#[tokio::test]
async fn a_freed_slot_goes_to_the_heaviest_waiting_task_then_promoted_then_oldest() {
    let fleet = fleet((1, 0, 0), 32).await;
    fleet.add("blocker", "normal").await;
    for (id, weight, priority) in [
        ("light", "light", QueuePriority::Promoted),
        ("normal-old", "normal", QueuePriority::Normal),
        ("normal-promoted", "normal", QueuePriority::Promoted),
        ("heavy", "heavy", QueuePriority::Normal),
    ] {
        fleet.admit(id, Some(weight), priority).await;
    }
    fleet.assert_running(&["blocker"]).await;
    assert_eq!(fleet.label("heavy").await, FULL);

    let mut running = "blocker";
    for next in ["heavy", "normal-promoted", "normal-old", "light"] {
        fleet.finish(running).await;
        fleet.assert_running(&[next]).await;
        running = next;
    }
}

#[tokio::test]
async fn a_new_slot_goes_to_the_heavy_task_when_every_waiter_wakes() {
    let fleet = fleet((1, 0, 0), 32).await;
    fleet.add("blocker", "normal").await;
    fleet.add("a-light", "light").await;
    fleet.add("b-normal", "normal").await;
    fleet.add("c-heavy", "heavy").await;

    // One heavy slot becomes free beside the running task.
    fleet.save_slots(2, 0, 0).await;
    fleet.assert_running(&["blocker", "c-heavy"]).await;
    fleet.assert_no_idle_slot().await;
}

#[tokio::test]
async fn nested_caps_hold_only_the_weights_which_do_not_fit() {
    let fleet = fleet((1, 1, 1), 32).await;
    fleet.add("heavy-run", "heavy").await;
    fleet.add("heavy-wait", "heavy").await;
    assert_eq!(fleet.label("heavy-wait").await, WAITING_HEAVY);
    let next = fleet.next("heavy-wait").await;
    assert_eq!(next["wait"], "capacity");
    assert_eq!(next["waitDetail"], WAITING_HEAVY);

    // The heavy cap is full; normal and light tasks still start.
    fleet.add("normal-run", "normal").await;
    fleet.assert_running(&["heavy-run", "normal-run"]).await;
    // Heavy and normal together are full; a light task still has a slot.
    fleet.add("normal-wait", "normal").await;
    assert_eq!(
        fleet.label("normal-wait").await,
        "Waiting for a normal slot (2/2)"
    );
    fleet.assert_no_idle_slot().await;
    fleet.add("light-run", "light").await;
    fleet
        .assert_running(&["heavy-run", "light-run", "normal-run"])
        .await;
    // With every slot in use the wait is plain capacity again.
    assert_eq!(fleet.label("normal-wait").await, FULL);
    assert_eq!(fleet.label("heavy-wait").await, FULL);

    // The light slot frees: neither waiter may use it.
    fleet.finish("light-run").await;
    fleet.assert_running(&["heavy-run", "normal-run"]).await;
    assert_eq!(fleet.label("heavy-wait").await, WAITING_HEAVY);
    fleet.assert_no_idle_slot().await;
}

#[tokio::test]
async fn light_tasks_use_any_slot() {
    let fleet = fleet((1, 1, 1), 32).await;
    for id in ["light-1", "light-2", "light-3", "light-4"] {
        fleet.add(id, "light").await;
    }
    fleet
        .assert_running(&["light-1", "light-2", "light-3"])
        .await;
    assert_eq!(fleet.label("light-4").await, FULL);
}

#[tokio::test]
async fn a_missing_weight_is_normal() {
    let fleet = fleet((1, 0, 1), 32).await;
    fleet.admit("first", None, QueuePriority::Normal).await;
    fleet.admit("second", None, QueuePriority::Normal).await;
    fleet.assert_running(&["first"]).await;
    assert_eq!(
        fleet.label("second").await,
        "Waiting for a normal slot (1/1)"
    );
    assert_eq!(
        fleet.service.task("second").await.unwrap().task.weight(),
        TaskWeight::Normal
    );
    fleet.add("small", "light").await;
    fleet.assert_running(&["first", "small"]).await;
}

#[tokio::test]
async fn project_caps_apply_to_a_task_which_fits_its_weight() {
    let fleet = fleet((2, 2, 2), 1).await;
    fleet.add("first", "heavy").await;
    fleet.add("second", "light").await;
    fleet.assert_running(&["first"]).await;
    assert_eq!(fleet.label("second").await, FULL);
}

#[tokio::test]
async fn running_work_is_never_preempted_and_a_new_weight_counts_at_once() {
    let fleet = fleet((1, 1, 0), 32).await;
    fleet.add("first", "heavy").await;
    fleet.add("second", "light").await;
    let held = fleet.running().await;
    fleet.add("third", "heavy").await;
    fleet.add("fourth", "normal").await;
    assert_eq!(fleet.running().await, held);

    // Lowering a limit and making a running task heavier stop nothing.
    fleet.save_slots(0, 1, 0).await;
    assert_eq!(fleet.running().await, held);
    fleet.save_slots(1, 1, 0).await;
    fleet.amend("second", "heavy").await;
    assert_eq!(fleet.running().await, held);
    // Two heavy runs fill heavy and normal, so the new slot serves neither waiter.
    fleet.save_slots(1, 1, 1).await;
    assert_eq!(fleet.running().await, held);

    // A waiting task made light takes the free slot.
    fleet.amend("fourth", "light").await;
    fleet.assert_running(&["first", "fourth", "second"]).await;

    // Running heavy work made light frees the heavy cap for the waiter.
    fleet.finish("fourth").await;
    assert_eq!(fleet.label("third").await, "Waiting for a heavy slot (2/1)");
    fleet.amend("first", "light").await;
    fleet.amend("second", "light").await;
    fleet.assert_running(&["first", "second", "third"]).await;
}
