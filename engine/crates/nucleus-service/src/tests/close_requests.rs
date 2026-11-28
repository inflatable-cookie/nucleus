use super::*;
use axum::{
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse as _, Response},
};
use std::sync::atomic::AtomicBool;

fn representation(
    headers: &HeaderMap,
    tag: &'static str,
    body: Value,
    unchanged: &AtomicUsize,
) -> Response {
    if headers
        .get(header::IF_NONE_MATCH)
        .is_some_and(|value| value == tag)
    {
        unchanged.fetch_add(1, Ordering::Relaxed);
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        ([(header::ETAG, tag)], Json(body)).into_response()
    }
}

#[tokio::test]
async fn external_close_request_budget() {
    use nucleus_core::{Answer, Authority, Command, Question};
    let (home, mut service) = fixture(GitHub::new("unused-fixture").unwrap());
    let repo = &service.fixture().checkout;
    let recorded = service.fixture().start.clone();
    create_fixture_commit(repo, "external descendant");
    let head: Head = git(repo, &["rev-parse", "HEAD"]).parse().unwrap();
    git(repo, &["update-ref", "refs/pull/1/head", head.as_str()]);
    git(
        repo,
        &["remote", "set-url", "origin", repo.to_str().unwrap()],
    );
    let visits = home.path().join("upload-pack-count");
    git(
        repo,
        &[
            "config",
            "remote.origin.uploadpack",
            &format!("echo visit >> '{}'; exec git-upload-pack", visits.display()),
        ],
    );

    let (app, counts, merged) = close_forge(&recorded, &head);
    let (forge, server) = serve_forge(app).await;
    service.forge = forge;
    let (task, _) = code_task_at_merge("worker", &recorded);
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
    let host = service.host.fixture_pass();
    let advance = || async {
        let row = service.task("worker").await.unwrap();
        Box::pin(service.advance(&row, &host)).await
    };
    assert!(matches!(
        advance().await.unwrap(),
        Action::Wait(WaitReason::ForgeUnknown)
    ));
    merged.store(true, Ordering::Relaxed);
    assert_eq!(
        advance().await.unwrap(),
        Action::Ask(Question::Accept { head: head.clone() })
    );
    let operator = Authority::Operator {
        actor: "fixture".into(),
    };
    let answer = Command::Answer(Answer::Accept {
        head,
        reason: "Accepted the external source".into(),
    });
    // Acceptance depends on the observed merged PR and its source ancestry.
    for index in [0, 4, 5] {
        assert!(
            counts[index].load(Ordering::Relaxed) > 0,
            "missing acceptance evidence {index}"
        );
    }
    service.command("worker", &operator, answer).await.unwrap();
    assert_eq!(advance().await.unwrap(), Action::Advance(Phase::Closing));
    assert!(matches!(advance().await.unwrap(), Action::Close { .. }));
    assert_eq!(
        service.task("worker").await.unwrap().task.phase(),
        Phase::Done
    );
    let totals = counts.each_ref().map(|count| count.load(Ordering::Relaxed));
    let transports = std::fs::read_to_string(visits)
        .unwrap_or_default()
        .lines()
        .count();
    eprintln!(
        "PR, checks, branch, base compare, PR ref, source compare, 304 = {totals:?}; Git origin sessions = {transports}"
    );
    for (actual, ceiling) in totals.into_iter().zip([8, 2, 7, 2, 2, 2, 12]) {
        assert!(
            actual <= ceiling,
            "forge traffic {actual} exceeds {ceiling}"
        );
    }
    assert_eq!(transports, 0);
    server.abort();
}

fn close_forge(recorded: &Head, head: &Head) -> (Router, Arc<[AtomicUsize; 7]>, Arc<AtomicBool>) {
    let counts = Arc::new([const { AtomicUsize::new(0) }; 7]);
    let [prs, graphs, branches, compares, refs, source_comparisons] =
        std::array::from_fn(|_| counts.clone());
    let merged = Arc::new(AtomicBool::new(false));
    let remote_merged = merged.clone();
    let mut open = forge_pull(recorded);
    open["head"]["ref"] = json!("ns-worker");
    let mut closed = open.clone();
    closed["head"]["sha"] = json!(head);
    closed["merged"] = json!(true);
    closed["state"] = json!("closed");
    closed["merge_commit_sha"] = json!("e".repeat(40));
    let mut checks = forge_checks(recorded);
    let contexts =
        &mut checks["data"]["repository"]["pullRequest"]["statusCheckRollup"]["contexts"];
    contexts["pageInfo"]["hasNextPage"] = json!(true);
    contexts["nodes"] = json!((0..100).map(|index| json!({
        "__typename":"CheckRun","name":format!("check-{index}"),"conclusion":"SUCCESS","isRequired":true
    })).collect::<Vec<_>>());
    let tip = "b".repeat(40);
    let source_path = format!("/repos/{REPOSITORY}/compare/{recorded}...{head}");
    let advertised = head.clone();
    let app = Router::new()
        .route(
            &format!("/repos/{REPOSITORY}/git/ref/pull/1/head"),
            get(move || async move {
                refs[4].fetch_add(1, Ordering::Relaxed);
                Json(json!({"ref":"refs/pull/1/head", "object":{"type":"commit","sha":advertised}}))
            }),
        )
        .route(
            &source_path,
            get(move || async move {
                source_comparisons[5].fetch_add(1, Ordering::Relaxed);
                Json(json!({"status":"ahead"}))
            }),
        )
        .route(
            &format!("/repos/{REPOSITORY}/pulls/1"),
            get(move |headers: HeaderMap| async move {
                prs[0].fetch_add(1, Ordering::Relaxed);
                if remote_merged.load(Ordering::Relaxed) {
                    representation(&headers, "\"closed\"", closed, &prs[6])
                } else {
                    representation(&headers, "\"open\"", open, &prs[6])
                }
            }),
        )
        .route(
            "/graphql",
            post(move |Json(query): Json<Value>| async move {
                assert_eq!(query["variables"]["namedChecks"], true);
                graphs[1].fetch_add(1, Ordering::Relaxed);
                Json(checks)
            }),
        )
        .route(
            &format!("/repos/{REPOSITORY}/compare/{}...{tip}", "e".repeat(40)),
            get(move || async move {
                compares[3].fetch_add(1, Ordering::Relaxed);
                Json(json!({"status":"ahead"}))
            }),
        )
        .route(
            &format!("/repos/{REPOSITORY}/branches/main"),
            get(move |headers: HeaderMap| async move {
                branches[2].fetch_add(1, Ordering::Relaxed);
                representation(
                    &headers,
                    "\"base\"",
                    json!({"name":"main","commit":{"sha":tip}}),
                    &branches[6],
                )
            }),
        );
    (app, counts, merged)
}

// Replay the same demand without wall-clock sleeps. Each of seven externally
// merged PRs needs a publication check every 30 seconds in [0, 600).
#[tokio::test]
async fn seven_external_merges_over_ten_minutes() {
    use axum::extract::Path;
    use nucleus_forge::Branches;
    let counts = Arc::new([const { AtomicUsize::new(0) }; 4]);
    let [pulls, branches, compares] = std::array::from_fn(|_| counts.clone());
    let base = format!("/repos/{REPOSITORY}");
    let head: Head = "a".repeat(40).parse().unwrap();
    let pull = forge_pull(&head);
    let app = Router::new()
        .route(
            &format!("{base}/pulls/{{number}}"),
            get(
                move |Path(number): Path<u32>, headers: HeaderMap| async move {
                    pulls[0].fetch_add(1, Ordering::Relaxed);
                    let mut pr = pull;
                    pr["number"] = json!(number);
                    pr["html_url"] =
                        json!(format!("https://github.com/{REPOSITORY}/pull/{number}"));
                    pr["merged"] = json!(true);
                    pr["state"] = json!("closed");
                    pr["merge_commit_sha"] = json!(format!("{number:040x}"));
                    representation(&headers, "\"closed\"", pr, &pulls[3])
                },
            ),
        )
        .route(
            &format!("{base}/branches/main"),
            get(move |headers: HeaderMap| async move {
                branches[1].fetch_add(1, Ordering::Relaxed);
                representation(
                    &headers,
                    "\"base\"",
                    json!({"name":"main","commit":{"sha":"b".repeat(40)}}),
                    &branches[3],
                )
            }),
        )
        .route(
            &format!("{base}/compare/{{pair}}"),
            get(move || async move {
                compares[2].fetch_add(1, Ordering::Relaxed);
                Json(json!({"status":"ahead"}))
            }),
        );
    let (forge, server) = serve_forge(app).await;
    let branches = Branches::for_review_entry(REPOSITORY, "main").unwrap();
    let targets: Vec<_> = (1..=7)
        .map(|number| {
            branches
                .target(&format!("https://github.com/{REPOSITORY}/pull/{number}"))
                .unwrap()
        })
        .collect();
    for _ in (0..600).step_by(30) {
        for target in &targets {
            let Forge::Merged { commit, .. } = forge.observe(target).await.unwrap() else {
                panic!("merged fixture")
            };
            forge.verify_merge_base(target, &commit).await.unwrap();
        }
    }
    let totals = counts.each_ref().map(|value| value.load(Ordering::Relaxed));
    eprintln!("Ten-minute replay: PR, branch, compare, 304 = {totals:?}");
    // Bound requests and full representations independently; 304s are reads too.
    for (actual, ceiling) in totals[..3].iter().zip([150, 150, 10]) {
        assert!(
            *actual <= ceiling,
            "forge traffic {actual} exceeds {ceiling}"
        );
    }
    assert!(
        totals[0] + totals[1] - totals[3] <= 16,
        "too many full representations: {totals:?}"
    );
    server.abort();
}
