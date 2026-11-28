mod merge_cases;
mod provider_helpers;
mod retirement;
mod revisions;

use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

use axum::{
    Json, Router,
    http::{StatusCode, header::RETRY_AFTER},
    response::IntoResponse,
    routing::{get, post, put},
};
use nucleus_core::{Authority, Command, Entry, PullRequest, Review};
use nucleus_forge::GitHub;
use nucleus_hosts::{Dispatch, RunRequest};
use serde_json::json;

use super::*;
use crate::tests::{
    Due, REPOSITORY, archived_checkout_rows, code_task_at_merge, empty_archive_fixture, fixture,
    forge_checks, forge_fixture, forge_pull, native_fixture, registry_fixture, reservation,
    serve_forge,
};

async fn cancelled_cleanup_task(service: &Service) -> TaskRow {
    let task = Task::new(
        nucleus_core::Identity {
            id: "orphan-test".into(),
            reference: "orphan-test".into(),
            repository: REPOSITORY.into(),
            base: "main".into(),
            entry: Entry::Brief,
            origin_thread: None,
        },
        "Synthetic cleanup".into(),
        None,
    );
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
    let id = &task.identity().id;
    service
        .command(
            id,
            &Authority::Operator {
                actor: "fixture".into(),
            },
            Command::Cancel,
        )
        .await
        .unwrap();
    service.task(id).await.unwrap()
}

fn settle_both_reviewers(
    task: &mut Task,
    observation: &mut Observation,
    head: &Head,
    credential: &[u8; 32],
    scratch: &Path,
) {
    // A task upgraded during this reviewer carries the old worker path in settled_scratch.
    let mut saved = serde_json::to_value(&*task).unwrap();
    saved["threads"]
        .as_object_mut()
        .unwrap()
        .remove("earlier_scratch");
    saved["threads"]["settled_scratch"] = serde_json::json!(scratch);
    let mut upgraded: Task = serde_json::from_value(saved).unwrap();
    let instance = task.run().unwrap().launch().instance.clone();
    observation.host = Observed::Known(Host::Current {
        instance: instance.clone(),
        state: RunState::Ended,
    });
    for row in [&mut *task, &mut upgraded] {
        row.record_report(
            &instance,
            credential,
            Report::Review {
                head: head.clone(),
                decision: nucleus_core::Review::Approve,
                summary: "Reviewed".into(),
                finding_titles: vec![],
            },
        )
        .unwrap();
        assert_eq!(row.reconcile(observation), Action::Advance(Phase::Merging));
    }
    assert_eq!(
        upgraded.earlier_run_scratch().collect::<Vec<_>>(),
        task.earlier_run_scratch().collect::<Vec<_>>()
    );
}

async fn settled_cleanup_task(service: &Service, home: &Path, legacy: bool) -> (TaskRow, PathBuf) {
    use std::os::unix::fs::DirBuilderExt as _;

    let scratch = home.canonicalize().unwrap().join("assigned-scratch");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&scratch)
        .unwrap();
    let id = "settled-custody";
    let head = service.fixture().start.clone();
    let (template, _, mut observation) = reservation(id, Entry::Brief, &head);
    let mut task = Task::new(template.identity().clone(), "Scoped fixture".into(), None);
    task.reconcile(&observation);
    let credential = task
        .reserve_grouped_launch(
            &observation,
            LaunchInputs {
                thread: "worker".into(),
                started_at: 1,
                input: "fixture".into(),
                scratch: Some(scratch.clone()),
            },
            &[9; 32],
            None,
            "fixture-group".into(),
        )
        .unwrap();
    let instance = task.run().unwrap().launch().instance.clone();
    let pr = PullRequest {
        url: "https://github.com/example/test/pull/1".into(),
        head: head.clone(),
    };
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
        state: RunState::Ended,
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Reviewing)
    );
    observation.host = Observed::Unknown;
    let reviewer_scratch = home.canonicalize().unwrap().join("reviewer-scratch");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&reviewer_scratch)
        .unwrap();
    let key = task
        .reserve_grouped_launch(
            &observation,
            LaunchInputs {
                thread: "reviewer".into(),
                started_at: 2,
                input: "fixture".into(),
                scratch: Some(reviewer_scratch),
            },
            &[9; 32],
            None,
            "fixture-group".into(),
        )
        .unwrap();
    settle_both_reviewers(&mut task, &mut observation, &head, key.as_bytes(), &scratch);
    task.command(
        Command::Cancel,
        &Authority::Operator {
            actor: "fixture".into(),
        },
        &observation,
    )
    .unwrap();
    let scratch = if legacy {
        legacy_scratch(service, &mut task, &scratch)
    } else {
        scratch
    };
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
    let row = service.task(id).await.unwrap();
    assert!(row.task.run().is_none());
    (row, scratch)
}

fn legacy_scratch(service: &Service, task: &mut Task, scratch: &Path) -> PathBuf {
    let instance = task.earlier_run_scratch().next().unwrap().0;
    let derived = service
        .storage
        .scratch()
        .path()
        .join(scratch::relative_path(&instance));
    std::fs::create_dir_all(derived.parent().unwrap()).unwrap();
    std::fs::rename(scratch, &derived).unwrap();
    let mut saved = serde_json::to_value(&*task).unwrap();
    saved["threads"]
        .as_object_mut()
        .unwrap()
        .remove("earlier_scratch");
    saved["threads"]
        .as_object_mut()
        .unwrap()
        .remove("settled_scratch");
    *task = serde_json::from_value(saved).unwrap();
    derived
}

struct ProtectedTree(Vec<u32>);

impl Drop for ProtectedTree {
    fn drop(&mut self) {
        for pid in self.0.iter().rev() {
            let _ = std::process::Command::new("/bin/kill")
                .args(["-KILL", &pid.to_string()])
                .output();
        }
    }
}

async fn protected_host_tree(dir: &Path) -> ProtectedTree {
    // The orphan root contains the described host and its child.
    let script = r#"/bin/sh -c '/bin/sh -c '\''/bin/sleep 60 >/dev/null 2>&1 & echo "$PPID $$ $!"; exec >/dev/null 2>&1; wait'\'' & exec >/dev/null 2>&1; wait' </dev/null &"#;
    let output = tokio::process::Command::new("/bin/sh")
        .args(["-c", script])
        .current_dir(dir)
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    let pids: Vec<u32> = std::str::from_utf8(&output.stdout)
        .unwrap()
        .split_whitespace()
        .map(|pid| pid.parse().unwrap())
        .collect();
    assert_eq!(pids.len(), 3);
    let tree = ProtectedTree(pids);
    for (pid, parent) in [
        (tree.0[0], 1),
        (tree.0[1], tree.0[0]),
        (tree.0[2], tree.0[1]),
    ] {
        let output = std::process::Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "ppid="])
            .output()
            .unwrap();
        assert_eq!(
            std::str::from_utf8(&output.stdout).unwrap().trim(),
            parent.to_string()
        );
    }
    tree
}

#[tokio::test]
async fn terminal_cleanup_stops_only_the_checkout_orphan_tree() {
    exercise_terminal_orphan_cleanup(
        false,
        false,
        true,
        Some(nucleus_store::DispatchSettings::default()),
    )
    .await;
}

#[tokio::test]
async fn terminal_cleanup_stops_only_the_settled_scratch_orphan_tree() {
    exercise_terminal_orphan_cleanup(
        true,
        false,
        false,
        Some(nucleus_store::DispatchSettings::default()),
    )
    .await;
}

#[tokio::test]
async fn terminal_cleanup_handles_pre_upgrade_scratch() {
    exercise_terminal_orphan_cleanup(
        true,
        true,
        false,
        Some(nucleus_store::DispatchSettings::default()),
    )
    .await;
}

#[tokio::test]
async fn terminal_cleanup_runs_when_dispatch_was_never_configured() {
    exercise_terminal_orphan_cleanup(false, false, false, None).await;
}

async fn exercise_terminal_orphan_cleanup(
    in_scratch: bool,
    legacy: bool,
    host_tree: bool,
    dispatch: Option<nucleus_store::DispatchSettings>,
) {
    let (home, mut service) = registry_fixture(GitHub::new("fixture").unwrap());
    service.set_fixture_acp_provider(Some("fixture"));
    service.state.lock().await.settings.dispatch = dispatch;
    let (terminal, scratch) = if in_scratch {
        let (row, scratch) = settled_cleanup_task(&service, home.path(), legacy).await;
        (row, Some(scratch))
    } else {
        (cancelled_cleanup_task(&service).await, None)
    };
    let id = &terminal.task.identity().id;
    assert_eq!(terminal.task.phase(), Phase::Cancelled);
    let base = {
        let work = service.worktrees();
        let checkout = work
            .checkout(&service.fixture().checkout, REPOSITORY, id)
            .unwrap();
        checkout.allocate(&service.fixture().start).unwrap();
        checkout.path().to_owned()
    };
    std::fs::write(base.join("unpublished"), "retain").unwrap();
    let spawn = |dir: &Path| {
        tokio::process::Command::new("/bin/sleep")
            .arg("30")
            .current_dir(dir)
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    };
    let orphan_dir = scratch.as_deref().unwrap_or(&base);
    let protected = if host_tree {
        Some(protected_host_tree(orphan_dir).await)
    } else {
        None
    };
    let (native, _archive) = empty_archive_fixture(1).await;
    service.host = match &protected {
        Some(tree) => crate::tests::described_native_fixture(native, home.path(), tree.0[1]),
        None => crate::tests::verified_native_fixture(native, home.path()),
    };
    assert!(
        service.host.runtime_identity().is_some(),
        "fixture native runtime identity"
    );
    let route = service.project_for(terminal.task.identity()).await.unwrap();
    let branch = base.file_name().unwrap().to_str().unwrap();
    let binding = route.thread_binding(&base, branch).unwrap();
    service
        .host
        .fixture_held_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":1,"projects":[],"threads":[],
            "archivedThreads":archived_checkout_rows(&binding, &terminal.task)
        }}));
    let mut host_child = spawn(orphan_dir);
    let mut outside = spawn(home.path());
    // The orphan runs a script from its root directory, so its argv names the task's own code.
    // The launching shell exits. One child handles TERM and the orphan root and second child ignore it.
    let orphan = orphan_dir.join("orphan.sh");
    std::fs::write(
        &orphan,
        r#"/bin/sleep 60 >/dev/null 2>&1 & soft=$!; trap "" TERM; /bin/sleep 60 >/dev/null 2>&1 & echo "$$ $! $soft"; exec >/dev/null 2>&1; wait"#,
    )
    .unwrap();
    let script = format!("/bin/sh '{}' </dev/null &", orphan.display());
    let output = tokio::process::Command::new("/bin/sh")
        .args(["-c", &script])
        .current_dir(orphan_dir)
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    let pids: Vec<u32> = std::str::from_utf8(&output.stdout)
        .unwrap()
        .split_whitespace()
        .map(|pid| pid.parse().unwrap())
        .collect();
    assert_eq!(pids.len(), 3);
    // Orphans must pass the scan's settle margin before closeout reads them.
    tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
    for _ in 0..2 {
        let outcome = service.archive_done(&terminal).await;
        assert!(
            matches!(&outcome, Err(ServiceError::CheckoutRetained(s)) if s.contains("retained")),
            "{outcome:?}"
        );
    }
    let history = service.history(id, None, 25).await.unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|entry| entry.content.kind == "checkout_process_sweep")
            .count(),
        1
    );
    assert_cleanup_history(&service, id, &pids, protected.as_ref()).await;
    assert!(base.join("unpublished").exists());
    assert!(host_child.try_wait().unwrap().is_none());
    assert!(outside.try_wait().unwrap().is_none());
    host_child.kill().await.unwrap();
    outside.kill().await.unwrap();
}

async fn assert_cleanup_history(
    service: &Service,
    id: &str,
    pids: &[u32],
    protected: Option<&ProtectedTree>,
) {
    let history = service.history(id, None, 25).await.unwrap();
    let sent = |pid: u32, signal: &str| {
        history
            .iter()
            .filter(|e| e.content.kind == "checkout_process_result")
            .any(|e| {
                let detail: serde_json::Value = serde_json::from_str(&e.content.detail).unwrap();
                detail["signal"] == signal
                    && detail["results"].as_array().unwrap().iter().any(|entry| {
                        entry["process"]["pid"].as_u64() == Some(u64::from(pid))
                            && entry["outcome"] == "sent"
                            && entry["process"]["command"]
                                .as_str()
                                .is_some_and(|name| !name.is_empty())
                    })
            })
    };
    for (index, &pid) in pids.iter().enumerate() {
        assert!(sent(pid, "SIGTERM"), "history: {history:?}");
        assert_eq!(sent(pid, "SIGKILL"), index < 2);
        let probe = tokio::process::Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "stat="])
            .output()
            .await
            .unwrap();
        assert!(
            probe.stdout.is_empty()
                || String::from_utf8_lossy(&probe.stdout)
                    .trim()
                    .starts_with('Z')
        );
    }
    if let Some(tree) = protected {
        for &pid in &tree.0 {
            assert!(!sent(pid, "SIGTERM"));
            assert!(!sent(pid, "SIGKILL"));
            assert!(
                std::process::Command::new("/bin/kill")
                    .args(["-0", &pid.to_string()])
                    .status()
                    .unwrap()
                    .success()
            );
        }
    }
}

/// A forge that reports the checkout's branch as published at `head`, so archive reaches retirement.
async fn publish_checkout_forge(head: nucleus_core::Head) -> (GitHub, tokio::task::JoinHandle<()>) {
    let (main, branch, single) = (head.clone(), head.clone(), head);
    crate::tests::serve_forge(
        axum::Router::new()
            .route(
                &format!("/repos/{REPOSITORY}/branches/main"),
                axum::routing::get(move || {
                    let main = main.clone();
                    async move { axum::Json(json!({"name":"main","commit":{"sha":main}})) }
                }),
            )
            .route(
                &format!("/repos/{REPOSITORY}/branches"),
                axum::routing::get(move || {
                    let branch = branch.clone();
                    async move {
                        axum::Json(vec![
                            json!({"name":"ns-orphan-test","commit":{"sha":branch}}),
                        ])
                    }
                }),
            )
            .route(
                &format!("/repos/{REPOSITORY}/branches/ns-orphan-test"),
                axum::routing::get(move || {
                    let single = single.clone();
                    async move {
                        axum::Json(json!({"name":"ns-orphan-test","commit":{"sha":single}}))
                    }
                }),
            )
            .route(
                "/graphql",
                axum::routing::post(|| async {
                    axum::Json(json!({"data":{"repository":{"pullRequests":{"totalCount":0}}}}))
                }),
            ),
    )
    .await
}

#[cfg(target_os = "macos")]
async fn trash_cwd_clear(pid: u32, trash: &Path) -> bool {
    let command = |path, args: &[&str]| {
        let mut command = tokio::process::Command::new(path);
        command.env("LC_ALL", "C").env("TZ", "UTC").args(args);
        command
    };
    let pid_arg = pid.to_string();
    let cwd = command(
        "/usr/sbin/lsof",
        &["-a", "-p", &pid_arg, "-d", "cwd", "-n", "-P", "-F0pfn"],
    )
    .output()
    .await
    .unwrap();
    let ps = command("/bin/ps", &["-p", &pid_arg, "-o", "pid=,ppid=,uid=,stat="])
        .output()
        .await
        .unwrap();
    assert!(cwd.status.success() && ps.status.success());
    assert!(String::from_utf8_lossy(&cwd.stdout).contains(trash.to_str().unwrap()));
    let census = nucleus_hosts::TrashCensus::from_fixture_rows(&cwd.stdout, &ps.stdout).unwrap();
    census.can_remove(trash).await
}

#[tokio::test]
async fn terminal_cleanup_leaves_a_shared_service_running_in_trash() {
    let (home, mut service) = registry_fixture(GitHub::new("fixture").unwrap());
    let head = service.fixture().start.clone();
    let (forge, _server) = publish_checkout_forge(head).await;
    service.forge = forge;
    let (native, _archive) = empty_archive_fixture(1).await;
    service.host = crate::tests::verified_native_fixture(native, home.path());
    service.set_fixture_acp_provider(Some("fixture"));
    let terminal = cancelled_cleanup_task(&service).await;
    let id = &terminal.task.identity().id;
    let work = service.worktrees();
    let checkout = work
        .checkout(&service.fixture().checkout, REPOSITORY, id)
        .unwrap();
    checkout.allocate(&service.fixture().start).unwrap();
    let route = service.project_for(terminal.task.identity()).await.unwrap();
    let binding = route.binding(&checkout).unwrap();
    service
        .host
        .fixture_held_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":1,"projects":[],"threads":[],
            "archivedThreads":archived_checkout_rows(&binding, &terminal.task)
        }}));
    let base = checkout.path();
    // The launching shell exits, so sleep is orphaned with its cwd in the checkout. Its argv names no path.
    let output = tokio::process::Command::new("/bin/sh")
        .args(["-c", "/bin/sleep 60 >/dev/null 2>&1 & echo $!"])
        .current_dir(base)
        .output()
        .await
        .unwrap();
    let pid: u32 = std::str::from_utf8(&output.stdout)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    // Orphans must pass the scan's settle margin before closeout reads them.
    tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
    let outcome = service.archive_done(&terminal).await;
    let alive = tokio::process::Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "stat="])
        .output()
        .await
        .unwrap();
    let history = service.history(id, None, 25).await.unwrap();
    let trash_root = service.storage.work().path().join(".trash");
    let trash = std::fs::read_dir(trash_root)
        .ok()
        .and_then(|mut entries| entries.next())
        .and_then(Result::ok)
        .map(|entry| entry.path());
    #[cfg(target_os = "macos")]
    let can_remove = trash_cwd_clear(pid, trash.as_deref().expect("retired checkout")).await;
    tokio::process::Command::new("/bin/kill")
        .arg(pid.to_string())
        .status()
        .await
        .unwrap();
    assert_eq!(outcome.unwrap(), Action::Nothing);
    assert!(trash.is_some());
    #[cfg(target_os = "macos")]
    assert!(!can_remove);
    assert!(
        !String::from_utf8_lossy(&alive.stdout).trim().is_empty(),
        "the external service must keep running"
    );
    let retained = history
        .iter()
        .filter(|e| e.content.kind == "checkout_process_retained")
        .any(|e| {
            let detail: serde_json::Value = serde_json::from_str(&e.content.detail).unwrap();
            detail["processes"].as_array().unwrap().iter().any(|entry| {
                entry["pid"].as_u64() == Some(u64::from(pid))
                    && entry["command"]
                        .as_str()
                        .is_some_and(|name| !name.is_empty())
            })
        });
    assert!(
        retained,
        "the retained process must be recorded with its PID"
    );
    assert!(
        !history
            .iter()
            .any(|e| e.content.kind == "checkout_process_result"),
        "no signal may be sent to a retained service"
    );
    assert!(!base.exists());
}

#[tokio::test]
async fn retirement_requires_running_dispatch_quiet_shell_and_published_git_head() {
    let (_home, mut service) = registry_fixture(GitHub::new("fixture").unwrap());
    let (native, _archive) = empty_archive_fixture(1).await;
    service.host = native.with_quiet_fixture_processes();
    let head = service.fixture().start.clone();
    let (forge, _server) = publish_checkout_forge(head.clone()).await;
    service.forge = forge;
    service.set_fixture_acp_provider(Some("fixture"));
    let row = cancelled_cleanup_task(&service).await;
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
    let parent = nucleus_hosts::parent_thread(checkout.path());
    let mut child = json!({
        "id":"nested-child", "projectId":binding.project_id,
        "branch":binding.branch, "worktreePath":binding.worktree_path,
        "lineage":{"rootThreadId":parent,"parentThreadId":"worker","relationshipToParent":"subagent"},
        "status":"running", "activeRunId":"active-run",
        "pendingRuntimeRequest":null,"pendingBackgroundTasks":[]
    });
    let shell = |child: &serde_json::Value| {
        service.host.fixture_held_shell(&json!({
            "kind":"snapshot","snapshot":{"snapshotSequence":1,"projects":[],"threads":[child],
                "archivedThreads":archived_checkout_rows(&binding, &row.task)}
        }));
    };
    shell(&child);
    assert!(matches!(
        service.archive_done(&row).await,
        Err(ServiceError::CheckoutRetained(cause)) if cause.contains("every task thread is idle")
    ));
    assert!(checkout.path().exists());

    child["status"] = json!("completed");
    child["activeRunId"] = serde_json::Value::Null;
    shell(&child);
    service.state.lock().await.settings.dispatch = Some(nucleus_store::DispatchSettings {
        mode: DispatchMode::Paused,
        ..Default::default()
    });
    assert!(matches!(
        service.archive_done(&row).await,
        Err(ServiceError::CheckoutRetained(_))
    ));
    assert!(checkout.path().exists());
    service.state.lock().await.settings.dispatch = None;

    let draft = checkout.path().join("unpublished");
    std::fs::write(&draft, "keep this").unwrap();
    assert!(matches!(
        service.archive_done(&row).await,
        Err(ServiceError::CheckoutRetained(_))
    ));
    assert_eq!(std::fs::read_to_string(&draft).unwrap(), "keep this");
    std::fs::remove_file(&draft).unwrap();

    crate::tests::create_fixture_commit(checkout.path(), "Local closeout commit");
    assert!(matches!(
        service.archive_done(&row).await,
        Err(ServiceError::CheckoutRetained(_))
    ));
    assert!(checkout.path().exists());
    let Workspace::Clean(published) = checkout.observe().unwrap() else {
        panic!("fixture checkout must be clean");
    };
    let base = checkout.path().to_owned();
    let (forge, _published_server) = publish_checkout_forge(published).await;
    service.forge = forge;

    assert_eq!(service.archive_done(&row).await.unwrap(), Action::Nothing);
    assert!(!base.exists());
    assert_eq!(
        service
            .host
            .host_calls()
            .get("orchestration.getArchivedShellSnapshot"),
        Some(&4)
    );
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "one fixture trace covers a complete lifecycle"
)]
async fn task_add_pins_worker_lane_text_and_resolves_brief_prerequisites() {
    use nucleus_store::planning::{LaneDocument, WriteAt};
    let (_home, mut service) = fixture(GitHub::new("fixture").unwrap());
    let root = service.fixture().checkout.clone();
    let runs = Arc::new(std::sync::Mutex::new(
        crate::profiles::tests::NativeRuns::default(),
    ));
    let (host, native_server) = native_fixture(move |request| {
        crate::profiles::tests::native_response(request, &root, &mut runs.lock().unwrap())
    })
    .await;
    service.host = host;
    let project = service.fixture();
    let lane_text = "Use the two-project fixture for acceptance.";
    let key = "product";
    {
        let mut state = service.state.lock().await;
        state.settings.projects = Some(serde_json::from_value(json!({"projects": {
            (key): {"name":"Product", "archived":false, "repositories":[
                {"origin":REPOSITORY, "base":"main", "path":project.checkout, "hostProject":project.host_project}
            ]}
        }})).unwrap());
        state
            .store
            .put_lane(
                key,
                "design",
                0,
                LaneDocument {
                    title: "Design".into(),
                    aim: "Release slice".into(),
                    document: lane_text.into(),
                },
                WriteAt {
                    actor: "planner",
                    at_ms: 1,
                },
            )
            .unwrap();
    }
    let owner = Authority::Operator {
        actor: "fixture".into(),
    };
    let scope = crate::ControllerScope::default();
    let add = |id: &str, fields: &str| {
        let input = serde_json::from_value(json!({"id":id,
            "brief":format!("---\nqueue:\n  complexity: medium\n  {fields}\n---\nFixture task")
        }))
        .unwrap();
        service.add_planned_task(Some(key), input, &owner, &scope)
    };
    let row = add("pinned", "laneDocuments: [design]").await.unwrap();
    let dependent = add("follows", "dependsOn: ['nucleus-fixture#1']")
        .await
        .unwrap();
    assert!(service.dependencies_blocked(&dependent).await.unwrap());

    let workspace = service.worktrees();
    let checkout = workspace
        .checkout(&project.checkout, REPOSITORY, "pinned")
        .unwrap();
    let observation = Observation {
        host: Observed::Unknown,
        forge: Observed::Known(Forge::Absent),
        workspace: Observed::Known(Workspace::Absent),
    };
    let mut working = row.task.clone();
    assert_eq!(
        working.reconcile(&observation),
        Action::Advance(Phase::Working)
    );
    let working = service
        .save(&row, working, &event("advanced"))
        .await
        .unwrap();
    crate::profiles::tests::publish_parent_shell(&service).await;
    let first = Box::pin(service.reserve(
        &working,
        &checkout,
        observation.clone(),
        Role::Worker,
        Launch::Create,
        &service.host.fixture_pass(),
    ))
    .await
    .unwrap();
    if first == Action::Wait(WaitReason::Starting) {
        crate::profiles::tests::publish_parent_shell(&service).await;
        Box::pin(service.reserve(
            &working,
            &checkout,
            observation,
            Role::Worker,
            Launch::Create,
            &service.host.fixture_pass(),
        ))
        .await
        .unwrap();
    }
    let pinned = service.task("pinned").await.unwrap();
    let launch = pinned.task.run().unwrap().launch();
    let path = launch
        .scratch
        .as_ref()
        .unwrap()
        .join("lane-documents/design.md");
    assert_eq!(std::fs::read_to_string(path).unwrap(), lane_text);
    assert!(launch.input.contains("design version 1"));
    assert!(launch.input.contains(lane_text));
    native_server.abort();
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "one fixture trace covers a complete lifecycle"
)]
async fn scheduler_reservations_share_a_catalog_and_charge_the_selected_group() {
    let (_home, mut service) = fixture(GitHub::new("unused-fixture").expect("client"));
    let reads = Arc::new(AtomicUsize::new(0));
    let native_reads = Arc::clone(&reads);
    let root = service.fixture().checkout.clone();
    let runs = Arc::new(std::sync::Mutex::new(
        crate::profiles::tests::NativeRuns::default(),
    ));
    let (host, server) = native_fixture(move |request| {
        if request["tag"] != "server.getConfig" {
            return crate::profiles::tests::native_response(request, &root, &mut runs.lock().unwrap());
        }
        native_reads.fetch_add(1, Ordering::Relaxed);
        let models: Vec<_> = ["model-first", "model-second"].into_iter().map(|slug| json!({
            "slug": slug, "capabilities": {"optionDescriptors": [
                {"id":"reasoningEffort","type":"select","options":[{"id":"high"}]}
            ]}
        })).collect();
        json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success","value":{
            "environment":{"orchestrationProtocolVersion":2},
            "providers":[
                {"instanceId":"custom-codex","driver":"codex","enabled":true,"status":"ready","models":models},
                {"instanceId":"fixture-acp","driver":"acpRegistry","enabled":true,"status":"ready","models":[{"slug":"nucleus"}]},
                {"instanceId":"claudeAgent","enabled":false,"status":"disabled","models":[{"slug":"offline"}]}
            ]
        }}})
    }).await;
    service.host = host;
    service.state.lock().await.settings.profiles = Some(Arc::new(serde_json::from_value(json!({
        "profiles": [
            {"name":"First","group":"Shared plan","selection":{"id":"first","capability":"worker","provider":"codex","model":"model-first","effort":"high"}},
            {"name":"Second","group":"Shared plan","selection":{"id":"second","capability":"worker","provider":"codex","model":"model-second","effort":"high"}},
            {"name":"Offline","group":"Other plan","selection":{"id":"offline","capability":"worker","provider":"claude","model":"offline"}}
        ]
    })).expect("profile settings")));
    crate::profiles::tests::publish_parent_shell(&service).await;
    let pass = service.host.fixture_pass();
    let worktrees = service.worktrees();
    let mut selected = Vec::new();
    for id in ["worker-one", "worker-two"] {
        let mut task = Task::new(
            nucleus_core::Identity {
                id: id.into(),
                reference: id.into(),
                repository: REPOSITORY.into(),
                base: service.fixture().base.clone(),
                entry: Entry::Brief,
                origin_thread: None,
            },
            "Add a synthetic greeting.".into(),
            None,
        );
        let observation = Observation {
            host: Observed::Unknown,
            forge: Observed::Known(Forge::Absent),
            workspace: Observed::Known(Workspace::Absent),
        };
        assert_eq!(
            task.reconcile(&observation),
            Action::Advance(Phase::Working)
        );
        service
            .state
            .lock()
            .await
            .store
            .create_with_facts(
                &task,
                &event("admitted"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .expect("seed");
        let row = service.task(id).await.expect("row");
        let checkout = worktrees
            .checkout(&service.fixture().checkout, REPOSITORY, id)
            .expect("checkout");
        let first = Box::pin(service.reserve(
            &row,
            &checkout,
            observation.clone(),
            Role::Worker,
            Launch::Create,
            &pass,
        ))
        .await
        .expect("start parent");
        if first == Action::Wait(WaitReason::Starting) {
            crate::profiles::tests::publish_parent_shell(&service).await;
            Box::pin(service.reserve(
                &row,
                &checkout,
                observation,
                Role::Worker,
                Launch::Create,
                &pass,
            ))
            .await
            .expect("reserve configured worker");
        }
        let frozen = service.task(id).await.expect("frozen row");
        let launch = frozen.task.run().expect("run").launch();
        let profile = launch.profile().expect("canonical choice");
        let wire: serde_json::Value = serde_json::from_str(&launch.input).expect("frozen payload");
        assert_eq!(
            wire["payload"]["modelSelection"],
            json!({
                "instanceId":"custom-codex",
                "model":profile.model,
                "options":[{"id":"reasoningEffort","value":"high"}],
            })
        );
        selected.push(profile.id.clone());
    }
    assert_ne!(selected[0], selected[1]);
    assert_eq!(reads.load(Ordering::Relaxed), 1);
    let state = service.state.lock().await;
    for id in selected {
        let counts = state
            .store
            .rotation_counts(Role::Worker, &id, "Shared plan")
            .expect("rotation persisted");
        assert_eq!(counts.profile_lifetime, 1);
        assert_eq!(counts.group_lifetime, 2);
    }
    server.abort();
}

#[tokio::test]
async fn a_running_review_waits_for_its_deadline_without_reading_the_forge() {
    let (_home, mut service) = registry_fixture(GitHub::new("unused-fixture").expect("client"));
    let head = service.fixture().start.clone();
    let (forge, forge_reads, forge_server) = forge_fixture(&head).await;
    service.forge = forge;
    let worktrees = service.worktrees();
    let checkout = worktrees
        .checkout(
            &service.fixture().checkout,
            &service.fixture().repository,
            "reviewer",
        )
        .expect("checkout");
    let (mut task, _) = frozen_review(&service, &checkout, &head);
    let instance = task.run().expect("run").launch().instance.clone();
    let thread_id = task.run().expect("run").launch().thread.clone();
    task.record_send(&instance, 1).expect("send recorded");
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
    let binding = service.binding(&checkout).expect("binding");
    let native_reads = Arc::new(AtomicUsize::new(0));
    let calls = Arc::clone(&native_reads);
    let (host, native_server) = native_fixture(move |req| {
        if req["tag"] == "orchestration.subscribeShell" {
            return json!({"_tag":"Chunk","requestId":req["id"],"values":[
                {"kind":"snapshot","snapshot":{"snapshotSequence":1,"threads":[],"projects":[]}},
                {"kind":"synchronized"},
                {"kind":"thread.updated","sequence":2,"location":"active","thread":{
                    "id":thread_id,"status":"running","activeRunId":"native"
                }}
            ]});
        }
        if req["tag"] == "subscribeServerConfig" {
            return json!({"_tag":"Chunk","requestId":req["id"],"values":[]});
        }
        assert_eq!(req["tag"], "orchestration.subscribeThread");
        calls.fetch_add(1, Ordering::Relaxed);
        json!({"_tag":"Chunk","requestId":req["id"],"values":[
            {"kind":"snapshot","snapshotSequence":1,"projection":{
                "thread":{"id":req["payload"]["threadId"],"projectId":binding.project_id,
                    "worktreePath":binding.worktree_path,"branch":binding.branch},
                "runs":[{"id":"native","status":"running","userMessageId":format!("{instance}-message")}],
                "messages":[],"runtimeRequests":[],"providerThreads":[],"turnItems":[]
            }},
            {"kind":"synchronized"}
        ]})
    }).await;
    service.host = host;
    let service = Arc::new(service);

    let pass_started = tokio::time::Instant::now();
    let outcomes = service.pass().await.expect("exact run read");
    assert!(matches!(
        outcomes.as_slice(),
        [crate::PassOutcome {
            result: Ok(Action::Wait(WaitReason::Running)),
            ..
        }]
    ));
    assert_eq!(forge_reads.load(Ordering::Relaxed), 0);
    {
        let mut state = service.state.lock().await;
        crate::tests::assert_scheduled_wait(
            &mut state,
            "reviewer",
            WaitReason::Running,
            pass_started,
            crate::schedule::LIVE_CHECK,
        );
        // The watcher must supply the next decision even if the backstop has elapsed.
        state.schedule.park("reviewer");
    }
    let thread = &task.run().expect("reviewer run").launch().thread;
    let watch = prove_running_hint_refresh(&service, thread, &native_reads).await;
    let authority = Authority::Operator {
        actor: "fixture".into(),
    };
    let amended = service
        .command("reviewer", &authority, Command::Amend("next".into()))
        .await
        .unwrap();
    assert_eq!(amended.task.brief().text, "next");
    assert_eq!(forge_reads.load(Ordering::Relaxed), 1);
    watch.abort();
    forge_server.abort();
    native_server.abort();
}

async fn prove_running_hint_refresh(
    service: &Arc<Service>,
    thread: &str,
    native_reads: &AtomicUsize,
) -> tokio::task::JoinHandle<()> {
    let service_watch = Arc::clone(service);
    let watch = tokio::spawn(async move { service_watch.watch_host().await });
    let hint = loop {
        let changed = service.wake.notified();
        {
            let state = service.state.lock().await;
            if let Some(seen) = state.thread_tasks["reviewer"][thread].seen.as_ref() {
                assert!(seen.running());
                assert!(state.schedule.due("reviewer").unwrap() <= tokio::time::Instant::now());
                break seen.clone();
            }
        }
        changed.await;
    };
    service.pass().await.expect("event pass");
    let reads = native_reads.load(Ordering::Relaxed);
    assert_eq!(reads, 2);
    // Replay the same shell fact as fresh evidence after the exact read completes.
    service.wake_from_host(hint).await;
    service.state.lock().await.schedule.wake(
        "reviewer",
        tokio::time::Instant::now(),
        crate::schedule::Priority::Refresh,
    );
    let outcomes = service.pass().await.expect("running backstop");
    assert!(matches!(
        outcomes[0].result,
        Ok(Action::Wait(WaitReason::Running))
    ));
    assert_eq!(native_reads.load(Ordering::Relaxed), reads);
    watch
}

#[tokio::test]
async fn review_recovers_its_checkout_before_creating_a_reservation() {
    for available in [true, false] {
        let (_home, mut service) = fixture(GitHub::new("unused-fixture").expect("client"));
        crate::tests::git(
            &service.fixture().checkout,
            &["config", "protocol.https.allow", "never"],
        );
        let root = service.fixture().checkout.clone();
        let runs = Arc::new(std::sync::Mutex::new(
            crate::profiles::tests::NativeRuns::default(),
        ));
        let (host, native_server) = native_fixture(move |request| {
            crate::profiles::tests::native_response(request, &root, &mut runs.lock().unwrap())
        })
        .await;
        service.host = host;
        crate::profiles::tests::publish_parent_shell(&service).await;
        let head = if available {
            service.fixture().start.clone()
        } else {
            "b".repeat(40).parse().expect("missing local object")
        };
        let (forge, _, server) = forge_fixture(&head).await;
        service.forge = forge;
        let (reserved, _, observation) = reservation("reviewer", Entry::ReviewEntry, &head);
        let mut task = Task::new(
            reserved.identity().clone(),
            reserved.brief().text.clone(),
            reserved.pull_request().cloned(),
        )
        .with_author_declaration(crate::tests::author_declaration())
        .expect("declare the external author");
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
        let row = service.task("reviewer").await.expect("reviewing row");
        assert_eq!(row.task.phase(), Phase::Reviewing);
        let host = service.host.pass(service.storage.scratch().path());
        let mut step = Box::pin(service.advance(&row, &host)).await;
        if matches!(step, Ok(Action::Wait(WaitReason::Starting))) {
            crate::profiles::tests::publish_parent_shell(&service).await;
            let host = service.host.pass(service.storage.scratch().path());
            step = Box::pin(service.advance(&row, &host)).await;
        }
        let next = service.task("reviewer").await.expect("result row");
        if available {
            assert_eq!(
                step.expect("recover the published checkout"),
                Action::Launch {
                    role: Role::Reviewer,
                    via: Launch::Create
                }
            );
            assert!(next.task.run().is_some());
        } else {
            assert!(matches!(
                step,
                Err(ServiceError::Workspace(WorkError::Git {
                    operation: nucleus_work::GitOperation::Fetch,
                    ..
                }))
            ));
            assert_eq!(
                crate::task_wait(&row, &step).0,
                Some(WaitReason::WorkspaceUnknown)
            );
            assert!(crate::workspace_cause(&step).starts_with("git fetch "));
            assert_eq!(row, next);
        }
        native_server.abort();
        server.abort();
    }
}

#[tokio::test]
async fn an_edit_during_native_authorization_cannot_send_the_review() {
    let (_home, mut service) = registry_fixture(GitHub::new("unused-fixture").expect("client"));
    let head = service.fixture().start.clone();
    let (forge, reads, forge_server) = forge_fixture(&head).await;
    service.forge = forge;
    let git = service.git.clone();
    let worktrees = crate::Worktrees::new(
        &service.storage,
        &git,
        crate::Redactor::new([], crate::RedactionRules::common()),
    );
    let checkout = worktrees
        .checkout(
            &service.fixture().checkout,
            &service.fixture().repository,
            "reviewer",
        )
        .expect("checkout");
    assert_eq!(
        checkout.allocate(&head).expect("allocate"),
        Workspace::Clean(head.clone())
    );
    let (task, mut observation) = frozen_review(&service, &checkout, &head);
    let id = task.run().expect("run").launch().instance.clone();
    observation.host = Observed::Known(Host::Current {
        instance: id,
        state: RunState::ReadyToSend,
    });
    let edit = checkout.path().join("edit-during-authorization.txt");
    let root = service.fixture().checkout.clone();
    let (host, native_server) = native_fixture(move |req| {
        match req["tag"].as_str() {
            Some("orchestration.subscribeThread") => {
                std::fs::write(&edit, "local work").expect("edit while T3 is answering");
                let thread = &req["payload"]["threadId"];
                json!({"_tag":"Exit","requestId":req["id"],"exit":{"_tag":"Failure","cause":[
                    {"_tag":"Fail","error":{"_tag":"OrchestrationV2GetThreadProjectionError","threadId":thread,
                        "cause":{"name":"ProjectionStoreThreadNotFoundError","message":format!("No orchestration projection exists for thread {}.", thread.as_str().expect("thread"))}
                    }}
                ]}})
            }
            Some("orchestration.subscribeShell") => json!({"_tag":"Chunk","requestId":req["id"],"values":[
                {"kind":"snapshot","snapshot":{"projects":[{"id":"local-fixture","workspaceRoot":root}]}},
                {"kind":"synchronized"}
            ]}),
            _ => panic!("must not send a dirty review"),
        }
    }).await;
    service.host = host;
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
    let row = service.task("reviewer").await.expect("original row");
    let result = service
        .send_prepared(&row, &checkout, observation, &service.host.fixture_pass())
        .await;
    assert_eq!(
        result.expect("dirty gate waits"),
        Action::Wait(WaitReason::HostUnknown)
    );
    assert_eq!(
        reads.load(Ordering::Relaxed),
        2,
        "forge reread after T3 authorization"
    );
    assert_eq!(service.task("reviewer").await.expect("no send marker"), row);
    native_server.abort();
    forge_server.abort();
}

#[tokio::test]
async fn an_interrupt_requires_the_current_fixture_project_root() {
    for retargeted in [false, true] {
        let (_home, mut service) = registry_fixture(GitHub::new("unused-fixture").expect("client"));
        let head = service.fixture().start.clone();
        let git = service.git.clone();
        let worktrees = crate::Worktrees::new(
            &service.storage,
            &git,
            crate::Redactor::new([], crate::RedactionRules::common()),
        );
        let checkout = worktrees
            .checkout(
                &service.fixture().checkout,
                &service.fixture().repository,
                "reviewer",
            )
            .expect("checkout");
        checkout.allocate(&head).expect("checkout at head");
        let (mut task, observation) = frozen_review(&service, &checkout, &head);
        let launch = task.run().expect("run").launch();
        let instance = launch.instance.clone();
        let thread = launch.thread.clone();
        task.record_send(&instance, 1).expect("possible send");
        task.command(
            Command::Cancel,
            &Authority::Operator {
                actor: "fixture".into(),
            },
            &observation,
        )
        .expect("revoke");
        let root = if retargeted {
            "/synthetic/unrelated".into()
        } else {
            service.fixture().checkout.clone()
        };
        let owned = checkout.path().to_owned();
        let writes = Arc::new(AtomicUsize::new(0));
        let attempted = Arc::clone(&writes);
        let (host, server) = native_fixture(move |req| {
            let snapshot = match req["tag"].as_str() {
                Some("orchestration.subscribeThread") => json!({"projection":{
                    "thread":{"id":thread,"projectId":"local-fixture","worktreePath":owned,"branch":"ns-reviewer"},
                    "runs":[{"id":"native-review","status":"running","userMessageId":format!("{instance}-message")}],
                    "messages":[],"runtimeRequests":[],"providerThreads":[],"turnItems":[]
                }}),
                Some("orchestration.subscribeShell") => json!({"snapshot":{
                    "projects":[{"id":"local-fixture","workspaceRoot":root}]
                }}),
                Some("orchestration.dispatchCommand") => {
                    assert_eq!(req["payload"]["type"], "run.interrupt");
                    attempted.fetch_add(1, Ordering::Relaxed);
                    return json!({"_tag":"Exit","requestId":req["id"],"exit":{"_tag":"Success","value":{"sequence":12}}});
                }
                _ => panic!("unexpected native method"),
            };
            let mut snapshot = snapshot;
            snapshot["kind"] = json!("snapshot");
            snapshot["snapshotSequence"] = json!(11);
            json!({"_tag":"Chunk","requestId":req["id"],"values":[snapshot,{"kind":"synchronized"}]})
        }).await;
        service.host = host;
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
        let row = service.task("reviewer").await.expect("revoked row");
        let result =
            Box::pin(service.stop_run(&row, &checkout, observation, &service.host.fixture_pass()))
                .await;
        if retargeted {
            assert!(matches!(
                result,
                Err(ServiceError::Host(HostError::Binding))
            ));
        } else {
            assert_eq!(
                result.expect("authorized interrupt"),
                Action::Wait(WaitReason::Stopping)
            );
        }
        assert_eq!(writes.load(Ordering::Relaxed), usize::from(!retargeted));
        assert_eq!(
            service.task("reviewer").await.expect("custody retained"),
            row
        );
        server.abort();
    }
}

fn frozen_review(service: &Service, checkout: &Checkout<'_>, head: &Head) -> (Task, Observation) {
    let (task, _, observation) = reservation("reviewer", Entry::ReviewEntry, head);
    let launch = task.run().expect("run").launch();
    let inputs = RunRequest {
        parent: None,
        binding: service.binding(checkout).expect("binding"),
        dispatch: Dispatch::Create {
            title: "Review fixture".into(),
            profile: service.fixture().reviewer.clone(),
        },
        text: "Review the fixture".into(),
    }
    .inputs(&launch.instance, launch.thread.clone(), 1)
    .expect("wire");
    let mut restored = serde_json::to_value(&task).expect("stored reservation");
    restored["run"]["launch"]["input"] = json!(inputs.input);
    (
        serde_json::from_value(restored).expect("typed reservation"),
        observation,
    )
}

#[test]
fn forge_transport_backoff_is_capped_and_a_success_resets_it() {
    let (_home, service) = registry_fixture(GitHub::new("fixture").expect("client"));
    let failure = ForgeError::Status(StatusCode::BAD_GATEWAY);
    for delay in [30, 60, 120, 240, 240] {
        record_forge_failure(&service, &failure);
        assert_eq!(service.forge_retry_secs.load(Ordering::Relaxed), delay);
    }
    capture_forge(&service, Ok(())).expect("successful response");
    assert_eq!(service.forge_backoff(), Duration::ZERO);
    record_forge_failure(&service, &failure);
    assert_eq!(service.forge_retry_secs.load(Ordering::Relaxed), 30);
}

fn merge_fixture(
    head: &Head,
    new_head: &Head,
    status: StatusCode,
    new: &Arc<AtomicBool>,
    puts: &Arc<AtomicUsize>,
) -> Router {
    let (before, after) = (forge_pull(head), forge_pull(new_head));
    let (old_checks, new_checks) = (forge_checks(head), forge_checks(new_head));
    let (change, changed) = (Arc::clone(new), Arc::clone(new));
    let (count, sent) = (Arc::clone(puts), Arc::clone(puts));
    let pull = format!("/repos/{}/pulls/1", crate::tests::REPOSITORY);
    Router::new()
        .route(
            &pull,
            get(move || async move {
                if status == StatusCode::METHOD_NOT_ALLOWED && sent.load(Ordering::Relaxed) > 0 {
                    return (StatusCode::TOO_MANY_REQUESTS, [(RETRY_AFTER, "60")]).into_response();
                }
                Json(if change.load(Ordering::Relaxed) {
                    after
                } else {
                    before
                })
                .into_response()
            }),
        )
        .route(
            "/graphql",
            post(move || async move {
                Json(if changed.load(Ordering::Relaxed) {
                    new_checks
                } else {
                    old_checks
                })
            }),
        )
        .route(
            &format!("{pull}/merge"),
            put(move || async move {
                count.fetch_add(1, Ordering::Relaxed);
                status
            }),
        )
}

#[test]
fn exact_review_replay_needs_cleanliness_and_superseded_replay_archives() {
    let old: Head = "a".repeat(40).parse().expect("old head");
    let new: Head = "b".repeat(40).parse().expect("new head");
    let open = |head: Head| {
        Observed::Known(Forge::Open {
            pr: PullRequest {
                url: "https://github.com/example/fixture/pull/1".into(),
                head,
            },
            checks: CheckState::Ready,
        })
    };
    let mut observation = Observation {
        host: Observed::Unknown,
        workspace: Observed::Unknown,
        forge: Observed::Unknown,
    };
    assert_eq!(replay_policy(Some(&old), &observation), None);
    observation.forge = open(old.clone());
    observation.workspace = Observed::Known(Workspace::Dirty);
    assert_eq!(replay_policy(Some(&old), &observation), None);
    observation.workspace = Observed::Known(Workspace::Clean(old.clone()));
    assert_eq!(replay_policy(Some(&old), &observation), Some(false));
    observation.forge = open(new);
    observation.workspace = Observed::Known(Workspace::Dirty);
    assert_eq!(replay_policy(Some(&old), &observation), Some(true));
}

struct DisconnectingPass<'a> {
    host: &'a T3,
    pass: nucleus_hosts::T3Pass<'a>,
    reject_tickets: Arc<std::sync::atomic::AtomicBool>,
}

impl TaskHost for DisconnectingPass<'_> {
    async fn terminal_orphans(
        &self,
        root: &Path,
        scratch: &Path,
    ) -> Result<nucleus_hosts::OrphanScan, HostError> {
        self.pass.terminal_orphans(root, scratch).await
    }

    async fn terminal_helpers(
        &self,
        roots: &[PathBuf],
        scratch: &Path,
    ) -> Result<Vec<nucleus_hosts::OrphanProcess>, HostError> {
        self.pass.terminal_helpers(roots, scratch).await
    }

    async fn profile_catalog(&self) -> Result<&nucleus_hosts::ProfileCatalog, HostError> {
        self.pass.profile_catalog().await
    }

    fn prepare_launch(
        &self,
        request: nucleus_hosts::LaunchRequest<'_>,
    ) -> Result<nucleus_core::LaunchInputs, HostError> {
        self.pass.prepare_launch(request)
    }

    async fn observe_retained_role(
        &self,
        binding: &Binding,
        thread: &str,
    ) -> Result<Host, HostError> {
        self.pass.observe_retained_role(binding, thread).await
    }

    async fn observe_run(
        &self,
        run: &Run,
        now_ms: u64,
    ) -> Result<nucleus_hosts::RunObservation, HostError> {
        self.pass.observe_run(run, now_ms).await
    }

    async fn authorize_send(
        &self,
        run: &Run,
    ) -> Result<nucleus_hosts::ReplayAuthorization, HostError> {
        self.pass.authorize_send(run).await
    }

    async fn send(
        &self,
        dispatch: nucleus_hosts::RunDispatch,
        record_snooze: impl FnMut(nucleus_hosts::SnoozeUpdate) -> Result<(), HostError> + Send,
    ) -> Result<SendOutcome, HostError> {
        self.reject_tickets
            .store(true, std::sync::atomic::Ordering::Relaxed);
        self.host.fixture_disconnect();
        self.pass.send(dispatch, record_snooze).await
    }

    async fn write_control(&self, dispatch: ControlDispatch) -> Result<(), HostError> {
        self.pass.write_control(dispatch).await
    }

    async fn stop(
        &self,
        run: &Run,
        expected: &Binding,
        now_ms: u64,
        archive: bool,
    ) -> Result<StopProgress, HostError> {
        self.pass.stop(run, expected, now_ms, archive).await
    }
}

async fn seed_reserved_role_launch(
    service: &Service,
    id: &str,
    checkout: &Checkout<'_>,
) -> (TaskRow, String) {
    let head = service.fixture().start.clone();
    checkout.allocate(&head).unwrap();
    let binding = Binding {
        project_id: "local-fixture".into(),
        worktree_path: checkout.path().to_str().unwrap().into(),
        branch: checkout.branch().into(),
    };
    let mut task = Task::new(
        nucleus_core::Identity {
            id: id.into(),
            reference: id.into(),
            repository: service.fixture().repository.clone(),
            base: service.fixture().base.clone(),
            entry: Entry::Brief,
            origin_thread: None,
        },
        "Role brief".into(),
        None,
    );
    let observation = Observation {
        host: Observed::Unknown,
        forge: Observed::Known(Forge::Absent),
        workspace: Observed::Known(Workspace::Clean(head)),
    };
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Working)
    );
    let Action::Launch { via, .. } = task.reconcile(&observation) else {
        panic!("expected launch");
    };
    let profile = nucleus_hosts::RoleProfile {
        instance_id: "fixture-provider".into(),
        model: "fixture-model".into(),
        options: Vec::new(),
        runtime_mode: "full-access".into(),
    };
    let instance = format!("task-{id}-run-1");
    let inputs = service
        .host
        .fixture_pass()
        .prepare_launch(LaunchRequest {
            binding,
            parent: None,
            reuse_parent: false,
            via: &via,
            profile: &profile,
            title: id.into(),
            instance: &instance,
            started_at: 1,
            text: "Work".into(),
        })
        .unwrap();
    let thread = inputs.thread.clone();
    task.reserve_grouped_launch(&observation, inputs, &[4; 32], None, "fixture-group".into())
        .unwrap();
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
    (service.task(id).await.unwrap(), thread)
}
