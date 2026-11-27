//! Bounded access to the work volume. Each filesystem and Git call runs on its
//! own thread under a deadline, never on an async worker or under the state lock.
//! A call past its deadline may never return, and it can start no further
//! mutation. A hung read never holds back later calls. A mutation it had already
//! started holds back its owner until that mutation ends: only its end proves it
//! can no longer take effect.

use std::{
    cell::Cell,
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use longhorn_redact::{RedactionRules, Redactor};
use nucleus_store::{StorageDirectory, StorageError};
use nucleus_work::{Checkout, Custody, WorkError};
use tokio::{
    sync::{oneshot, watch},
    time,
};

use crate::{Service, ServiceError};

/// A pass step older than this is logged once.
const STUCK: Duration = Duration::from_mins(1);

#[derive(Clone, Copy)]
pub(crate) enum Limit {
    /// Reads and small writes, longer than Git's own 30-second bounds.
    Check,
    /// Allocation and removal, longer than the ten minutes Git has to populate a worktree.
    Change,
}

pub(crate) struct WorkVolume {
    pub(crate) check: Duration,
    pub(crate) change: Duration,
    /// The hung calls an owner may collect before further ones take turns.
    pub(crate) unreturned: usize,
    /// Past that limit, how long after a hung call an owner starts any other.
    pub(crate) spacing: Duration,
    /// How many callers are waiting on a call, by owner.
    waiting: watch::Sender<BTreeMap<String, usize>>,
    /// Calls no caller waits for any more, by owner.
    abandoned: Mutex<BTreeMap<String, Hung>>,
}

#[derive(Default)]
struct Hung {
    /// Each is shared with its thread until it returns.
    calls: Vec<Arc<Custody>>,
    /// When a call was last abandoned.
    latest: Option<Instant>,
}

/// Held by the awaiting caller. Dropping it unsettled abandons the call.
struct Waiting<'a> {
    volume: &'a WorkVolume,
    owner: &'a str,
    unsettled: Option<Arc<Custody>>,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        if let Some(custody) = self.unsettled.take() {
            custody.abandon();
            let mut owners = self.volume.abandoned();
            let hung = owners.entry(self.owner.into()).or_default();
            hung.latest = Some(Instant::now());
            hung.calls.push(custody);
        }
        self.volume.waiting.send_modify(|waiting| {
            if let Some(count) = waiting.get_mut(self.owner) {
                *count -= 1;
                if *count == 0 {
                    waiting.remove(self.owner);
                }
            }
        });
    }
}

impl WorkVolume {
    pub(crate) fn new() -> Self {
        Self {
            check: Duration::from_mins(2),
            change: Duration::from_mins(12),
            unreturned: 16,
            spacing: Duration::from_mins(5),
            waiting: watch::Sender::default(),
            abandoned: Mutex::default(),
        }
    }

    fn abandoned(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Hung>> {
        self.abandoned
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether earlier calls keep this owner from starting another. A running
    /// mutation always does. Hung reads only slow it: past the limit each new
    /// one makes the owner wait, and calls which return cost nothing.
    fn held(&self, owner: &str) -> bool {
        let mut owners = self.abandoned();
        let Some(hung) = owners.get_mut(owner) else {
            return false;
        };
        // A call which has returned no longer shares its custody.
        hung.calls.retain(|custody| Arc::strong_count(custody) > 1);
        hung.calls.iter().any(|custody| custody.mutating())
            || (hung.calls.len() >= self.unreturned
                && hung.latest.is_some_and(|at| at.elapsed() < self.spacing))
    }

    /// Run one work-volume call for an owner: a task, a repository or a kind of
    /// housekeeping. Boxed to keep the pass futures which await it small.
    pub(crate) fn run<'a, T: Send + 'static>(
        &'a self,
        owner: &'a str,
        step: &'static str,
        limit: Limit,
        job: impl FnOnce(Arc<Custody>) -> T + Send + 'static,
    ) -> Pin<Box<impl Future<Output = Result<T, StorageError>>>> {
        Box::pin(async move {
            if self.held(owner) {
                return Err(StorageError::VolumeUnavailable);
            }
            let _step = Step::enter(step);
            let custody = Arc::new(Custody::default());
            let running = Arc::clone(&custody);
            let (answer, answered) = oneshot::channel();
            // A hung call keeps its thread, so it must not take one from a shared pool.
            std::thread::Builder::new()
                .name("nucleus-volume".into())
                .spawn(move || {
                    let done = job(Arc::clone(&running));
                    drop(running);
                    let _ = answer.send(done);
                })?;
            self.waiting
                .send_modify(|waiting| *waiting.entry(owner.into()).or_default() += 1);
            let mut waiting = Waiting {
                volume: self,
                owner,
                unsettled: Some(custody),
            };
            let limit = match limit {
                Limit::Check => self.check,
                Limit::Change => self.change,
            };
            let Ok(done) = time::timeout(limit, answered).await else {
                service_log!("{owner}: {step} did not return within {}s", limit.as_secs());
                return Err(StorageError::VolumeUnavailable);
            };
            waiting.unsettled = None;
            done.map_err(|_| std::io::Error::other("a work volume call panicked").into())
        })
    }

    /// Resolve while a caller is waiting on a work-volume call for this owner.
    pub(crate) async fn waiting(&self, owner: &str) {
        let mut waiting = self.waiting.subscribe();
        // The sender lives as long as this borrow of the volume.
        let _ = waiting.wait_for(|all| all.contains_key(owner)).await;
    }
}

tokio::task_local! {
    static STEP: Cell<&'static str>;
}

/// Name the pass step in progress until this is dropped.
pub(crate) struct Step(Option<&'static str>);

impl Step {
    pub(crate) fn enter(step: &'static str) -> Self {
        Self(STEP.try_with(|current| current.replace(step)).ok())
    }
}

impl Drop for Step {
    fn drop(&mut self) {
        if let Some(prior) = self.0 {
            let _ = STEP.try_with(|current| current.set(prior));
        }
    }
}

/// Run one task's share of the pass, logging once if it outlives the threshold.
pub(crate) async fn watched<F: Future>(task: &str, work: F) -> F::Output {
    STEP.scope(Cell::new("advancing the task"), async {
        tokio::pin!(work);
        if let Ok(done) = time::timeout(STUCK, &mut work).await {
            return done;
        }
        service_log!(
            "{task}: the pass has been stuck for {}s while {}",
            STUCK.as_secs(),
            STEP.with(Cell::get)
        );
        work.await
    })
    .await
}

impl Service {
    /// Run a checkout operation as a bounded work-volume call.
    pub(crate) async fn checkout_job<T: Send + 'static>(
        &self,
        checkout: &Checkout<'_>,
        step: &'static str,
        limit: Limit,
        operation: impl FnOnce(&Checkout<'_>) -> Result<T, WorkError> + Send + 'static,
    ) -> Result<T, WorkError> {
        let job = checkout.job(
            self.git.clone(),
            Redactor::new([], RedactionRules::common()),
            operation,
        );
        self.volume.run(checkout.task(), step, limit, job).await?
    }

    /// Read or write run scratch as a bounded work-volume call. Each write asks
    /// the custody first. A failure with the scratch root unverified is reported
    /// as the volume's.
    pub(crate) async fn scratch_job<T: Send + 'static>(
        &self,
        task: &str,
        step: &'static str,
        operation: impl FnOnce(&StorageDirectory, &Custody) -> Result<T, ServiceError> + Send + 'static,
    ) -> Result<T, ServiceError> {
        let root = self.storage.scratch().clone();
        let job = move |custody: Arc<Custody>| {
            let result = operation(&root, &custody);
            if result.is_err() {
                root.verify().map_err(WorkError::from)?;
            }
            result
        };
        self.volume
            .run(task, step, Limit::Check, job)
            .await
            .map_err(WorkError::from)?
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use nucleus_forge::GitHub;

    use super::*;
    use crate::tests::fixture;

    const OWNER: &str = "task";
    const SOON: Duration = Duration::from_secs(5);

    async fn quick(volume: &WorkVolume, owner: &str) -> bool {
        volume
            .run(owner, "reading", Limit::Change, |_| ())
            .await
            .is_ok()
    }

    #[tokio::test]
    async fn a_hung_read_never_holds_its_owner_and_may_not_mutate_later() {
        let (_home, mut service) = fixture(GitHub::new("fixture").unwrap());
        service.volume.check = Duration::from_millis(500);
        let (read, hung) = mpsc::channel::<()>();
        let (outcome, admitted) = mpsc::channel();
        let lost = service
            .volume
            .run(OWNER, "reading", Limit::Check, move |custody| {
                let _ = hung.recv();
                let _ = outcome.send(custody.mutate().is_ok());
            });
        assert!(lost.await.is_err());
        assert!(quick(&service.volume, OWNER).await);
        drop(read);
        assert!(!admitted.recv_timeout(SOON).unwrap());
    }

    #[tokio::test]
    async fn a_stuck_mutation_holds_its_owner_until_it_ends_whatever_the_roots_do() {
        let (_home, mut service) = fixture(GitHub::new("fixture").unwrap());
        service.volume.check = Duration::from_millis(500);
        let (mutation, hung) = mpsc::channel::<()>();
        let (outcome, admitted) = mpsc::channel();
        let lost = service
            .volume
            .run(OWNER, "writing", Limit::Check, move |custody| {
                let step = custody.mutate().expect("admitted while awaited");
                let _ = hung.recv();
                drop(step);
                let _ = outcome.send(custody.mutate().is_ok());
            });
        assert!(lost.await.is_err());
        assert!(!quick(&service.volume, OWNER).await);
        assert!(quick(&service.volume, "another").await);

        // The work root and the unrelated scratch root each go and come back,
        // first unseen and then read while away.
        for root in [service.storage.work(), service.storage.scratch()] {
            for seen in [false, true] {
                let away = root.path().with_extension("away");
                std::fs::rename(root.path(), &away).unwrap();
                if seen {
                    assert!(root.verify().is_err());
                }
                std::fs::rename(&away, root.path()).unwrap();
                root.verify().unwrap();
                assert!(!quick(&service.volume, OWNER).await);
            }
        }

        // The old mutation resumes and ends. Only then may the owner proceed.
        drop(mutation);
        assert!(!admitted.recv_timeout(SOON).unwrap(), "no further mutation");
        time::timeout(SOON, async {
            while !quick(&service.volume, OWNER).await {
                time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the owner resumes once the mutation ends");
    }

    #[tokio::test]
    async fn past_the_limit_hung_calls_take_turns_and_never_stop_progress() {
        let (_home, mut service) = fixture(GitHub::new("fixture").unwrap());
        service.volume.check = Duration::from_millis(10);
        service.volume.spacing = Duration::from_hours(1);
        let mut hung = Vec::new();
        for _ in 0..service.volume.unreturned {
            let (release, wait) = mpsc::channel::<()>();
            hung.push(release);
            let lost = service
                .volume
                .run(OWNER, "reading", Limit::Check, move |_| {
                    let _ = wait.recv();
                });
            assert!(lost.await.is_err());
        }
        assert!(!quick(&service.volume, OWNER).await);
        assert!(quick(&service.volume, "another").await);
        // Every earlier call is still hung when the turn comes, and calls which
        // return leave it open for the rest of a pass.
        service.volume.spacing = Duration::from_millis(200);
        time::sleep(Duration::from_millis(250)).await;
        assert!(quick(&service.volume, OWNER).await);
        assert!(quick(&service.volume, OWNER).await);
    }
}
