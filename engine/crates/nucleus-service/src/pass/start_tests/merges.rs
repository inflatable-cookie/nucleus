//! The registered checkout's base following merged tasks.

use super::*;

/// A clean registered checkout level with its origin, tracking `shared`.
async fn level() -> (Registered, Head) {
    let mut registered = registered().await;
    git(&registered.checkout, &["checkout", "--quiet", "tracked"]);
    std::fs::remove_file(registered.checkout.join("untracked")).expect("clean");
    let start = registered.merge("shared", "first\n");
    git(
        &registered.checkout,
        &["pull", "--quiet", "--ff-only", "origin", "main"],
    );
    registered.local = start.clone();
    (registered, start)
}

impl Registered {
    /// Publish a commit which writes one file, as a merged pull request would.
    fn merge(&self, file: &str, text: &str) -> Head {
        std::fs::write(self.publisher.join(file), text).expect("published file");
        git(&self.publisher, &["add", file]);
        self.publish(file)
    }

    async fn update(&self, id: &str, commit: &Head) -> Vec<String> {
        self.landed(id, commit).await;
        self.service.apply_merges().await;
        self.refusals(id).await
    }

    async fn refusals(&self, id: &str) -> Vec<String> {
        let state = self.service.state.lock().await;
        let events = state.store.history(id, None, 50).expect("history");
        events
            .into_iter()
            .filter(|event| event.content.kind == "checkout_not_updated")
            .map(|event| event.content.detail)
            .collect()
    }

    fn at(&self, revision: &str) -> Head {
        head(&self.checkout, revision)
    }

    fn read(&self, file: &str) -> String {
        std::fs::read_to_string(self.checkout.join(file)).expect("checkout file")
    }
}

fn refused(refusals: &[String], reason: &str) {
    assert_eq!(refusals.len(), 1, "{refusals:?}");
    assert!(refusals[0].contains(reason), "{refusals:?}");
}

#[tokio::test]
async fn a_checked_out_base_fast_forwards_beside_unrelated_local_files() {
    let (registered, _) = level().await;
    let merged = registered.merge("shared", "second\n");
    assert_eq!(
        registered.update("clean", &merged).await,
        Vec::<String>::new()
    );
    assert_eq!(registered.at("HEAD"), merged);
    assert_eq!(registered.at("refs/remotes/origin/main"), merged);
    assert_eq!(registered.read("shared"), "second\n");
    assert_eq!(git(&registered.checkout, &["status", "--porcelain"]), "");

    std::fs::write(registered.checkout.join("untracked"), "kept\n").expect("untracked");
    std::fs::write(registered.checkout.join("tracked"), "edited\n").expect("edit");
    let later = registered.merge("shared", "third\n");
    assert_eq!(
        registered.update("beside", &later).await,
        Vec::<String>::new()
    );
    assert_eq!(registered.at("HEAD"), later);
    assert_eq!(registered.read("untracked"), "kept\n");
    assert_eq!(registered.read("tracked"), "edited\n");
}

#[tokio::test]
async fn a_merge_which_would_overwrite_local_files_is_refused_and_recorded() {
    let (registered, start) = level().await;
    // Configuration which would otherwise move the edit into a stash.
    git(&registered.checkout, &["config", "merge.autoStash", "true"]);
    std::fs::write(registered.checkout.join("shared"), "local\n").expect("edit");
    let changed = registered.merge("shared", "second\n");
    refused(&registered.update("edited", &changed).await, "shared");
    assert_eq!(registered.at("HEAD"), start);
    assert_eq!(registered.read("shared"), "local\n");
    assert_eq!(git(&registered.checkout, &["stash", "list"]), "");

    git(&registered.checkout, &["checkout", "--quiet", "shared"]);
    std::fs::write(registered.checkout.join(".git/info/exclude"), "secret\n").expect("ignore");
    std::fs::write(registered.checkout.join("secret"), "local\n").expect("ignored file");
    let added = registered.merge("secret", "published\n");
    refused(&registered.update("ignored", &added).await, "secret");
    assert_eq!(registered.at("HEAD"), start);
    assert_eq!(registered.read("secret"), "local\n");
}

#[tokio::test]
async fn another_branch_moves_only_the_base_ref() {
    let (registered, start) = level().await;
    git(&registered.checkout, &["checkout", "--quiet", "-b", "side"]);
    // A configured prune must not delete the destination of the ref move.
    git(&registered.checkout, &["config", "fetch.prune", "true"]);
    std::fs::write(registered.checkout.join("shared"), "local\n").expect("edit");
    let merged = registered.merge("shared", "second\n");
    assert_eq!(
        registered.update("side", &merged).await,
        Vec::<String>::new()
    );
    assert_eq!(registered.at("refs/heads/main"), merged);
    assert_eq!(registered.at("refs/heads/side"), start);
    assert_eq!(
        git(&registered.checkout, &["symbolic-ref", "HEAD"]),
        "refs/heads/side"
    );
    assert_eq!(registered.read("shared"), "local\n");
    assert_eq!(
        git(&registered.checkout, &["status", "--porcelain"]),
        " M shared"
    );

    // Another worktree holding the base keeps it.
    let held = registered.checkout.with_file_name("held");
    git(
        &registered.checkout,
        &["worktree", "add", "--quiet", held.to_str().unwrap(), "main"],
    );
    let later = registered.merge("shared", "third\n");
    refused(&registered.update("held", &later).await, "checked out at");
    assert_eq!(registered.at("refs/heads/main"), merged);
}

#[tokio::test]
async fn a_diverged_base_is_refused_and_recorded() {
    for branch in ["main", "side"] {
        let (registered, _) = level().await;
        create_fixture_commit(&registered.checkout, "local only");
        let local = registered.at("HEAD");
        if branch == "side" {
            git(&registered.checkout, &["checkout", "--quiet", "-b", branch]);
        }
        let merged = registered.merge("shared", "second\n");
        refused(&registered.update("diverged", &merged).await, "diverged");
        assert_eq!(registered.at("refs/heads/main"), local);
        assert_eq!(registered.read("shared"), "first\n");
    }
}

#[tokio::test]
async fn an_unfinished_operation_or_detached_head_is_left_alone() {
    let (registered, start) = level().await;
    let merged = registered.merge("shared", "second\n");
    let admin = registered.checkout.join(".git");
    std::fs::create_dir(admin.join("rebase-merge")).expect("rebase");
    refused(&registered.update("rebasing", &merged).await, "in a rebase");
    std::fs::remove_dir(admin.join("rebase-merge")).expect("rebase done");
    std::fs::write(admin.join("MERGE_HEAD"), format!("{start}\n")).expect("merge");
    refused(&registered.update("merging", &merged).await, "in a merge");
    std::fs::remove_file(admin.join("MERGE_HEAD")).expect("merge done");
    git(&registered.checkout, &["checkout", "--quiet", "--detach"]);
    refused(
        &registered.update("detached", &merged).await,
        "detached HEAD",
    );
    assert_eq!(registered.at("HEAD"), start);
    assert_eq!(registered.at("refs/heads/main"), start);
}

#[tokio::test]
async fn an_unpublished_merge_commit_never_reaches_the_base() {
    let (registered, start) = level().await;
    git(
        &registered.checkout,
        &["checkout", "--quiet", "-b", "unpublished"],
    );
    create_fixture_commit(&registered.checkout, "unpublished");
    let unpublished = registered.at("HEAD");
    git(&registered.checkout, &["checkout", "--quiet", "main"]);
    refused(
        &registered.update("unpublished", &unpublished).await,
        "published base does not contain",
    );
    assert_eq!(registered.at("HEAD"), start);
}

#[tokio::test]
async fn merges_in_quick_succession_apply_in_order() {
    let (registered, start) = level().await;
    let first = registered.merge("shared", "second\n");
    let second = registered.merge("shared", "third\n");
    registered.landed("first", &first).await;
    registered.landed("second", &second).await;
    registered.service.apply_merges().await;
    for id in ["first", "second"] {
        assert_eq!(registered.refusals(id).await, Vec::<String>::new());
    }
    assert_eq!(
        git(
            &registered.checkout,
            &["log", "--walk-reflogs", "--format=%H", "-3", "main"]
        ),
        format!("{second}\n{first}\n{start}")
    );
    // An earlier merge arriving late is already held.
    git(&registered.checkout, &["checkout", "--quiet", "-b", "side"]);
    assert_eq!(
        registered.update("late", &first).await,
        Vec::<String>::new()
    );
    assert_eq!(registered.at("refs/heads/main"), second);
}

#[tokio::test]
async fn an_update_past_its_deadline_is_recorded_and_holds_no_task_start() {
    let (mut registered, start) = level().await;
    let merged = registered.merge("shared", "second\n");
    let scratch = registered.checkout.with_file_name("hung-git");
    std::fs::create_dir(&scratch).expect("Git scratch");
    registered.service.git = crate::project::LocalGit(scratch.clone());
    let gate = crate::project::git_gate::install(scratch);
    gate.only.set("merge").unwrap();
    registered.service.volume.change = Duration::from_secs(3);
    refused(
        &registered.update("hung", &merged).await,
        "updating the registered checkout",
    );
    assert_eq!(registered.at("HEAD"), start);
    let row = registered.seed("next").await;
    assert_eq!(
        registered.allocate(&row).await.expect("allocate"),
        Some(Workspace::Clean(merged))
    );
    // The held update is not repeated beside itself.
    assert_eq!(gate.entered.load(Ordering::SeqCst), 1);
    gate.release();
}

#[tokio::test]
async fn an_observed_merge_queues_the_update_once() {
    let (registered, _) = level().await;
    let merged = registered.merge("shared", "second\n");
    let row = registered.seed("observed").await;
    let pr = nucleus_core::PullRequest {
        url: format!("https://github.com/{REPOSITORY}/pull/1"),
        head: merged.clone(),
    };
    let mut merging = serde_json::to_value(&row.task).expect("stored task");
    merging["phase"] = serde_json::json!("merging");
    merging["pr"] = serde_json::to_value(&pr).expect("pull request");
    merging["verdict"] = serde_json::json!({"reviewed": {
        "head": merged, "decision": "approve", "summary": "Synthetic approval.",
    }});
    let merging: Task = serde_json::from_value(merging).expect("merging task");
    let row = registered
        .service
        .save(&row, merging, &event("fixture"))
        .await
        .expect("merging row");
    let observation = Observation {
        host: Observed::Unknown,
        forge: Observed::Known(Forge::Merged {
            pr,
            commit: merged.clone(),
        }),
        workspace: Observed::Known(Workspace::Absent),
    };
    for phase in [Phase::Closing, Phase::Done] {
        let row = registered
            .service
            .task("observed")
            .await
            .unwrap_or(row.clone());
        let mut next = row.task.clone();
        if phase == Phase::Closing {
            let action = nucleus_core::decide(&next, &observation);
            registered
                .service
                .apply(&row, &observation, action)
                .await
                .expect("merge observed");
        } else {
            assert!(next.finish_close(&observation));
            let mut audit = event("closed_checkout_absent");
            crate::presentation::note_merge(&mut audit, &observation.forge);
            registered
                .service
                .save(&row, next, &audit)
                .await
                .expect("closed");
        }
        assert_eq!(
            registered
                .service
                .task("observed")
                .await
                .unwrap()
                .task
                .phase(),
            phase
        );
    }
    let mut due = registered.service.merges.due_for_test().await;
    assert_eq!(due.len(), 1, "closeout queues nothing further");
    let (task, commit) = due.remove(0);
    assert_eq!((task.id.as_str(), commit), ("observed", merged));
}

#[tokio::test]
async fn the_service_watcher_applies_a_landing() {
    let (registered, _) = level().await;
    let merged = registered.merge("shared", "second\n");
    registered.landed("watched", &merged).await;
    let applied = async {
        while registered.at("HEAD") != merged {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };
    tokio::select! {
        () = registered.service.watch_merges() => panic!("the watcher stopped"),
        done = tokio::time::timeout(Duration::from_secs(20), applied) => done.expect("applied"),
    }
}
