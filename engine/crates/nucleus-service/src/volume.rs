//! Bounded access to the work volume. Its filesystem and Git calls run on
//! blocking threads under a deadline, never on an async worker or under the state
//! lock. A call past its deadline keeps running: nothing else starts for its owner
//! until it returns, and it may not begin a destructive step.

use std::{
    cell::Cell,
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use longhorn_redact::{RedactionRules, Redactor};
use nucleus_hosts::service_log;
use nucleus_store::{StorageDirectory, StorageError};
use nucleus_work::{Checkout, WorkError};
use tokio::{sync::watch, time};

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

#[derive(Default)]
struct Calls {
    waiting: usize,
    overdue: usize,
}

type Owners = Arc<watch::Sender<BTreeMap<String, Calls>>>;

pub(crate) struct WorkVolume {
    pub(crate) check: Duration,
    pub(crate) change: Duration,
    owners: Owners,
}

struct Call {
    owners: Owners,
    owner: String,
    returned: Mutex<bool>,
    abandoned: Arc<AtomicBool>,
}

impl Call {
    fn count(&self, change: impl FnOnce(&mut Calls)) {
        self.owners.send_modify(|owners| {
            let calls = owners.entry(self.owner.clone()).or_default();
            change(calls);
            if calls.waiting == 0 && calls.overdue == 0 {
                owners.remove(&self.owner);
            }
        });
    }
}

/// Held by the awaiting caller. Dropping it before the call returns abandons the call.
struct Waiting(Arc<Call>);

impl Drop for Waiting {
    fn drop(&mut self) {
        let returned = self
            .0
            .returned
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let abandoned = !*returned;
        self.0.abandoned.store(abandoned, Ordering::SeqCst);
        self.0.count(|calls| {
            calls.waiting -= 1;
            calls.overdue += usize::from(abandoned);
        });
    }
}

/// Held by the blocking thread until the call returns or unwinds.
struct Running(Arc<Call>);

impl Drop for Running {
    fn drop(&mut self) {
        let mut returned = self
            .0
            .returned
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        *returned = true;
        if self.0.abandoned.load(Ordering::SeqCst) {
            self.0.count(|calls| calls.overdue -= 1);
        }
    }
}

impl WorkVolume {
    pub(crate) fn new() -> Self {
        Self {
            check: Duration::from_mins(2),
            change: Duration::from_mins(12),
            owners: Arc::new(watch::Sender::default()),
        }
    }

    /// Run one work-volume call for a task or housekeeping owner. Boxed to keep
    /// the pass futures which await it small.
    pub(crate) fn run<'a, T: Send + 'static>(
        &'a self,
        owner: &'a str,
        step: &'static str,
        limit: Limit,
        job: impl FnOnce(Arc<AtomicBool>) -> T + Send + 'static,
    ) -> Pin<Box<impl Future<Output = Result<T, StorageError>>>> {
        Box::pin(async move {
            if self
                .owners
                .borrow()
                .get(owner)
                .is_some_and(|calls| calls.overdue > 0)
            {
                return Err(StorageError::VolumeUnavailable);
            }
            let _step = Step::enter(step);
            let call = Arc::new(Call {
                owners: Arc::clone(&self.owners),
                owner: owner.into(),
                returned: Mutex::new(false),
                abandoned: Arc::default(),
            });
            call.count(|calls| calls.waiting += 1);
            let _waiting = Waiting(Arc::clone(&call));
            let abandoned = Arc::clone(&call.abandoned);
            let running = Running(call);
            let work = tokio::task::spawn_blocking(move || {
                let _running = running;
                job(abandoned)
            });
            let limit = match limit {
                Limit::Check => self.check,
                Limit::Change => self.change,
            };
            let Ok(done) = time::timeout(limit, work).await else {
                service_log!("{owner}: {step} did not return within {}s", limit.as_secs());
                return Err(StorageError::VolumeUnavailable);
            };
            done.map_err(|error| std::io::Error::other(error).into())
        })
    }

    /// Resolve while a caller is waiting on a work-volume call for this owner.
    pub(crate) async fn waiting(&self, owner: &str) {
        let mut owners = self.owners.subscribe();
        // The sender lives as long as this borrow of the volume.
        let _ = owners
            .wait_for(|all| all.get(owner).is_some_and(|calls| calls.waiting > 0))
            .await;
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

    /// Read or write run scratch as a bounded work-volume call. A failure with
    /// the scratch root unverified is reported as the volume's.
    pub(crate) async fn scratch_job<T: Send + 'static>(
        &self,
        task: &str,
        step: &'static str,
        operation: impl FnOnce(&StorageDirectory) -> Result<T, ServiceError> + Send + 'static,
    ) -> Result<T, ServiceError> {
        let root = self.storage.scratch().clone();
        let job = move |_| {
            let result = operation(&root);
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
