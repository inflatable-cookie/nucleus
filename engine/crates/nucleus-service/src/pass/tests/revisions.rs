use nucleus_core::RetainedThread;

use super::*;
use crate::tests::{create_fixture_commit, forge_pull, git, reserved_reviewer};

const OLD_DESCRIPTION: &str = "Validation is pending.";
const UPDATED_DESCRIPTION: &str = "Validation completed with the scoped regression test.";

#[derive(Clone, Copy)]
enum Revision {
    Proof,
    Description,
    NewHead,
    Contradiction,
}

impl Revision {
    fn assert_review(self, prompt: &str, summary: &str) {
        let same_head = !matches!(self, Self::NewHead);
        assert_eq!(prompt.contains("Worker report at the same head"), same_head);
        if same_head {
            assert!(prompt.contains(summary));
        }
        if matches!(self, Self::Description) {
            assert!(prompt.contains(&format!(
                "----- BEGIN PR DESCRIPTION -----\n{UPDATED_DESCRIPTION}\n----- END PR DESCRIPTION -----"
            )));
            assert!(!prompt.contains(OLD_DESCRIPTION));
        }
    }
}

async fn revision_forge(
    head: &Head,
) -> (
    GitHub,
    Arc<std::sync::Mutex<&'static str>>,
    tokio::task::JoinHandle<()>,
) {
    let mut pull = forge_pull(head);
    pull["head"]["ref"] = json!("ns-revision");
    let description = Arc::new(std::sync::Mutex::new(OLD_DESCRIPTION));
    let current = Arc::clone(&description);
    let router = Router::new().route(
        &format!("/repos/{REPOSITORY}/pulls/1"),
        get(move || async move {
            let mut pull = pull;
            pull["body"] = json!(*current.lock().unwrap());
            Json(pull)
        }),
    );
    let (forge, server) = serve_forge(router).await;
    (forge, description, server)
}

async fn after_changes(service: &Service, head: &Head) -> (TaskRow, Observation) {
    let (mut task, key, mut observation) = reserved_reviewer("revision", head);
    let instance = task.run().unwrap().launch().instance.clone();
    task.record_send(&instance, 1).unwrap();
    service
        .state
        .lock()
        .await
        .store
        .create(&task, &event("fixture"))
        .unwrap();
    service
        .report(
            "revision",
            &instance,
            key.as_bytes(),
            Report::Review {
                head: head.clone(),
                decision: Review::Changes,
                summary: "Address the outstanding review finding".into(),
                finding_titles: Vec::new(),
            },
        )
        .await
        .unwrap();
    observation.host = Observed::Known(Host::Current {
        instance,
        state: RunState::Ended,
    });
    let row = service.task("revision").await.unwrap();
    let action = decide(&row.task, &observation);
    assert_eq!(action, Action::Advance(Phase::Working));
    service.apply(&row, &observation, action).await.unwrap();
    (service.task("revision").await.unwrap(), observation)
}

async fn revision(summary: &str, kind: Revision) {
    let (_home, mut service) = fixture(GitHub::new("unused-fixture").unwrap());
    let reviewed_head = &service.fixture().start;
    let (forge, description, server) = revision_forge(reviewed_head).await;
    service.forge = forge;
    let (row, mut observation) = after_changes(&service, reviewed_head).await;
    let worktrees = service.worktrees();
    let project = service.fixture();
    let checkout = worktrees
        .checkout(&project.checkout, &project.repository, "revision")
        .unwrap();
    checkout.allocate(reviewed_head).unwrap();
    let host = service.host.fixture_pass();
    observation.host = Observed::Known(Host::Retained {
        thread: "thread:revision".into(),
        state: RetainedThread::Idle,
    });
    let Action::Launch { role, via } = decide(&row.task, &observation) else {
        panic!("expected the retained worker to resume");
    };
    Box::pin(service.reserve(&row, &checkout, observation.clone(), role, via, &host))
        .await
        .unwrap();
    let row = service.task("revision").await.unwrap();
    let head = if matches!(kind, Revision::NewHead) {
        std::fs::write(
            checkout.path().join("fix.rs"),
            "const FIXED: bool = true;\n",
        )
        .unwrap();
        git(checkout.path(), &["add", "fix.rs"]);
        create_fixture_commit(checkout.path(), "revision");
        git(checkout.path(), &["rev-parse", "HEAD"])
            .parse()
            .unwrap()
    } else {
        reviewed_head.clone()
    };
    let pr = PullRequest {
        url: row.task.pull_request().unwrap().url.clone(),
        head: head.clone(),
    };
    if matches!(kind, Revision::Description) {
        let target = task_branches(&row.task, &checkout)
            .unwrap()
            .target(&pr.url)
            .unwrap();
        assert_eq!(
            service
                .forge
                .open_description(&target, reviewed_head)
                .await
                .unwrap()
                .as_deref(),
            Some(OLD_DESCRIPTION)
        );
        *description.lock().unwrap() = UPDATED_DESCRIPTION;
    }
    let instance = report_revision(&service, &row, &pr, summary).await;
    observation.host = Observed::Known(Host::Current {
        instance,
        state: RunState::Ended,
    });
    observation.forge = Observed::Known(Forge::Open {
        pr,
        checks: CheckState::Ready,
    });
    observation.workspace = Observed::Known(Workspace::Clean(head.clone()));
    let row = service.task("revision").await.unwrap();
    let action = decide(&row.task, &observation);
    service
        .apply(&row, &observation, action.clone())
        .await
        .unwrap();
    let row = service.task("revision").await.unwrap();
    if matches!(kind, Revision::Contradiction) {
        assert!(matches!(action, Action::Ask(_)));
        let Some(nucleus_core::Question::Work { prompt, .. }) = row.task.question() else {
            panic!("expected a durable planner question");
        };
        assert!(prompt.contains(
            "reported code changes, but the PR is still at the previously reviewed head"
        ));
        assert_eq!(
            decide(&row.task, &observation),
            Action::Wait(WaitReason::Question)
        );
    } else {
        assert_eq!(action, Action::Advance(Phase::Reviewing));
        assert!(row.task.question().is_none());
        let prompt = reviewer_prompt(&service, &row, &checkout, observation, &head).await;
        kind.assert_review(&prompt, summary);
    }
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

async fn report_revision(
    service: &Service,
    row: &TaskRow,
    pr: &PullRequest,
    summary: &str,
) -> String {
    let instance = row.task.run().unwrap().launch().instance.clone();
    let mut sent = row.task.clone();
    sent.record_send(&instance, now_ms()).unwrap();
    service.save(row, sent, &event("host_send")).await.unwrap();
    let binding: ticket::ReportTicket = serde_json::from_slice(
        &std::fs::read(ticket::path(service.storage.scratch(), &instance)).unwrap(),
    )
    .unwrap();
    let payload = json!({"work": {
        "url": pr.url, "head": pr.head, "summary": summary,
    }});
    service
        .report(
            "revision",
            &instance,
            &binding.credential,
            serde_json::from_value(payload).unwrap(),
        )
        .await
        .unwrap();
    let reported = service
        .state
        .lock()
        .await
        .store
        .lifecycle_events("revision")
        .unwrap()
        .pop()
        .unwrap();
    let detail: serde_json::Value = serde_json::from_str(&reported.content.detail).unwrap();
    assert_eq!(detail["presentation"][0]["outcome"]["revision"], true);
    instance
}

async fn reviewer_prompt(
    service: &Service,
    row: &TaskRow,
    checkout: &Checkout<'_>,
    mut observation: Observation,
    head: &Head,
) -> String {
    observation.host = Observed::Known(Host::Retained {
        thread: "thread:reviewer".into(),
        state: RetainedThread::Idle,
    });
    let Action::Launch { role, via } = decide(&row.task, &observation) else {
        panic!("expected a new reviewer round");
    };
    assert_eq!(role, Role::Reviewer);
    Box::pin(service.reserve(
        row,
        checkout,
        observation,
        role,
        via,
        &service.host.fixture_pass(),
    ))
    .await
    .unwrap();
    let review = service.task("revision").await.unwrap();
    let launch = review.task.run().unwrap().launch();
    assert_eq!(launch.review_head.as_ref(), Some(head));
    let wire: serde_json::Value = serde_json::from_str(&launch.input).unwrap();
    let prompt = wire["payload"]["text"].as_str().unwrap();
    assert!(prompt.contains(&format!("PR head: {head}")));
    assert!(prompt.contains("Read the current PR description from the forge"));
    prompt.to_owned()
}

#[tokio::test]
async fn same_head_proof_returns_to_review_with_the_worker_summary() {
    Box::pin(revision(
        "Head unchanged. Published proof of the requested code fix.",
        Revision::Proof,
    ))
    .await;
}

#[tokio::test]
async fn same_head_code_coverage_results_return_to_review() {
    Box::pin(revision(
        "Head unchanged. Added code coverage results for the scoped tests.",
        Revision::Proof,
    ))
    .await;
}

#[tokio::test]
async fn same_head_proof_about_original_and_updated_code_returns_to_review() {
    Box::pin(revision(
        "Head unchanged. Added evidence from the original and updated code.",
        Revision::Proof,
    ))
    .await;
}

#[tokio::test]
async fn same_head_description_fix_returns_to_review_with_the_current_body() {
    Box::pin(revision(
        "Head unchanged. Updated the PR description to explain the code fix.",
        Revision::Description,
    ))
    .await;
}

#[tokio::test]
async fn new_head_revision_returns_to_review_at_the_new_head() {
    Box::pin(revision(
        "Published the requested code fix.",
        Revision::NewHead,
    ))
    .await;
}

#[tokio::test]
async fn same_head_code_change_claim_asks_the_planner() {
    Box::pin(revision(
        "Published the requested code fix.",
        Revision::Contradiction,
    ))
    .await;
}

#[tokio::test]
async fn same_head_claim_in_present_perfect_asks_the_planner() {
    Box::pin(revision(
        "I have fixed the parser.",
        Revision::Contradiction,
    ))
    .await;
}

#[tokio::test]
async fn same_head_report_with_proof_and_bare_code_claim_asks_the_planner() {
    Box::pin(revision(
        "Head unchanged. Added proof and changed code.",
        Revision::Contradiction,
    ))
    .await;
}
