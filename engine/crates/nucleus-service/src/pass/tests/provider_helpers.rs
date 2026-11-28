//! Terminal closeout against a real process census. This test process stands in
//! for the T3 server, a shell running as `codex app-server` for its provider,
//! and renamed processes for the helpers that provider leaves behind.

use std::{collections::BTreeMap, time::Duration};

use super::*;

/// The provider, or a lookalike parent when it does not run as `codex`. The
/// `early` child starts before the checkout exists and moves into it later.
const SCRIPT: &str = r#"
home=$PWD checkout=$1 role=$2
exec >/dev/null 2>&1
if [ "$role" = provider ]; then
    (until [ -e "$home/go" ]; do /bin/sleep 0.05; done; cd "$checkout" && exec /bin/sleep 120) &
    echo "early $!" >>"$home/pids"
fi
until [ -e "$home/go" ]; do /bin/sleep 0.05; done
if [ "$role" = provider ]; then
    (exec -a node_repl /bin/sleep 120) &
    echo "elsewhere $!" >>"$home/pids"
    (cd "$checkout" && exec -a cua-driver /bin/sleep 120) &
    echo "cua $!" >>"$home/pids"
    (cd "$checkout" && exec -a node_repl /bin/bash -c '/bin/sleep 120 & echo "inner $!" >>"$0/pids"
        (cd "$0" && exec /bin/sleep 120) & echo "outside $!" >>"$0/pids"
        wait' "$home") &
    echo "repl $!" >>"$home/pids"
else
    (cd "$checkout" && exec -a node_repl /bin/sleep 120) &
    echo "foreign $!" >>"$home/pids"
fi
wait
"#;

const HELPERS: [&str; 3] = ["cua", "repl", "inner"];
/// Working in the checkout, but not provider helpers of this checkout's lifetime.
const HOLDERS: [&str; 3] = ["early", "foreign", "shared"];
const BYSTANDERS: [&str; 2] = ["elsewhere", "outside"];

fn alive(pid: u32) -> bool {
    let probe = std::process::Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "stat="])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&probe.stdout);
    !state.trim().is_empty() && !state.trim().starts_with('Z')
}

async fn recorded_pids(home: &Path, count: usize) -> BTreeMap<String, u32> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let pids: BTreeMap<String, u32> = std::fs::read_to_string(home.join("pids"))
                .unwrap_or_default()
                .lines()
                .filter_map(|line| line.split_once(' '))
                .filter_map(|(name, pid)| Some((name.to_owned(), pid.parse().ok()?)))
                .collect();
            if pids.len() == count {
                break pids;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("fixture processes started")
}

/// Every process named by a record of this kind, with its signal outcome if any.
async fn recorded(service: &Service, id: &str, kind: &str) -> Vec<serde_json::Value> {
    service
        .history(id, None, 100)
        .await
        .unwrap()
        .iter()
        .filter(|entry| entry.content.kind == kind)
        .flat_map(|entry| {
            let detail: serde_json::Value = serde_json::from_str(&entry.content.detail).unwrap();
            let rows = detail.get("results").or_else(|| detail.get("processes"));
            rows.unwrap().as_array().unwrap().clone()
        })
        .collect()
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "one real process tree is followed from a live role to a released checkout"
)]
async fn closeout_stops_a_finished_sessions_provider_helpers() {
    let (home, mut service) = registry_fixture(GitHub::new("fixture").unwrap());
    let head = service.fixture().start.clone();
    let (forge, _server) = publish_checkout_forge(head).await;
    service.forge = forge;
    let (native, _archive) = empty_archive_fixture(1).await;
    service.host = crate::tests::verified_native_fixture(native, home.path());
    assert!(
        service.host.runtime_identity().is_some(),
        "fixture native runtime identity"
    );
    service.set_fixture_acp_provider("fixture");
    // Helper cleanup runs on a profile whose Dispatch was never configured.
    assert!(service.state.lock().await.settings.dispatch.is_none());
    let terminal = cancelled_cleanup_task(&service).await;
    let id = terminal.task.identity().id.clone();
    let work = service.worktrees();
    let checkout = work
        .checkout(&service.fixture().checkout, REPOSITORY, &id)
        .unwrap();
    let base = checkout.path().to_owned();
    let route = service.project_for(terminal.task.identity()).await.unwrap();
    let binding = route.binding(&checkout).unwrap();
    let shell = |service: &Service, threads: serde_json::Value| {
        service.host.fixture_held_shell(&json!({
            "kind":"snapshot","snapshot":{"snapshotSequence":1,"projects":[],"threads":threads,
                "archivedThreads":archived_checkout_rows(&binding, &terminal.task)}
        }));
    };

    let server_home = tempfile::tempdir().unwrap();
    let at = server_home.path();
    std::fs::write(at.join("app-server"), SCRIPT).unwrap();
    let parent = |name: &str, role: &str| {
        tokio::process::Command::new("/bin/bash")
            .arg0(name)
            .arg("app-server")
            .arg(&base)
            .arg(role)
            .current_dir(at)
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    };
    let mut provider = parent("codex", "provider");
    let mut lookalike = parent("node", "lookalike");
    recorded_pids(at, 1).await;
    checkout.allocate(&service.fixture().start).unwrap();
    // A helper must start in a later second than the checkout was created.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    std::fs::write(at.join("go"), "").unwrap();
    let mut pids = recorded_pids(at, 7).await;
    let output = tokio::process::Command::new("/bin/sh")
        .args(["-c", "/bin/sleep 120 >/dev/null 2>&1 & echo $!"])
        .current_dir(&base)
        .output()
        .await
        .unwrap();
    let shared = std::str::from_utf8(&output.stdout).unwrap().trim();
    pids.insert("shared".into(), shared.parse().unwrap());
    let _cleanup = ProtectedTree(pids.values().copied().collect());
    // Processes must pass the scan's settle margin before closeout reads them.
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let parents = [provider.id().unwrap(), lookalike.id().unwrap()];

    // A live role retains the checkout and keeps every helper running.
    let task_thread = nucleus_hosts::parent_thread(&base);
    shell(
        &service,
        json!([{"id":"active-child","parentThreadId":task_thread,"status":"running"}]),
    );
    let outcome = service.archive_done(&terminal).await;
    let Err(ServiceError::CheckoutRetained(cause)) = &outcome else {
        panic!("{outcome:?}");
    };
    assert!(cause.contains("every task thread is idle"), "{cause}");
    for (name, pid) in &pids {
        assert!(alive(*pid), "{name}");
    }
    for kind in ["checkout_process_stop", "checkout_process_result"] {
        assert!(recorded(&service, &id, kind).await.is_empty());
    }
    // Rechecks of a task waiting for quiet shell evidence back off.
    for expected in [3, 6, 12] {
        let expected = Duration::from_secs(expected);
        // A pass takes the task's deadlines before it records a result.
        service.state.lock().await.schedule.park(&id);
        let before = tokio::time::Instant::now();
        service
            .schedule_result(&terminal, &outcome, crate::schedule::Priority::Closeout)
            .await
            .unwrap();
        let after = tokio::time::Instant::now();
        let state = service.state.lock().await;
        let due = state.schedule.due(&id).expect("retry");
        assert!(
            due - after <= expected && expected <= due - before,
            "{:?} for {expected:?}",
            due - before
        );
        assert!(matches!(
            state.wait_detail(&id),
            Some(crate::WaitDetail::Archive(shown))
                if shown.contains("every task thread is idle")
        ));
    }

    shell(&service, json!([]));
    let outcome = service.archive_done(&terminal).await;
    assert_eq!(outcome.unwrap(), Action::Nothing);
    let results = recorded(&service, &id, "checkout_process_result").await;
    for result in &results {
        let pid = u32::try_from(result["process"]["pid"].as_u64().unwrap()).unwrap();
        assert!(HELPERS.iter().any(|name| pids[*name] == pid), "{result}");
        assert_eq!(result["process"]["provider"], parents[0]);
        assert_ne!(result["process"]["command"], "");
    }
    for name in HELPERS {
        assert!(
            results.iter().any(|result| {
                result["process"]["pid"] == pids[name] && result["outcome"] == "sent"
            }),
            "{name}: {results:?}; history: {:?}",
            service.history(&id, None, 100).await.unwrap()
        );
        assert!(!alive(pids[name]), "{name}");
    }
    for name in HOLDERS.iter().chain(&BYSTANDERS) {
        assert!(alive(pids[*name]), "{name}");
    }
    assert!(provider.try_wait().unwrap().is_none());
    assert!(lookalike.try_wait().unwrap().is_none());

    let retained = recorded(&service, &id, "checkout_process_retained").await;
    assert!(retained.iter().any(|entry| entry["pid"] == pids["shared"]));
    assert!(!base.exists());

    for name in HOLDERS {
        assert!(alive(pids[name]), "{name}");
        let stopped = std::process::Command::new("/bin/kill")
            .arg(pids[name].to_string())
            .status()
            .unwrap();
        assert!(stopped.success());
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        while HOLDERS.iter().any(|name| alive(pids[*name])) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("holders exited");
    assert_eq!(
        service.archive_done(&terminal).await.unwrap(),
        Action::Nothing
    );
    assert!(!base.exists());
    // Neither the released checkout nor its cleanup touched anything outside it.
    for name in BYSTANDERS {
        assert!(alive(pids[name]), "{name}");
    }
    assert!(provider.try_wait().unwrap().is_none());
    provider.kill().await.unwrap();
    lookalike.kill().await.unwrap();
}
