//! Bounded access to the work volume. Each filesystem and Git call runs on its
//! own thread under a deadline, never on an async worker or under the state lock.
//! A call past its deadline may never return, and it can start no further
//! mutation. A hung read never holds back later calls. A mutation it had already
//! started holds back its owner until it returns or can no longer take effect.

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
    /// Longer than Git may run before it is killed.
    pub(crate) outlived: Duration,
    /// How many callers are waiting on a call, by owner.
    waiting: watch::Sender<BTreeMap<String, usize>>,
    abandoned: Arc<Abandoned>,
}

/// Calls no caller waits for any more, and the pinned roots they depend on.
struct Abandoned {
    roots: Vec<StorageDirectory>,
    owners: Mutex<BTreeMap<String, Hung>>,
}

#[derive(Default)]
struct Hung {
    /// Each is shared with its thread until it returns.
    calls: Vec<Arc<Custody>>,
    /// When a call was last abandoned.
    latest: Option<Instant>,
}

impl Abandoned {
    fn owners(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Hung>> {
        self.owners.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether this owner may start another call beside its hung ones. Past the
    /// limit each new hung call makes the owner wait, so threads grow slowly and
    /// progress never stops. Calls which return cost nothing.
    fn has_room(&self, owner: &str, limit: usize, spacing: Duration) -> bool {
        let mut owners = self.owners();
        let Some(hung) = owners.get_mut(owner) else {
            return true;
        };
        // A call which has returned no longer shares its custody.
        hung.calls.retain(|custody| Arc::strong_count(custody) > 1);
        hung.calls.len() < limit || hung.latest.is_none_or(|at| at.elapsed() >= spacing)
    }

    /// Whether an earlier mutation of this owner could still take effect. This
    /// reads the volume, so it runs on the new call's thread.
    fn mutating(&self, owner: &str, outlived: Duration) -> bool {
        let running: Vec<_> = self.owners().get(owner).map_or_else(Vec::new, |hung| {
            hung.calls
                .iter()
                .filter(|custody| Arc::strong_count(custody) > 1 && custody.mutating())
                .map(Arc::clone)
                .collect()
        });
        if running.is_empty() {
            return false;
        }
        // Reading the roots records their loss and return even when no other call does.
        for root in &self.roots {
            let _ = root.verify();
        }
        running
            .iter()
            .any(|custody| custody.may_still_apply(outlived))
    }
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
            let mut owners = self.volume.abandoned.owners();
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
    pub(crate) fn new(roots: Vec<StorageDirectory>) -> Self {
        Self {
            check: Duration::from_mins(2),
            change: Duration::from_mins(12),
            unreturned: 16,
            spacing: Duration::from_mins(5),
            outlived: Duration::from_mins(11),
            waiting: watch::Sender::default(),
            abandoned: Arc::new(Abandoned {
                roots,
                owners: Mutex::default(),
            }),
        }
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
            if !self
                .abandoned
                .has_room(owner, self.unreturned, self.spacing)
            {
                return Err(StorageError::VolumeUnavailable);
            }
            let _step = Step::enter(step);
            let custody = Arc::new(Custody::over(self.abandoned.roots.clone()));
            let running = Arc::clone(&custody);
            let (abandoned, name) = (Arc::clone(&self.abandoned), owner.to_owned());
            let outlived = self.outlived;
            let (answer, answered) = oneshot::channel();
            // A hung call keeps its thread, so it must not take one from a shared pool.
            std::thread::Builder::new()
                .name("nucleus-volume".into())
                .spawn(move || {
                    let done =
                        (!abandoned.mutating(&name, outlived)).then(|| job(Arc::clone(&running)));
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
            done.map_err(|_| std::io::Error::other("a work volume call panicked"))?
                .ok_or(StorageError::VolumeUnavailable)
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
    use std::{path::Path, sync::mpsc};

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

    /// Let the engine see a root go away, and put it back.
    async fn lose_and_restore(volume: &WorkVolume, root: &Path) {
        let away = root.with_extension("away");
        std::fs::rename(root, &away).unwrap();
        assert!(!quick(volume, OWNER).await, "still held while away");
        std::fs::rename(&away, root).unwrap();
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
    async fn a_stuck_mutation_holds_its_owner_until_the_volume_has_gone_and_returned() {
        let (_home, mut service) = fixture(GitHub::new("fixture").unwrap());
        service.volume.check = Duration::from_millis(500);
        service.volume.outlived = Duration::from_hours(1);
        let root = service.storage.work().path().to_owned();
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

        // A return is not enough while its Git process could still be alive.
        lose_and_restore(&service.volume, &root).await;
        assert!(!quick(&service.volume, OWNER).await);
        service.volume.outlived = Duration::ZERO;
        assert!(quick(&service.volume, OWNER).await);

        drop(mutation);
        assert!(!admitted.recv_timeout(SOON).unwrap(), "no further mutation");
    }

    #[tokio::test]
    async fn a_stuck_mutation_returning_releases_its_owner_without_an_outage() {
        let (_home, mut service) = fixture(GitHub::new("fixture").unwrap());
        service.volume.check = Duration::from_millis(500);
        service.volume.outlived = Duration::ZERO;
        let (mutation, hung) = mpsc::channel::<()>();
        let lost = service
            .volume
            .run(OWNER, "writing", Limit::Check, move |custody| {
                let _step = custody.mutate().expect("admitted while awaited");
                let _ = hung.recv();
            });
        assert!(lost.await.is_err());
        assert!(
            !quick(&service.volume, OWNER).await,
            "the volume never left"
        );
        drop(mutation);
        time::timeout(SOON, async {
            while !quick(&service.volume, OWNER).await {
                time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the owner resumes once the mutation returns");
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
