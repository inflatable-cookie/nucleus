//! Editor file watch tests, split from the watch god file; behavior
//! unchanged.

use super::*;

use super::forwarder::spawn_event_forwarder;
use super::scm::scm_changed_targets;
use super::targets::changed_paths_by_resource;

#[test]
fn changed_paths_are_relative_grouped_and_deduplicated() {
    let targets = vec![
        WatchTarget {
            resource_id: "resource:one".to_owned(),
            root: PathBuf::from("/workspace/one"),
            scm_roots: vec![PathBuf::from("/workspace/one/.git")],
        },
        WatchTarget {
            resource_id: "resource:two".to_owned(),
            root: PathBuf::from("/workspace/two"),
            scm_roots: vec![PathBuf::from("/workspace/two/.git")],
        },
    ];
    let changed = changed_paths_by_resource(
        &targets,
        &[
            PathBuf::from("/workspace/one/src/lib.rs"),
            PathBuf::from("/workspace/one/src/lib.rs"),
            PathBuf::from("/workspace/two/README.md"),
            PathBuf::from("/workspace/one/target/generated.rs"),
            PathBuf::from("/outside/ignored.txt"),
        ],
    );

    assert_eq!(changed.len(), 2);
    assert_eq!(changed[0].0.resource_id, "resource:one");
    assert_eq!(changed[0].1, vec!["src/lib.rs"]);
    assert_eq!(changed[1].0.resource_id, "resource:two");
    assert_eq!(changed[1].1, vec!["README.md"]);
}

#[test]
fn root_git_metadata_changes_are_classified_separately() {
    let targets = vec![
        WatchTarget {
            resource_id: "resource:one".to_owned(),
            root: PathBuf::from("/workspace/one"),
            scm_roots: vec![PathBuf::from("/workspace/one/.git")],
        },
        WatchTarget {
            resource_id: "resource:two".to_owned(),
            root: PathBuf::from("/workspace/two"),
            scm_roots: vec![PathBuf::from("/workspace/two/.git")],
        },
    ];

    let changed = scm_changed_targets(
        &targets,
        &[
            PathBuf::from("/workspace/one/.git/index"),
            PathBuf::from("/workspace/one/.git/refs/heads/main"),
            PathBuf::from("/workspace/two/src/lib.rs"),
            PathBuf::from("/workspace/two/vendor/dependency/.git/index"),
        ],
    );

    assert_eq!(
        changed
            .into_iter()
            .map(|target| target.resource_id)
            .collect::<Vec<_>>(),
        vec!["resource:one"]
    );
}

#[test]
fn native_watcher_emits_scm_change_for_an_atomic_index_replacement() {
    let root = tempfile::tempdir().expect("resource root");
    let git_dir = root.path().join(".git");
    std::fs::create_dir_all(&git_dir).expect("git directory");
    std::fs::write(git_dir.join("index"), b"before").expect("initial index");

    let (native_sender, native_receiver) = mpsc::channel();
    let mut watcher = PollWatcher::new(
        native_sender,
        Config::default().with_poll_interval(Duration::from_millis(100)),
    )
    .expect("SCM metadata watcher");
    watcher
        .watch(&git_dir, RecursiveMode::NonRecursive)
        .expect("watch SCM metadata root");

    let (sink_sender, sink_receiver) = mpsc::channel();
    spawn_event_forwarder(
        native_receiver,
        vec![WatchTarget {
            resource_id: "resource:test".to_owned(),
            root: root.path().to_path_buf(),
            scm_roots: vec![git_dir.clone()],
        }],
        "subscription:test".to_owned(),
        "project:test".to_owned(),
        Arc::new(move |event| {
            let _ = sink_sender.send(event);
        }),
    );

    // PollWatcher records whole-second mtimes, so cross the timestamp boundary before
    // replacing Git's index to exercise the same long-lived subscription used by the app.
    std::thread::sleep(Duration::from_millis(1_200));
    std::fs::write(git_dir.join("index.lock"), b"after").expect("replacement index");
    std::fs::rename(git_dir.join("index.lock"), git_dir.join("index"))
        .expect("atomic index replacement");

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let event = sink_receiver
            .recv_timeout(remaining)
            .expect("SCM change event");
        if matches!(
            event,
            EditorFileWatchEvent::ScmChanged {
                ref project_id,
                ref resource_id,
                ..
            } if project_id == "project:test" && resource_id == "resource:test"
        ) {
            break;
        }
    }

    drop(watcher);
}
