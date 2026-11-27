use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use tower::ServiceExt as _;

use super::*;
use crate::{
    pass::DispatchTarget,
    project::{LocalGit, git_gate},
};

const KEY: [u8; 32] = [7; 32];
const ANSWER: Duration = Duration::from_secs(5);

/// A worker with a sent run, and an external review which needs its checkout.
struct Outage {
    home: tempfile::TempDir,
    service: Service,
    head: Head,
    report: (String, [u8; 32], Value),
    forge: tokio::task::JoinHandle<()>,
}

async fn outage() -> Outage {
    let (home, mut service) = fixture(GitHub::new("fixture").unwrap());
    let head = service.fixture().start.clone();
    let (forge, _, server) = forge_fixture_for_branch(&head, "ns-worker").await;
    service.forge = forge;
    let (mut worker, credential, _) = reservation("worker", Entry::Brief, &head);
    let instance = worker.run().unwrap().launch().instance.clone();
    worker.record_send(&instance, 1).unwrap();
    service
        .worktrees()
        .checkout(&service.fixture().checkout, REPOSITORY, "worker")
        .unwrap()
        .allocate(&head)
        .unwrap();
    let pr = PullRequest {
        url: PR.into(),
        head: head.clone(),
    };
    let mut review = Task::new(
        Identity {
            id: "reviewer".into(),
            reference: "reviewer".into(),
            repository: REPOSITORY.into(),
            base: "main".into(),
            entry: Entry::ReviewEntry,
            origin_thread: None,
        },
        "---\ncomplexity: normal\n---\n\n# Synthetic review".into(),
        Some(pr.clone()),
    );
    let _ = review.reconcile(&Observation {
        forge: Observed::Known(Forge::Open {
            pr,
            checks: CheckState::Ready,
        }),
        host: Observed::Unknown,
        workspace: Observed::Known(Workspace::Absent),
    });
    assert_eq!(review.phase(), Phase::Reviewing);
    {
        let mut state = service.state.lock().await;
        for task in [&worker, &review] {
            state.store.create(task, &event("fixture")).unwrap();
        }
    }
    let work = json!({"work": {"url": PR, "head": head}});
    Outage {
        home,
        service,
        head,
        report: (
            format!("/v1/runs/worker/{instance}/report"),
            *credential.as_bytes(),
            work,
        ),
        forge: server,
    }
}

fn api(service: &Arc<Service>) -> Router {
    router(
        Arc::clone(service),
        [Controller {
            credential: KEY,
            authority: Authority::Operator {
                actor: "fixture".into(),
            },
        }],
    )
}

async fn send(api: &Router, request: axum::http::request::Builder, body: String) -> StatusCode {
    let request = request
        .header("host", "127.0.0.1:9")
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap();
    tokio::time::timeout(ANSWER, api.clone().oneshot(request))
        .await
        .expect("the API answers within its deadline")
        .unwrap()
        .status()
}

async fn reads_answer(api: &Router) {
    for path in [
        "/v1/health",
        "/v1/tasks",
        "/v1/tasks/worker",
        "/v1/tasks/worker/next",
        "/v1/tasks/reviewer/next",
    ] {
        let request =
            Request::get(path).header("authorization", format!("Bearer {}", hex::encode(KEY)));
        assert_eq!(send(api, request, String::new()).await, StatusCode::OK);
    }
}

async fn report_is_accepted(api: &Router, (path, key, body): &(String, [u8; 32], Value)) {
    let request =
        Request::post(path).header("authorization", format!("Bearer {}", hex::encode(key)));
    assert_eq!(
        send(api, request, body.to_string()).await,
        StatusCode::NO_CONTENT
    );
}

/// Run real passes until the reviewer task has the outcome the caller expects.
async fn pass_until(service: &Service, mut done: impl FnMut(&PassOutcome) -> bool) {
    tokio::time::timeout(Duration::from_mins(1), async {
        loop {
            let outcomes = service.pass().await.expect("pass");
            if outcomes.iter().any(&mut done) {
                return;
            }
        }
    })
    .await
    .expect("the pass reaches the expected outcome");
}

fn waits_for_volume(outcome: &PassOutcome) -> bool {
    outcome.task == "reviewer"
        && matches!(
            outcome.result,
            Err(ServiceError::Workspace(nucleus_work::WorkError::Storage(_)))
        )
}

fn launches_review(outcome: &PassOutcome) -> bool {
    outcome.task == "reviewer"
        && matches!(
            outcome.result,
            Ok(Action::Launch {
                role: nucleus_core::Role::Reviewer,
                ..
            })
        )
}

async fn assert_volume_wait(service: &Service) {
    let state = service.state.lock().await;
    assert_eq!(
        state.wait_reason("reviewer"),
        Some(WaitReason::WorkspaceUnknown)
    );
    assert!(matches!(
        state.wait_detail("reviewer"),
        Some(crate::WaitDetail::Observation(cause))
            if cause.starts_with("The work volume or layout cannot be verified")
    ));
}

#[derive(Clone, Copy)]
enum Gone {
    WorkRoot,
    /// An empty directory stands where the work root was.
    SubstitutedWorkRoot,
    RegisteredCheckout,
}

/// Take a directory away under the running service, then put the original back.
async fn holds_and_resumes(gone: Gone) {
    let Outage {
        home,
        service,
        head,
        report,
        forge,
    } = outage().await;
    let service = Arc::new(service);
    let api = api(&service);
    let work = service.storage.work().path().to_owned();
    let repository = service.fixture().checkout.clone();
    let lost = match gone {
        Gone::WorkRoot | Gone::SubstitutedWorkRoot => &work,
        Gone::RegisteredCheckout => &repository,
    };
    let away = home.path().join("away");
    std::fs::rename(lost, &away).unwrap();
    if matches!(gone, Gone::SubstitutedWorkRoot) {
        std::fs::create_dir(lost).unwrap();
    }

    reads_answer(&api).await;
    // Repeated misses keep retrying and never turn into a blocked checkout.
    for _ in 0..2 {
        pass_until(&service, waits_for_volume).await;
        assert_volume_wait(&service).await;
        reads_answer(&api).await;
    }
    if matches!(gone, Gone::RegisteredCheckout) {
        let row = service.task("reviewer").await.unwrap();
        let route = service.project_for(row.task.identity()).await.unwrap();
        assert!(matches!(
            service.verify_route(row.task.identity(), &route).await,
            Err(ServiceError::Workspace(nucleus_work::WorkError::Storage(_)))
        ));
    }
    report_is_accepted(&api, &report).await;
    match gone {
        Gone::SubstitutedWorkRoot => {
            assert_eq!(std::fs::read_dir(lost).unwrap().count(), 0);
            std::fs::remove_dir(lost).unwrap();
        }
        Gone::WorkRoot | Gone::RegisteredCheckout => {
            assert!(!lost.exists(), "nothing recreates a missing directory");
        }
    }
    std::fs::rename(&away, lost).unwrap();

    let (mut applied, mut launched) = (false, false);
    pass_until(&service, |outcome| {
        applied |= outcome.task == "worker"
            && matches!(outcome.result, Ok(Action::Advance(Phase::Reviewing)));
        launched |= launches_review(outcome);
        // A missing checkout does not stop a report which needs no checkout.
        (applied || matches!(gone, Gone::RegisteredCheckout)) && launched
    })
    .await;
    assert_eq!(
        service.task("worker").await.unwrap().task.phase(),
        Phase::Reviewing
    );
    let checkout = nucleus_work::checkout_path(&work, REPOSITORY, "reviewer");
    assert_eq!(git(&checkout, &["rev-parse", "HEAD"]), head.as_str());
    assert!(nucleus_work::checkout_path(&work, REPOSITORY, "worker").is_dir());
    forge.abort();
}

#[tokio::test]
async fn a_removed_work_root_holds_checkout_work_and_resumes_when_it_returns() {
    holds_and_resumes(Gone::WorkRoot).await;
}

#[tokio::test]
async fn an_empty_substitute_work_root_is_refused_until_the_original_returns() {
    holds_and_resumes(Gone::SubstitutedWorkRoot).await;
}

#[tokio::test]
async fn an_unavailable_registered_checkout_waits_as_the_volume_does() {
    holds_and_resumes(Gone::RegisteredCheckout).await;
}

/// Releases the stubbed Git calls even when an assertion fails.
struct Hung(Arc<git_gate::Gate>);

impl Hung {
    fn install(service: &mut Service, home: &Path) -> Self {
        let path = home.join("hung-git");
        std::fs::create_dir(&path).unwrap();
        service.git = LocalGit(path.clone());
        Self(git_gate::install(path))
    }

    async fn entered(&self, count: usize) {
        tokio::time::timeout(ANSWER, async {
            while self.0.entered.load(Ordering::SeqCst) < count {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the hung call started");
    }
}

impl Drop for Hung {
    fn drop(&mut self) {
        self.0.release();
    }
}

#[tokio::test]
async fn a_hung_checkout_call_never_blocks_reads_or_a_report_for_its_own_task() {
    let Outage {
        home,
        mut service,
        report,
        forge,
        ..
    } = outage().await;
    let hung = Hung::install(&mut service, home.path());
    let service = Arc::new(service);
    let api = api(&service);
    let pass = tokio::spawn({
        let service = Arc::clone(&service);
        async move { pass_until(&service, |outcome| outcome.task == "reviewer").await }
    });
    // An effect holding the reporting task's fence while it observes the checkout.
    let holder = tokio::spawn({
        let service = Arc::clone(&service);
        async move {
            let row = service.task("worker").await.unwrap();
            let _fence = service.effect(&row).await?;
            let route = service.project_for(row.task.identity()).await?;
            let worktrees = service.worktrees();
            let checkout = worktrees.checkout(&route.checkout, REPOSITORY, "worker")?;
            let binding = route.binding(&checkout)?;
            let target = DispatchTarget::Presentation {
                frozen: &binding,
                checkout: &checkout,
            };
            service
                .dispatch_gate(&row.task, target)
                .await
                .map(|permit| permit.is_some())
        }
    });
    hung.entered(2).await;

    reads_answer(&api).await;
    report_is_accepted(&api, &report).await;
    assert!(!pass.is_finished() && !holder.is_finished());

    drop(hung);
    // The holder saw the row before the report, so it may not act on it.
    assert!(matches!(
        holder.await.unwrap(),
        Err(ServiceError::Store(StoreError::StaleTask))
    ));
    pass.await.unwrap();
    forge.abort();
}

#[tokio::test]
async fn reads_which_never_return_do_not_hold_back_their_task() {
    let Outage {
        home,
        mut service,
        forge,
        ..
    } = outage().await;
    let hung = Hung::install(&mut service, home.path());
    hung.0.holds.store(3, Ordering::SeqCst);
    service.volume.check = Duration::from_secs(2);
    // The third hung call goes past the limit.
    service.volume.unreturned = 2;
    service.volume.spacing = Duration::from_secs(1);
    let service = Arc::new(service);
    let api = api(&service);

    // An outage which outlasts several retries, each leaving a call behind.
    for _ in 0..3 {
        pass_until(&service, waits_for_volume).await;
        assert_volume_wait(&service).await;
        reads_answer(&api).await;
    }
    // Every one of them stays hung while a later retry succeeds.
    pass_until(&service, launches_review).await;
    drop(hung);
    forge.abort();
}

#[tokio::test]
async fn a_stuck_allocation_holds_its_task_until_it_ends_and_then_resumes() {
    let Outage {
        home,
        mut service,
        head,
        forge,
        ..
    } = outage().await;
    let hung = Hung::install(&mut service, home.path());
    hung.0.only.set("add").unwrap();
    hung.0.holds.store(1, Ordering::SeqCst);
    service.volume.change = ANSWER;
    let service = Arc::new(service);
    let api = api(&service);
    let root = service.storage.work().path().to_owned();

    // The worktree add outlasts its caller.
    pass_until(&service, waits_for_volume).await;
    assert_volume_wait(&service).await;
    // The root goes and returns before anything reads it, with the add unfinished.
    let away = home.path().join("away");
    std::fs::rename(&root, &away).unwrap();
    std::fs::rename(&away, &root).unwrap();
    pass_until(&service, waits_for_volume).await;
    reads_answer(&api).await;
    assert_eq!(hung.0.entered.load(Ordering::SeqCst), 1);

    // The old add resumes and ends, and the pass carries on by itself.
    drop(hung);
    pass_until(&service, launches_review).await;
    let checkout = nucleus_work::checkout_path(&root, REPOSITORY, "reviewer");
    assert_eq!(git(&checkout, &["rev-parse", "HEAD"]), head.as_str());
    forge.abort();
}
