//! Bounded access to the work volume. Each filesystem and Git call runs on its
//! own thread under a deadline, never on an async worker or under the state lock.
//! A call past its deadline may never return. It can start no further mutation,
//! and it holds back its owner's later calls only while one it had already started
//! is still running.

use std::{
    cell::Cell,
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use longhorn_redact::{RedactionRules, Redactor};
use nucleus_hosts::service_log;
use nucleus_store::{StorageDirectory, StorageError};
use nucleus_work::{Checkout, Custody, WorkError};
use tokio::{
    sync::{oneshot, watch},
    time,
};

use crate::{Service, ServiceError};

/// The most calls one owner may leave running past their deadline.
const UNRETURNED: usize = 16;
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
    /// How many callers are waiting on a call, by owner.
    waiting: watch::Sender<BTreeMap<String, usize>>,
    /// Calls no caller waits for any more. Each is shared with its thread until it returns.
    abandoned: Mutex<BTreeMap<String, Vec<Arc<Custody>>>>,
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
            self.volume
                .abandoned()
                .entry(self.owner.into())
                .or_default()
                .push(custody);
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
            waiting: watch::Sender::default(),
            abandoned: Mutex::default(),
        }
    }

    fn abandoned(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Vec<Arc<Custody>>>> {
        self.abandoned
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether earlier calls keep this owner from starting another.
    fn held(&self, owner: &str) -> bool {
        let mut abandoned = self.abandoned();
        let Some(calls) = abandoned.get_mut(owner) else {
            return false;
        };
        // A call which has returned no longer shares its custody.
        calls.retain(|custody| Arc::strong_count(custody) > 1);
        calls.len() >= UNRETURNED || calls.iter().any(|custody| custody.mutating())
    }

    /// Run one work-volume call for a task or housekeeping owner. Boxed to keep
    /// the pass futures which await it small.
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

    use super::*;

    const OWNER: &str = "task";

    async fn quick(volume: &WorkVolume, owner: &str) -> bool {
        volume
            .run(owner, "reading", Limit::Change, |_| ())
            .await
            .is_ok()
    }

    #[tokio::test]
    async fn only_a_running_mutation_holds_back_its_owner() {
        let mut volume = WorkVolume::new();
        volume.check = Duration::from_millis(500);

        // A read which never returns costs its owner nothing after the deadline.
        let (read, hung) = mpsc::channel::<()>();
        let (outcome, admitted) = mpsc::channel();
        let lost = volume.run(OWNER, "reading", Limit::Check, move |custody| {
            let _ = hung.recv();
            let _ = outcome.send(custody.mutate().is_ok());
        });
        assert!(lost.await.is_err());
        assert!(quick(&volume, OWNER).await);
        // It may not mutate if it ever resumes.
        drop(read);
        assert!(!admitted.recv_timeout(Duration::from_secs(5)).unwrap());

        let (mutation, hung) = mpsc::channel::<()>();
        let lost = volume.run(OWNER, "writing", Limit::Check, move |custody| {
            let _step = custody.mutate().expect("admitted while awaited");
            let _ = hung.recv();
        });
        assert!(lost.await.is_err());
        assert!(!quick(&volume, OWNER).await);
        assert!(quick(&volume, "another").await);
        drop(mutation);
        time::timeout(Duration::from_secs(5), async {
            while !quick(&volume, OWNER).await {
                time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the owner resumes once the mutation returns");
    }

    #[tokio::test]
    async fn hung_reads_are_bounded_for_each_owner() {
        let mut volume = WorkVolume::new();
        volume.check = Duration::from_millis(10);
        let mut hung = Vec::new();
        for _ in 0..UNRETURNED {
            let (release, wait) = mpsc::channel::<()>();
            hung.push(release);
            let lost = volume.run(OWNER, "reading", Limit::Check, move |_| {
                let _ = wait.recv();
            });
            assert!(lost.await.is_err());
        }
        assert!(!quick(&volume, OWNER).await);
        assert!(quick(&volume, "another").await);
    }
}
