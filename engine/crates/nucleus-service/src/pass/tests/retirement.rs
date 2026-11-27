use serde_json::Value;

use super::*;
use crate::project::{LocalGit, git_gate};
use crate::tests::archive_snapshot_reply;

struct ReleaseGit(Arc<git_gate::Gate>);

impl Drop for ReleaseGit {
    fn drop(&mut self) {
        self.0.release();
    }
}

#[tokio::test]
async fn retirement_refuses_a_dispatch_stop_after_admission() {
    interrupted_retirement(Interruption::DispatchStop).await;
}

#[tokio::test]
async fn retirement_refuses_a_role_start_after_admission() {
    interrupted_retirement(Interruption::RoleStart).await;
}

#[tokio::test]
async fn retirement_refuses_an_archive_change_after_admission() {
    interrupted_retirement(Interruption::ArchiveChange).await;
}

#[derive(Clone, Copy)]
enum Interruption {
    DispatchStop,
    RoleStart,
    ArchiveChange,
}

async fn interrupted_retirement(interruption: Interruption) {
    let (home, mut service) = fixture(GitHub::new("fixture").unwrap());
    let (host, _archive) = empty_archive_fixture(1).await;
    service.host = host;
    let (row, _) = settled_cleanup_task(&service, home.path(), false).await;
    let git_root = home.path().join("git-retirement");
    std::fs::create_dir(&git_root).unwrap();
    service.git = LocalGit(git_root.clone());
    let head = &service.fixture().start;
    let worktrees = service.worktrees();
    let checkout = worktrees
        .checkout(
            &service.fixture().checkout,
            REPOSITORY,
            &row.task.identity().id,
        )
        .unwrap();
    checkout.allocate(head).unwrap();
    let route = service.project_for(row.task.identity()).await.unwrap();
    let binding = route.binding(&checkout).unwrap();
    let roles = live_checkout_rows(&binding, &row.task);
    service
        .host
        .fixture_held_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":1,"projects":[],"threads":roles
        }}));
    let gate = ReleaseGit(git_gate::install_after(git_root, 1));
    gate.0.only.set("status").unwrap();
    let _task = service.effect(&row).await.unwrap();
    let _project = service.project_writes.read().await;
    let change = async {
        let entered = tokio::time::timeout(Duration::from_secs(3), async {
            while gate.0.entered.load(Ordering::SeqCst) < 2 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        if entered.is_ok() {
            match interruption {
                Interruption::DispatchStop => service.state.lock().await.settings.dispatch =
                    Some(nucleus_store::DispatchSettings {
                        mode: DispatchMode::Stopped,
                        ..Default::default()
                    }),
                Interruption::RoleStart => {
                    let mut worker = roles.iter().find(|thread| thread["id"] == "worker").unwrap().clone();
                    worker["status"] = json!("running");
                    worker["activeRunId"] = json!("new-run");
                    service.host.fixture_held_shell(&json!({
                        "kind":"thread.updated","location":"active","sequence":2,"thread":worker
                    }));
                }
                Interruption::ArchiveChange => service.host.fixture_held_shell(&json!({
                    "kind":"thread.removed","location":"active","sequence":2,"threadId":"nested-child"
                })),
            }
        }
        gate.0.release();
        entered.expect("the retirement Git recheck reached its status call");
    };
    let (result, ()) = tokio::join!(
        service.retire_if_idle(&row.task, &binding, &checkout, Some(head)),
        change
    );
    assert!(
        matches!(
            (interruption, &result),
            (Interruption::DispatchStop, Ok(Retirement::Deferred))
                | (
                    Interruption::RoleStart,
                    Err(ServiceError::Host(HostError::RowChildBusy))
                )
                | (
                    Interruption::ArchiveChange,
                    Err(ServiceError::Host(HostError::Uncertain))
                )
        ),
        "{result:?}"
    );
    assert_eq!(checkout.observe().unwrap(), Workspace::Clean(head.clone()));
    assert_eq!(
        std::fs::read_dir(service.storage.work().path().join(".trash"))
            .unwrap()
            .count(),
        0
    );
}

fn live_checkout_rows(binding: &Binding, task: &Task) -> Vec<Value> {
    let mut rows = archived_checkout_rows(binding, task);
    for row in &mut rows {
        row["archivedAt"] = Value::Null;
    }
    rows
}

#[tokio::test]
async fn an_archived_descendant_blocks_sweep_and_retirement_with_all_bound_rows_visible() {
    let (home, mut service) = fixture(GitHub::new("fixture").unwrap());
    let (row, _) = settled_cleanup_task(&service, home.path(), false).await;
    let head = service.fixture().start.clone();
    let work = service.worktrees();
    let checkout = work
        .checkout(
            &service.fixture().checkout,
            REPOSITORY,
            &row.task.identity().id,
        )
        .unwrap();
    checkout.allocate(&head).unwrap();
    let route = service.project_for(row.task.identity()).await.unwrap();
    let binding = route.binding(&checkout).unwrap();
    let base = checkout.path().to_owned();
    let parent = nucleus_hosts::parent_thread(&base);
    let busy = Arc::new(AtomicBool::new(true));
    let (host, _archive) = native_fixture({
        let busy = Arc::clone(&busy);
        move |request| {
            let (sequence, pending) = if busy.load(Ordering::Relaxed) {
                (5, json!([{"kind":"command","taskId":"background-1"}]))
            } else {
                (6, json!([]))
            };
            archive_snapshot_reply(request, sequence, &[json!({
                "id":"nested-child","projectId":binding.project_id,"branch":binding.branch,
                "worktreePath":binding.worktree_path,"archivedAt":"2026-11-27T12:00:00Z",
                "lineage":{"rootThreadId":parent,"parentThreadId":"worker","relationshipToParent":"subagent"},
                "deletedAt":null,"status":"completed","activeRunId":null,
                "pendingRuntimeRequest":null,"pendingBackgroundTasks":pending
            })])
        }
    }).await;
    service.host = host;
    let work = service.worktrees();
    let checkout = work
        .checkout(
            &service.fixture().checkout,
            REPOSITORY,
            &row.task.identity().id,
        )
        .unwrap();
    let binding = route.binding(&checkout).unwrap();
    service
        .host
        .fixture_held_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":5,"projects":[],"threads":live_checkout_rows(&binding, &row.task)
        }}));
    let _task = service.effect(&row).await.unwrap();
    let _project = service.project_writes.read().await;
    service
        .sweep_terminal_processes(&service.host.fixture_pass(), &row.task, &binding, &checkout)
        .await;
    assert!(
        !service
            .history(&row.task.identity().id, None, 30)
            .await
            .unwrap()
            .iter()
            .any(|event| event.content.kind == "checkout_process_sweep")
    );
    let attempt = || service.retire_if_idle(&row.task, &binding, &checkout, Some(&head));
    assert!(matches!(
        attempt().await,
        Err(ServiceError::Host(HostError::RowChildBusy))
    ));
    assert!(base.is_dir());
    busy.store(false, Ordering::Relaxed);
    service.host.fixture_held_shell(&json!({
        "kind":"thread.removed","location":"active","sequence":6,"threadId":"nested-child"
    }));
    assert_eq!(attempt().await.unwrap(), Retirement::Removed);
    assert!(!base.exists());
}

#[tokio::test]
async fn retirement_requires_archive_or_deletion_evidence_for_omitted_roles() {
    let (home, mut service) = fixture(GitHub::new("fixture").unwrap());
    let (row, _) = settled_cleanup_task(&service, home.path(), false).await;
    let head = service.fixture().start.clone();
    let (forge, _forge) = publish_checkout_forge(head.clone()).await;
    service.forge = forge;
    service.fixture_mut().acp_provider = Some("fixture".into());
    let route = service.project_for(row.task.identity()).await.unwrap();
    let worktrees = service.worktrees();
    let checkout = worktrees
        .checkout(
            &service.fixture().checkout,
            REPOSITORY,
            &row.task.identity().id,
        )
        .unwrap();
    checkout.allocate(&head).unwrap();
    let binding = route.binding(&checkout).unwrap();
    let base = checkout.path().to_owned();
    let roles = archived_checkout_rows(&binding, &row.task);
    let mode = Arc::new(AtomicUsize::new(0));
    let (host, _host) = native_fixture({
        let mode = Arc::clone(&mode);
        move |request| {
            let id = &request["id"];
            let mode = mode.load(Ordering::Relaxed);
            match request["tag"].as_str() {
                Some("orchestration.getArchivedShellSnapshot") => {
                    let mut rows = roles.clone();
                    match mode {
                        0 => {
                            let worker = rows.iter_mut().find(|thread| thread["id"] == "worker").unwrap();
                            worker["pendingBackgroundTasks"] =
                                json!([{"kind":"command","taskId":"background-1"}]);
                        }
                        1 | 2 => rows.retain(|thread| thread["id"] != "worker"),
                        _ => unreachable!(),
                    }
                    archive_snapshot_reply(request, 5, &rows)
                }
                Some("orchestration.subscribeThread") => {
                    assert_eq!(request["payload"]["threadId"], "worker");
                    let cause = if mode == 2 {
                        json!({"name":"ProjectionStoreThreadNotFoundError",
                            "message":"No orchestration projection exists for thread worker."})
                    } else {
                        json!({"name":"OrchestratorProjectionError","message":"Temporarily unavailable"})
                    };
                    json!({"_tag":"Exit","requestId":id,"exit":{"_tag":"Failure","cause":[
                        {"_tag":"Fail","error":{"_tag":"OrchestrationV2GetThreadProjectionError",
                            "threadId":"worker","cause":cause}}
                    ]}})
                }
                tag => panic!("unexpected native request: {tag:?}"),
            }
        }
    }).await;
    service.host = host;
    service
        .host
        .fixture_held_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":5,"projects":[],"threads":[]
        }}));
    assert!(matches!(
        service.archive_done(&row).await,
        Err(ServiceError::CheckoutRetained(cause)) if cause.contains("every task thread is idle")
    ));
    assert!(base.is_dir());
    mode.store(1, Ordering::Relaxed);
    assert!(matches!(
        service.archive_done(&row).await,
        Err(ServiceError::CheckoutRetained(cause)) if cause.contains("idle or gone")
    ));
    assert!(base.is_dir());
    mode.store(2, Ordering::Relaxed);
    assert_eq!(service.archive_done(&row).await.unwrap(), Action::Nothing);
    assert!(!base.exists());
}
