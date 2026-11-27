use serde_json::Value;

use super::*;
use crate::project::{LocalGit, git_gate};

struct ReleaseGit(Arc<git_gate::Gate>);

impl Drop for ReleaseGit {
    fn drop(&mut self) {
        self.0.release();
    }
}

#[tokio::test]
async fn retirement_refuses_a_dispatch_stop_after_admission() {
    interrupted_retirement(true).await;
}

#[tokio::test]
async fn retirement_refuses_a_role_start_after_admission() {
    interrupted_retirement(false).await;
}

async fn interrupted_retirement(stop: bool) {
    let (home, mut service) = fixture(GitHub::new("fixture").unwrap());
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
    let roles = archived_checkout_rows(&binding, &row.task);
    service
        .host
        .fixture_held_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":1,"projects":[],"threads":[],"archivedThreads":roles
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
            if stop {
                service.state.lock().await.settings.dispatch =
                    Some(nucleus_store::DispatchSettings {
                        mode: DispatchMode::Stopped,
                        ..Default::default()
                    });
            } else {
                let mut worker = roles
                    .iter()
                    .find(|thread| thread["id"] == "worker")
                    .unwrap()
                    .clone();
                worker["archivedAt"] = Value::Null;
                worker["status"] = json!("running");
                worker["activeRunId"] = json!("new-run");
                service.host.fixture_held_shell(&json!({
                    "kind":"thread.updated","location":"active","sequence":2,"thread":worker
                }));
            }
        }
        gate.0.release();
        entered.expect("the retirement Git recheck reached its status call");
    };
    let (result, ()) = tokio::join!(
        service.retire_if_idle(&row.task, &binding, &checkout, Some(head)),
        change
    );
    if stop {
        assert!(matches!(result, Ok(Retirement::Deferred)), "{result:?}");
    } else {
        assert!(
            matches!(result, Err(ServiceError::Host(HostError::RowChildBusy))),
            "{result:?}"
        );
    }
    assert_eq!(checkout.observe().unwrap(), Workspace::Clean(head.clone()));
    assert_eq!(
        std::fs::read_dir(service.storage.work().path().join(".trash"))
            .unwrap()
            .count(),
        0
    );
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
                    json!({"_tag":"Exit","requestId":id,"exit":{"_tag":"Success","value":{
                        "schemaVersion":2,"snapshotSequence":5,"projects":[],"threads":rows
                    }}})
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
        Err(ServiceError::Host(HostError::RowChildBusy))
    ));
    assert!(checkout.path().is_dir());
    mode.store(1, Ordering::Relaxed);
    assert!(matches!(
        service.archive_done(&row).await,
        Err(ServiceError::Host(HostError::Uncertain))
    ));
    assert!(checkout.path().is_dir());
    mode.store(2, Ordering::Relaxed);
    assert_eq!(service.archive_done(&row).await.unwrap(), Action::Nothing);
    assert!(!checkout.path().exists());
}
