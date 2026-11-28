use crate::tests::registry_fixture;
use axum::routing::put;

use super::*;
use crate::tests::{create_fixture_commit, forge_checks, git};
use nucleus_core::{Head, Workspace};
use nucleus_forge::Branches;

const BRIEF: &str = "---\nqueue:\n  complexity: low\n  mergeHold: true\n  mergeHoldReason: Verify the release evidence\n---\nPublish the reviewed candidate.";
const OWNER: &str = "fixture-planner";
const ID: &str = "candidate";

#[tokio::test]
async fn admission_names_bad_merge_hold_and_unknown_queue_keys() {
    let (_home, service) = registry_fixture(GitHub::new("fixture").unwrap());
    let api = settings_api(&Arc::new(service));
    for (queue, error) in [
        ("  mergeHold: true\n", "requires a queue.mergeHoldReason"),
        ("  mergeHlod: true\n", "unknown queue key: queue.mergeHlod"),
    ] {
        let brief = format!("---\nqueue:\n  complexity: low\n{queue}---\nHeld work");
        let response = post_as(
            &api,
            "/v1/tasks",
            &BOARD_KEY,
            &json!({"id": ID, "reference": ID, "brief": brief}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let refusal = json_body(response).await;
        assert!(
            refusal["error"].as_str().unwrap().contains(error),
            "{refusal}"
        );
    }
    assert_eq!(
        json_body(get_as(&api, "/v1/tasks", &BOARD_KEY).await).await,
        json!([])
    );
}

#[tokio::test]
async fn a_held_brief_waits_for_release_then_publishes_the_reviewed_head() {
    let (_home, mut service) = fixture(GitHub::new("fixture").unwrap());
    let repo = &service.fixture().checkout;
    let base = service.fixture().start.clone();
    let (head, merge, tip) = merge_graph(repo, &base);
    let (forge, writes, server) = merge_forge(repo, &base, &head, &merge, &tip).await;
    service.forge = forge;
    service
        .admit(
            ID.into(),
            ID.into(),
            BRIEF.into(),
            &Authority::Planner {
                actor: OWNER.into(),
            },
        )
        .await
        .unwrap();
    let admitted = service.task(ID).await.unwrap();
    let hold = admitted.task.merge_hold().unwrap();
    assert_eq!(hold.actor.as_deref(), Some(OWNER));
    assert!(hold.since_ms.is_some());
    let approved = approve_candidate(admitted.task.clone(), &head);
    service
        .save(&admitted, approved, &event("fixture_reports"))
        .await
        .unwrap();

    let service = Arc::new(service);
    let api = settings_api(&service);
    let next_path = format!("/v1/tasks/{ID}/next");
    let results = service.pass().await.unwrap();
    assert_eq!(
        results.into_iter().next().unwrap().result.unwrap(),
        Action::Wait(WaitReason::MergeHold)
    );
    assert_eq!(writes.load(Ordering::Relaxed), 0);
    let next = json_body(get_as(&api, &next_path, &BOARD_KEY).await).await;
    assert_eq!(next["wait"], "merge_hold");
    assert_eq!(next["stateLabel"], "Merge held by planner");
    assert_eq!(next["waitDetail"], "Verify the release evidence");
    assert_eq!(next["hold"]["actor"], OWNER);
    assert_eq!(next["hold"]["since_ms"], hold.since_ms.unwrap());
    assert!(next["commands"].as_array().unwrap().contains(&json!({
        "name": "release", "preflight": "ready"
    })));
    let list = json_body(get_as(&api, "/v1/tasks", &BOARD_KEY).await).await;
    assert_eq!(list[0]["stateLabel"], next["stateLabel"]);
    assert_eq!(list[0]["hold"]["reason"], next["waitDetail"]);

    let commands = format!("/v1/tasks/{ID}/commands");
    let response = post_as(&api, &commands, &BOARD_KEY, &json!("release")).await;
    assert_eq!(response.status(), StatusCode::OK);
    let results = service.pass().await.unwrap();
    assert_eq!(
        results.into_iter().next().unwrap().result.unwrap(),
        Action::Advance(Phase::Closing)
    );
    assert_eq!(writes.load(Ordering::Relaxed), 1);

    let branches = Branches::new(REPOSITORY, "main", "ns-candidate").unwrap();
    let target = branches.target(PR).unwrap();
    let observed = service.forge.observe(&target).await.unwrap();
    assert!(matches!(observed, Forge::Merged { pr, commit } if pr.head == head && commit == merge));
    service
        .forge
        .verify_merge_base(&target, &merge)
        .await
        .unwrap();
    assert!(
        service
            .forge
            .contains(&branches, &head, &tip)
            .await
            .unwrap()
    );
    let results = service.pass().await.unwrap();
    assert!(matches!(&results[0].result, Ok(Action::Close { commit, .. }) if commit == &merge));
    assert_eq!(service.task(ID).await.unwrap().task.phase(), Phase::Done);
    server.abort();
}

fn approve_candidate(mut task: Task, head: &Head) -> Task {
    let pr = PullRequest {
        url: PR.into(),
        head: head.clone(),
    };
    let mut observation = Observation {
        forge: Observed::Known(Forge::Absent),
        host: Observed::Unknown,
        workspace: Observed::Known(Workspace::Absent),
    };
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Working)
    );
    for (thread, report, next) in [
        ("worker", Report::Work(pr.clone().into()), Phase::Reviewing),
        (
            "reviewer",
            Report::Review {
                head: head.clone(),
                decision: Review::Approve,
                summary: "Reviewed the candidate".into(),
                finding_titles: Vec::new(),
            },
            Phase::Merging,
        ),
    ] {
        let credential = task
            .reserve_launch(
                &observation,
                LaunchInputs {
                    scratch: None,
                    thread: thread.into(),
                    started_at: 1,
                    input: thread.into(),
                },
                &[3; 32],
            )
            .unwrap();
        let instance = task.run().unwrap().launch().instance.clone();
        task.record_report(&instance, credential.as_bytes(), report)
            .unwrap();
        observation = Observation {
            forge: Observed::Known(Forge::Open {
                pr: pr.clone(),
                checks: CheckState::Ready,
            }),
            host: Observed::Known(Host::Current {
                instance,
                state: RunState::Ended,
            }),
            workspace: Observed::Known(Workspace::Clean(head.clone())),
        };
        assert_eq!(task.reconcile(&observation), Action::Advance(next));
    }
    task
}

fn merge_graph(repo: &std::path::Path, base: &Head) -> (Head, Head, Head) {
    git(repo, &["switch", "-c", "fixture-source"]);
    create_fixture_commit(repo, "Reviewed candidate");
    let head: Head = git(repo, &["rev-parse", "HEAD"]).parse().unwrap();
    git(repo, &["switch", "main"]);
    git(
        repo,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "merge",
            "--no-ff",
            "-m",
            "Merge reviewed candidate",
            "fixture-source",
        ],
    );
    let merge: Head = git(repo, &["rev-parse", "HEAD"]).parse().unwrap();
    assert_eq!(
        git(repo, &["rev-list", "--parents", "-n", "1", merge.as_str()]),
        format!("{merge} {base} {head}")
    );
    create_fixture_commit(repo, "Advance the base after merge");
    let tip = git(repo, &["rev-parse", "HEAD"]).parse().unwrap();
    (head, merge, tip)
}

async fn merge_forge(
    repo: &std::path::Path,
    base: &Head,
    head: &Head,
    merge: &Head,
    tip: &Head,
) -> (GitHub, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let writes = Arc::new(AtomicUsize::new(0));
    let (read, write) = (writes.clone(), writes.clone());
    let mut pull = forge_pull(head);
    pull["head"]["ref"] = json!("ns-candidate");
    pull["base"]["sha"] = json!(base);
    let mut closed = pull.clone();
    closed["merged"] = json!(true);
    closed["state"] = json!("closed");
    closed["merge_commit_sha"] = json!(merge);
    let mut checks = forge_checks(head);
    checks["data"]["repository"]["pullRequest"]["baseRefOid"] = json!(base);
    let expected = json!({"sha": head, "merge_method": "merge"});
    let receipt = json!({"merged": true, "sha": merge});
    let branch = json!({"name": "main", "commit": {"sha": tip}});
    let repo = repo.to_owned();
    let (forge, server) = serve_forge(
        Router::new()
            .route(
                &format!("/repos/{REPOSITORY}/pulls/1"),
                get(move || async move {
                    Json(if read.load(Ordering::Relaxed) == 0 {
                        pull
                    } else {
                        closed
                    })
                }),
            )
            .route("/graphql", post(move || async move { Json(checks) }))
            .route(
                &format!("/repos/{REPOSITORY}/pulls/1/merge"),
                put(move |Json(body): Json<Value>| async move {
                    assert_eq!(body, expected);
                    write.fetch_add(1, Ordering::Relaxed);
                    Json(receipt)
                }),
            )
            .route(
                &format!("/repos/{REPOSITORY}/branches/main"),
                get(move || async move { Json(branch) }),
            )
            .route(
                &format!("/repos/{REPOSITORY}/compare/{{pair}}"),
                get(
                    move |axum::extract::Path(pair): axum::extract::Path<String>| async move {
                        let (ancestor, descendant) = pair.split_once("...").unwrap();
                        assert_eq!(git(&repo, &["merge-base", ancestor, descendant]), ancestor);
                        Json(json!({"status": "ahead"}))
                    },
                ),
            ),
    )
    .await;
    (forge, writes, server)
}
