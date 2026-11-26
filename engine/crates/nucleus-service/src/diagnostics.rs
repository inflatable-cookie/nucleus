use std::{
    future::Future,
    io::Write as _,
    ops::{Deref, DerefMut},
    panic::Location,
    sync::LazyLock,
    time::Instant,
};

use serde_json::{Value, json};
use tokio::sync::{Mutex, MutexGuard, TryLockError};

use crate::State;

static ENABLED: LazyLock<bool> =
    LazyLock::new(|| std::env::var("NUCLEUS_TRACE_SCHEDULER").as_deref() == Ok("1"));

tokio::task_local! {
    static SCHEDULER: ();
}

pub(super) fn enabled() -> bool {
    *ENABLED
}

pub(super) async fn scheduler<F: Future>(work: F) -> F::Output {
    if enabled() {
        SCHEDULER.scope((), work).await
    } else {
        work.await
    }
}

pub(super) fn record(event: &Value) {
    let _ = writeln!(std::io::stderr().lock(), "nucleus_diagnostic {event}");
}

pub(super) struct StateMutex(Mutex<State>);

impl StateMutex {
    pub(super) fn new(state: State) -> Self {
        Self(Mutex::new(state))
    }

    #[track_caller]
    pub(super) fn lock(&self) -> impl Future<Output = StateGuard<'_>> {
        self.acquire(
            SCHEDULER.try_with(|()| "scheduler").ok(),
            Location::caller(),
        )
    }

    #[track_caller]
    pub(super) fn lock_for_list(&self) -> impl Future<Output = StateGuard<'_>> {
        self.acquire(enabled().then_some("task_list"), Location::caller())
    }

    async fn acquire(
        &self,
        operation: Option<&'static str>,
        site: &'static Location<'static>,
    ) -> StateGuard<'_> {
        let started = operation.map(|operation| (operation, site, Instant::now()));
        let guard = self.0.lock().await;
        StateGuard::new(guard, started)
    }

    #[track_caller]
    pub(super) fn try_lock(&self) -> Result<StateGuard<'_>, TryLockError> {
        let started = SCHEDULER
            .try_with(|()| ("scheduler", Location::caller(), Instant::now()))
            .ok();
        self.0
            .try_lock()
            .map(|guard| StateGuard::new(guard, started))
    }
}

pub(super) struct StateGuard<'a> {
    guard: Option<MutexGuard<'a, State>>,
    timing: Option<LockTiming>,
}

struct LockTiming {
    operation: &'static str,
    site: &'static Location<'static>,
    wait_us: u128,
    acquired: Instant,
}

impl<'a> StateGuard<'a> {
    fn new(
        guard: MutexGuard<'a, State>,
        started: Option<(&'static str, &'static Location<'static>, Instant)>,
    ) -> Self {
        Self {
            guard: Some(guard),
            timing: started.map(|(operation, site, started)| {
                let acquired = Instant::now();
                LockTiming {
                    operation,
                    site,
                    wait_us: acquired.duration_since(started).as_micros(),
                    acquired,
                }
            }),
        }
    }
}

impl Deref for StateGuard<'_> {
    type Target = State;

    fn deref(&self) -> &State {
        self.guard.as_deref().expect("state held until guard drop")
    }
}

impl DerefMut for StateGuard<'_> {
    fn deref_mut(&mut self) -> &mut State {
        self.guard
            .as_deref_mut()
            .expect("state held until guard drop")
    }
}

impl Drop for StateGuard<'_> {
    fn drop(&mut self) {
        let hold_us = self
            .timing
            .as_ref()
            .map(|timing| timing.acquired.elapsed().as_micros());
        drop(self.guard.take());
        if let Some((timing, hold_us)) = self.timing.as_ref().zip(hold_us) {
            record(&json!({
                "kind": "state_lock",
                "operation": timing.operation,
                "file": timing.site.file(),
                "line": timing.site.line(),
                "wait_us": timing.wait_us,
                "hold_us": hold_us,
            }));
        }
    }
}
