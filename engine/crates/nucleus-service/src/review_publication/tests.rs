use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post, put},
};
use nucleus_core::{Entry, Question};
use nucleus_store::{GitHubAccount, Store};
use serde_json::{Value, json};
use tokio::{net::TcpListener, sync::Notify, task::JoinHandle};

use super::*;
use crate::{
    github_accounts::GitHubAccounts,
    tests::{REPOSITORY, fixture, forge_checks, forge_pull, reservation},
};

const TASK: &str = "reviewer";
const OPERATOR: &str = "Bearer fixture-token";
const REVIEWER: &str = "Bearer selected-reviewer";
const REPLACEMENT: &str = "Bearer replacement-reviewer";

#[derive(Clone, Copy)]
enum Delivery {
    Saved,
    Lost,
    Denied(StatusCode),
    StopAtUnauthorized,
    MissingById,
    Throttle(&'static str),
}

struct ForgeFixture {
    address: std::sync::OnceLock<std::net::SocketAddr>,
    author: u64,
    delivery: Delivery,
    merged: AtomicBool,
    visible: AtomicBool,
    visible_at_inventory: AtomicUsize,
    dismissed: AtomicBool,
    posted: Notify,
    respond: Notify,
    posts: Mutex<Vec<(String, Value)>>,
    remote: Mutex<Option<Value>>,
    reads: AtomicUsize,
    merges: AtomicUsize,
}

impl ForgeFixture {
    fn new(author: u64, delivery: Delivery) -> Arc<Self> {
        Arc::new(Self {
            address: std::sync::OnceLock::default(),
            author,
            delivery,
            merged: AtomicBool::new(false),
            visible: AtomicBool::new(true),
            visible_at_inventory: AtomicUsize::new(usize::MAX),
            dismissed: AtomicBool::new(false),
            posted: Notify::new(),
            respond: Notify::new(),
            posts: Mutex::default(),
            remote: Mutex::default(),
            reads: AtomicUsize::new(0),
            merges: AtomicUsize::new(0),
        })
    }
}

fn bearer(headers: &HeaderMap) -> &str {
    headers["authorization"].to_str().unwrap()
}

fn reviewer_id(headers: &HeaderMap) -> u64 {
    match bearer(headers) {
        REVIEWER => 42,
        REPLACEMENT => 43,
        OPERATOR => 11,
        value => panic!("unexpected synthetic credential {value}"),
    }
}

async fn post_review(
    State(remote): State<Arc<ForgeFixture>>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> impl IntoResponse {
    let id = reviewer_id(&headers);
    let attempt = {
        let mut posts = remote.posts.lock().unwrap();
        posts.push((bearer(&headers).into(), input.clone()));
        posts.len()
    };
    if let Delivery::Throttle(after) = remote.delivery
        && attempt <= 2
    {
        let status = if attempt == 1 {
            StatusCode::TOO_MANY_REQUESTS
        } else {
            StatusCode::FORBIDDEN
        };
        return (
            status,
            [("retry-after", after), ("x-ratelimit-remaining", "0")],
        )
            .into_response();
    }
    if let Delivery::Denied(status) = remote.delivery {
        return (
            status,
            Json(json!({"message": "Review publication refused by repository policy"})),
        )
            .into_response();
    }
    if matches!(remote.delivery, Delivery::StopAtUnauthorized) {
        remote.posted.notify_one();
        remote.respond.notified().await;
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let state = match input["event"].as_str() {
        Some("COMMENT") => "COMMENTED",
        Some("APPROVE") if id != remote.author => "APPROVED",
        Some("REQUEST_CHANGES") if id != remote.author => "CHANGES_REQUESTED",
        _ => return StatusCode::UNPROCESSABLE_ENTITY.into_response(),
    };
    let review = json!({
        "id": 17,
        "user": {"id": id, "login": "review-fixture"},
        "commit_id": input["commit_id"],
        "state": state,
        "body": input["body"],
    });
    *remote.remote.lock().unwrap() = Some(review.clone());
    match remote.delivery {
        Delivery::Saved | Delivery::MissingById | Delivery::Throttle(_) => {
            (StatusCode::CREATED, Json(review)).into_response()
        }
        Delivery::Lost => {
            (StatusCode::BAD_GATEWAY, [("x-ratelimit-remaining", "0")]).into_response()
        }
        Delivery::Denied(_) | Delivery::StopAtUnauthorized => unreachable!(),
    }
}

async fn list_reviews(
    State(remote): State<Arc<ForgeFixture>>,
    headers: HeaderMap,
) -> Json<Vec<Value>> {
    assert_eq!(bearer(&headers), OPERATOR);
    let inventory = remote.reads.fetch_add(1, Ordering::Relaxed) + 1;
    let visible = remote.visible.load(Ordering::Relaxed)
        || inventory >= remote.visible_at_inventory.load(Ordering::Relaxed);
    let review = remote.remote.lock().unwrap();
    Json(review.iter().filter(|_| visible).cloned().collect())
}

async fn read_review(
    State(remote): State<Arc<ForgeFixture>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    assert_eq!(bearer(&headers), OPERATOR);
    if matches!(remote.delivery, Delivery::MissingById) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(mut review) = remote.remote.lock().unwrap().clone() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if remote.dismissed.load(Ordering::Relaxed) {
        review["state"] = "DISMISSED".into();
    }
    Json(review).into_response()
}

async fn create_service(
    remote: &Arc<ForgeFixture>,
) -> (tempfile::TempDir, Service, JoinHandle<()>) {
    let (home, mut service) = fixture(GitHub::new("unused-fixture").unwrap());
    let head = service.fixture().start.clone();
    let mut pull = forge_pull(&head);
    pull["user"] = json!({"id": remote.author, "login": "author"});
    let checks = forge_checks(&head);
    let pr_path = format!("/repos/{REPOSITORY}/pulls/1");
    let router = Router::new()
        .route(
            &format!("/repos/{REPOSITORY}/branches/main"),
            get(|| async { Json(json!({"name":"main","commit":{"sha":"f".repeat(40)}})) }),
        )
        .route(
            "/user",
            get(|headers: HeaderMap| async move {
                Json(json!({"id": reviewer_id(&headers), "login": "review-fixture"}))
            }),
        )
        .route(
            &pr_path,
            get(
                move |State(remote): State<Arc<ForgeFixture>>, headers: HeaderMap| async move {
                    assert_eq!(bearer(&headers), OPERATOR);
                    let mut pull = pull;
                    if remote.merged.load(Ordering::Relaxed) {
                        pull["merged"] = true.into();
                        pull["state"] = "closed".into();
                        pull["merge_commit_sha"] = "f".repeat(40).into();
                    }
                    Json(pull)
                },
            ),
        )
        .route(
            "/graphql",
            post(move |headers: HeaderMap| async move {
                assert_eq!(bearer(&headers), OPERATOR);
                Json(checks)
            }),
        )
        .route(
            &format!("{pr_path}/reviews"),
            get(list_reviews).post(post_review),
        )
        .route(&format!("{pr_path}/reviews/17"), get(read_review))
        .route(
            &format!("{pr_path}/merge"),
            put(|State(remote): State<Arc<ForgeFixture>>| async move {
                remote.merges.fetch_add(1, Ordering::Relaxed);
                StatusCode::FORBIDDEN
            }),
        )
        .with_state(remote.clone());
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    remote.address.set(address).unwrap();
    service.forge = GitHub::loopback_fixture(address).unwrap();
    service.github_accounts = Arc::new(GitHubAccounts::with_fixture(
        service.settings.clone(),
        &format!("http://{address}"),
    ));
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (home, service, server)
}

fn select_reviewer(service: &Service, id: u64, token: &str) {
    service
        .github_accounts
        .seed_reviewer_fixture(
            &GitHubAccount {
                host: "github.com".into(),
                user_id: id.to_string(),
                login: "review-fixture".into(),
            },
            token,
        )
        .unwrap();
}

async fn record_report(service: &Service, decision: Review) -> String {
    let head = service.fixture().start.clone();
    let (task, credential, _) = reservation(TASK, Entry::ReviewEntry, &head);
    let instance = task.run().unwrap().launch().instance.clone();
    service
        .state
        .lock()
        .await
        .store
        .create(&task, &event("fixture"))
        .unwrap();
    service
        .report(
            TASK,
            &instance,
            credential.as_bytes(),
            Report::Review {
                head,
                decision,
                summary: "Synthetic summary".into(),
                finding_titles: if decision == Review::Changes {
                    vec!["Add coverage".into()]
                } else {
                    Vec::new()
                },
            },
        )
        .await
        .unwrap();
    instance
}

fn restart_service(service: Service, remote: &ForgeFixture) -> Service {
    let project = service.fixture().clone();
    let settings = service.settings.clone();
    let forge = GitHub::loopback_fixture(*remote.address.get().unwrap()).unwrap();
    let callback = service.callback;
    let report_command = service.report_command.clone();
    drop(service);
    let host = nucleus_hosts::T3::new("http://127.0.0.1:9", "unused-fixture-key").unwrap();
    Service::open(&settings, project, host, forge, callback, report_command).unwrap()
}

async fn advance(service: &Service) -> Result<Action, ServiceError> {
    let row = service.task(TASK).await.unwrap();
    service.advance(&row, &service.host.fixture_pass()).await
}

#[tokio::test]
async fn formal_review_reconciles_once_under_the_original_account_and_fences_merge() {
    let remote = ForgeFixture::new(10, Delivery::Lost);
    remote.visible.store(false, Ordering::Relaxed);
    let (_home, service, server) = create_service(&remote).await;
    select_reviewer(&service, 42, "selected-reviewer");
    let instance = record_report(&service, Review::Approve).await;
    for _ in 0..2 {
        assert!(matches!(
            advance(&service).await,
            Err(ServiceError::ReviewPublication(
                PublicationError::UnknownDelivery
            ))
        ));
    }
    assert_eq!(remote.reads.load(Ordering::Relaxed), 2);
    assert_eq!(remote.posts.lock().unwrap().len(), 1);
    let store = Store::open(&service.storage).unwrap();
    let retained = store.review_publication(TASK, &instance).unwrap().unwrap();
    assert_eq!(retained.outcome, ReviewPublicationOutcome::Pending);
    assert_eq!(retained.response.as_deref(), Some("GitHub HTTP 502"));
    let row = service.task(TASK).await.unwrap();
    let (wait, detail) = crate::task_wait(&row, &Err(PublicationError::UnknownDelivery.into()));
    assert_eq!(
        crate::titles::task_state_label(&row.task, wait, detail.as_ref()),
        "Reviewing · confirming review"
    );
    let (wait, detail) = crate::task_wait(&row, &Err(ForgeError::Incomplete.into()));
    assert_eq!(
        crate::titles::task_state_label(&row.task, wait, detail.as_ref()),
        "Reviewing · GitHub"
    );
    assert_eq!(retained.intent.author.get(), 42);
    assert_eq!(retained.intent.head, service.fixture().start);
    assert!(service.task(TASK).await.unwrap().task.verdict().is_none());

    select_reviewer(&service, 43, "replacement-reviewer");
    remote.visible.store(true, Ordering::Relaxed);
    assert_eq!(
        advance(&service).await.unwrap(),
        Action::Advance(Phase::Merging)
    );
    assert_eq!(remote.posts.lock().unwrap()[0].0, REVIEWER);
    assert_eq!(remote.posts.lock().unwrap().len(), 1);
    assert!(matches!(
        store.review_publication(TASK, &instance).unwrap().unwrap().outcome,
        ReviewPublicationOutcome::Verified(id) if id.get() == 17
    ));

    remote.dismissed.store(true, Ordering::Relaxed);
    assert!(matches!(
        advance(&service).await,
        Err(ServiceError::ReviewPublication(
            PublicationError::Unverified
        ))
    ));
    assert_eq!(remote.merges.load(Ordering::Relaxed), 0);
    server.abort();
}

#[tokio::test]
async fn formal_changes_use_installed_gh_when_unset_and_keep_findings() {
    for (author, expected) in [(10, "REQUEST_CHANGES"), (11, "COMMENT")] {
        let remote = ForgeFixture::new(author, Delivery::Saved);
        let (_home, service, server) = create_service(&remote).await;
        let instance = record_report(&service, Review::Changes).await;
        assert_eq!(
            advance(&service).await.unwrap(),
            Action::Advance(Phase::Working)
        );
        let posts = remote.posts.lock().unwrap();
        assert_eq!(posts.len(), 1);
        let (bearer, input) = &posts[0];
        assert_eq!(bearer, OPERATOR);
        assert_eq!(input["event"], expected);
        assert_eq!(input["commit_id"], json!(service.fixture().start));
        let body = input["body"].as_str().unwrap();
        assert!(body.contains("Synthetic summary"));
        assert!(body.contains("- Add coverage"));
        assert!(body.contains(&digest(&instance)));
        server.abort();
    }
}

#[tokio::test]
async fn formal_approval_refuses_the_same_author_and_inaccessible_role() {
    for (author, delivery) in [
        (42, Delivery::Saved),
        (10, Delivery::Denied(StatusCode::FORBIDDEN)),
        (10, Delivery::Denied(StatusCode::NOT_FOUND)),
        (10, Delivery::Denied(StatusCode::UNPROCESSABLE_ENTITY)),
    ] {
        let remote = ForgeFixture::new(author, delivery);
        let (_home, service, server) = create_service(&remote).await;
        select_reviewer(&service, 42, "selected-reviewer");
        let instance = record_report(&service, Review::Approve).await;
        let error = advance(&service).await.unwrap_err();
        let ServiceError::ReviewPublication(error) = error else {
            panic!("expected a typed publication blocker")
        };
        assert_eq!(error.wait().0, WaitReason::ReviewPublicationBlocked);
        let store = service.state.lock().await;
        let record = store.store.review_publication(TASK, &instance).unwrap();
        let posts = remote.posts.lock().unwrap();
        if author == 42 {
            assert!(matches!(error, PublicationError::SameAuthor));
            assert!(record.is_none());
            assert!(posts.is_empty());
        } else {
            let Delivery::Denied(status) = delivery else {
                unreachable!()
            };
            let record = record.unwrap();
            assert_eq!(
                record.outcome,
                if status == StatusCode::UNPROCESSABLE_ENTITY {
                    ReviewPublicationOutcome::Refused
                } else {
                    ReviewPublicationOutcome::AccessRefused
                }
            );
            let receipt = format!(
                "GitHub HTTP {}: Review publication refused by repository policy",
                status.as_u16()
            );
            assert_eq!(record.response.as_deref(), Some(receipt.as_str()));
            let (_, WaitDetail::Blocked(cause)) = error.wait() else {
                panic!("expected owner action detail")
            };
            assert!(
                cause.contains(&receipt)
                    && cause.contains(&record.intent.pull_url)
                    && cause.contains("Move to review")
            );
            assert_eq!(posts.len(), 1);
            assert_eq!(posts[0].0, REVIEWER);
        }
        server.abort();
    }
}

#[tokio::test]
async fn an_external_merge_with_only_a_pending_report_requires_source_acceptance() {
    let remote = ForgeFixture::new(10, Delivery::Saved);
    remote.merged.store(true, Ordering::Relaxed);
    let (_home, service, server) = create_service(&remote).await;
    record_report(&service, Review::Approve).await;
    assert!(matches!(
        advance(&service).await.unwrap(),
        Action::Ask(Question::Accept { .. })
    ));
    assert!(service.task(TASK).await.unwrap().task.verdict().is_none());
    assert!(remote.posts.lock().unwrap().is_empty());
    server.abort();
}

async fn aged_claim(service: &Service, instance: &str) -> (ReviewIntent, ReviewBody) {
    let row = service.task(TASK).await.unwrap();
    let body = review_body(row.task.run().unwrap(), "Synthetic summary", &[]);
    let intent = ReviewIntent {
        instance: instance.into(),
        pull_url: forge_pull(&service.fixture().start)["html_url"]
            .as_str()
            .unwrap()
            .into(),
        head: service.fixture().start.clone(),
        decision: Review::Approve,
        author: NonZeroU64::new(11).unwrap(),
        pull_author: NonZeroU64::new(10).unwrap(),
        body_digest: body.digest.clone(),
    };
    let mut state = service.state.lock().await;
    let at = event("fixture").at - FINAL_RETRY_DELAY_MS - REVIEW_GRACE_MS;
    assert!(
        state
            .store
            .claim_review_publication(TASK, &intent, None, at)
            .unwrap()
            .is_some()
    );
    (intent, body)
}

#[tokio::test]
async fn claimed_review_survives_reopen_and_resubmits_once_after_complete_absence() {
    let remote = ForgeFixture::new(10, Delivery::Lost);
    remote.visible.store(false, Ordering::Relaxed);
    let (_home, mut service, server) = create_service(&remote).await;
    let instance = record_report(&service, Review::Approve).await;
    let (intent, body) = aged_claim(&service, &instance).await;
    service = restart_service(service, &remote);
    assert!(remote.posts.lock().unwrap().is_empty());
    for _ in 0..2 {
        assert!(matches!(
            advance(&service).await,
            Err(ServiceError::ReviewPublication(
                PublicationError::UnknownDelivery
            ))
        ));
        service = restart_service(service, &remote);
        let state = service.state.lock().await;
        let record = state
            .store
            .review_publication(TASK, &instance)
            .unwrap()
            .unwrap();
        assert_eq!(record.intent, intent);
        assert_eq!(record.outcome, ReviewPublicationOutcome::Resubmitted);
    }
    assert_eq!(remote.reads.load(Ordering::Relaxed), 3);
    remote.visible.store(true, Ordering::Relaxed);
    assert_eq!(
        advance(&service).await.unwrap(),
        Action::Advance(Phase::Merging)
    );
    let posts = remote.posts.lock().unwrap();
    assert_eq!(posts.len(), 1);
    assert_eq!(posts[0].0, OPERATOR);
    assert_eq!(
        posts[0].1,
        json!({"body":body.text, "event":"APPROVE","commit_id":intent.head})
    );
    server.abort();
}

#[tokio::test]
async fn late_marker_at_claim_time_settles_the_original_without_another_post() {
    let remote = ForgeFixture::new(10, Delivery::Saved);
    remote.visible.store(false, Ordering::Relaxed);
    remote.visible_at_inventory.store(2, Ordering::Relaxed);
    let (_home, service, server) = create_service(&remote).await;
    let instance = record_report(&service, Review::Approve).await;
    let (intent, body) = aged_claim(&service, &instance).await;
    *remote.remote.lock().unwrap() = Some(json!({
        "id": 17, "user": {"id": intent.author, "login": "fixture-reviewer"},
        "commit_id": intent.head, "state": "APPROVED", "body": body.text
    }));
    assert_eq!(
        advance(&service).await.unwrap(),
        Action::Advance(Phase::Merging)
    );
    assert!(remote.posts.lock().unwrap().is_empty());
    let state = service.state.lock().await;
    let record = state
        .store
        .review_publication(TASK, &instance)
        .unwrap()
        .unwrap();
    assert!(matches!(record.outcome, ReviewPublicationOutcome::Verified(id) if id.get() == 17));
    server.abort();
}

#[tokio::test]
async fn aged_marker_free_resubmission_gets_one_final_bound_attempt() {
    for visible in [true, false] {
        let remote = ForgeFixture::new(10, Delivery::Lost);
        remote.visible.store(visible, Ordering::Relaxed);
        let (_home, mut service, server) = create_service(&remote).await;
        let instance = record_report(&service, Review::Approve).await;
        let (intent, body) = aged_claim(&service, &instance).await;
        {
            let mut state = service.state.lock().await;
            let previous = state
                .store
                .review_publication(TASK, &instance)
                .unwrap()
                .unwrap();
            let at = event("fixture").at - FINAL_RETRY_DELAY_MS;
            assert_eq!(
                state
                    .store
                    .claim_review_publication(TASK, &intent, Some(&previous), at)
                    .unwrap(),
                Some(ReviewPublicationOutcome::Resubmitted)
            );
        }
        service = restart_service(service, &remote);
        let result = advance(&service).await;
        // The simulated gateway also advertises an empty quota. Its account-wide
        // deferral keeps the immediate readback off the wire. Reopen the service
        // to observe exactly what the persisted final claim permits.
        assert!(matches!(
            result,
            Err(ServiceError::Forge(ForgeError::Deferred { .. }))
        ));
        service = restart_service(service, &remote);
        let result = advance(&service).await;
        if visible {
            assert_eq!(result.unwrap(), Action::Advance(Phase::Merging));
        } else {
            let error = result.unwrap_err();
            let ServiceError::ReviewPublication(blocked) = error else {
                panic!("expected owner action")
            };
            let (wait, WaitDetail::Blocked(cause)) = blocked.wait() else {
                panic!("expected owner action detail")
            };
            assert!(cause.contains("GitHub HTTP 502") && cause.contains(&intent.pull_url));
            assert_eq!(wait, WaitReason::ReviewPublicationBlocked);
            assert!(cause.contains("Move to review"));
            service = restart_service(service, &remote);
            assert_eq!(
                advance(&service).await.unwrap_err().to_string(),
                blocked.to_string()
            );
            remote.visible.store(true, Ordering::Relaxed);
            assert_eq!(
                advance(&service).await.unwrap(),
                Action::Advance(Phase::Merging)
            );
        }
        let posts = remote.posts.lock().unwrap();
        assert_eq!(
            posts.as_slice(),
            &[(
                OPERATOR.to_owned(),
                json!({
                    "body": body.text, "event": "APPROVE", "commit_id": intent.head,
                })
            )]
        );
        server.abort();
    }
}

#[tokio::test]
async fn dispatch_stopped_after_unauthorized_post_keeps_the_claim_pending() {
    let remote = ForgeFixture::new(10, Delivery::StopAtUnauthorized);
    let (_home, service, server) = create_service(&remote).await;
    select_reviewer(&service, 42, "selected-reviewer");
    let instance = record_report(&service, Review::Approve).await;
    let (result, ()) = tokio::join!(advance(&service), async {
        remote.posted.notified().await;
        service
            .state
            .lock()
            .await
            .settings
            .dispatch
            .get_or_insert_with(Default::default)
            .mode = DispatchMode::Stopped;
        remote.respond.notify_one();
    });
    assert_eq!(result.unwrap(), Action::Wait(WaitReason::Stopping));
    let store = Store::open(&service.storage).unwrap();
    assert_eq!(
        store
            .review_publication(TASK, &instance)
            .unwrap()
            .unwrap()
            .outcome,
        ReviewPublicationOutcome::Pending
    );
    assert_eq!(remote.posts.lock().unwrap().len(), 1);
    server.abort();
}

#[tokio::test]
async fn missing_submitted_review_gives_unverified_attention() {
    let remote = ForgeFixture::new(10, Delivery::MissingById);
    let (_home, service, server) = create_service(&remote).await;
    record_report(&service, Review::Approve).await;
    for _ in 0..2 {
        assert!(matches!(
            advance(&service).await,
            Err(ServiceError::ReviewPublication(
                PublicationError::Unverified
            ))
        ));
    }
    assert_eq!(remote.posts.lock().unwrap().len(), 1);
    server.abort();
}

#[tokio::test]
async fn throttled_resubmission_waits_for_the_server_deadline_after_restart() {
    let remote = ForgeFixture::new(10, Delivery::Throttle("3600"));
    let (_home, service, server) = create_service(&remote).await;
    let instance = record_report(&service, Review::Approve).await;
    aged_claim(&service, &instance).await;
    let before = SystemTime::now();
    let Err(ServiceError::Forge(ForgeError::Deferred { until })) = advance(&service).await else {
        panic!("expected a definite throttle");
    };
    assert!(until >= before + std::time::Duration::from_hours(1));
    let row = service.task(TASK).await.unwrap();
    service
        .schedule_result(
            &row,
            &Err(ForgeError::Deferred { until }.into()),
            crate::schedule::Priority::Effect,
        )
        .await
        .unwrap();
    let deadline = {
        let mut state = service.state.lock().await;
        let deadline = state.schedule.due(TASK).unwrap();
        assert!(deadline >= tokio::time::Instant::now() + std::time::Duration::from_mins(59));
        state
            .observe_wait_detail(
                &row.task,
                Some(WaitReason::ForgeUnknown),
                Some(WaitDetail::Observation("Updated wording.")),
            )
            .unwrap();
        assert_eq!(state.schedule.due(TASK), Some(deadline));
        deadline
    };
    assert_eq!(
        service.state.lock().await.schedule.due(TASK),
        Some(deadline)
    );
    let service = restart_service(service, &remote);
    assert!(matches!(advance(&service).await,
        Err(ServiceError::Forge(ForgeError::Deferred { until: retained })) if retained == until));
    assert_eq!(remote.posts.lock().unwrap().len(), 1);
    server.abort();
}

#[tokio::test]
async fn repeated_throttles_of_the_first_write_allow_later_publication() {
    Box::pin(assert_throttled_publication(false)).await;
}

#[tokio::test]
async fn throttled_resubmission_rechecks_the_original_before_retrying() {
    Box::pin(assert_throttled_publication(true)).await;
}

async fn assert_throttled_publication(resubmission: bool) {
    let remote = ForgeFixture::new(10, Delivery::Throttle("0"));
    let (_home, mut service, server) = create_service(&remote).await;
    let instance = record_report(&service, Review::Approve).await;
    if resubmission {
        aged_claim(&service, &instance).await;
    }
    for attempt in 1..=2 {
        let Err(ServiceError::Forge(ForgeError::Deferred { until })) = advance(&service).await
        else {
            panic!("expected GitHub to defer attempt {attempt}");
        };
        service = restart_service(service, &remote);
        let retained = service
            .state
            .lock()
            .await
            .store
            .review_publication(TASK, &instance)
            .unwrap()
            .unwrap();
        assert_eq!(
            retained.outcome,
            if resubmission {
                ReviewPublicationOutcome::ResubmissionDeferred(until)
            } else {
                ReviewPublicationOutcome::Deferred(until)
            }
        );
    }
    assert_eq!(
        advance(&service).await.unwrap(),
        Action::Advance(Phase::Merging)
    );
    let posts = remote.posts.lock().unwrap();
    assert_eq!(posts.len(), 3);
    // Each resubmission reconciles the original, including after the successful POST.
    assert_eq!(
        remote.reads.load(Ordering::Relaxed),
        if resubmission { 7 } else { 5 }
    );
    assert!(posts.iter().all(|post| post == &posts[0]));
    server.abort();
}
