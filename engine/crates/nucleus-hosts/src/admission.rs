//! One native request at a time, with due safety and operator work first.

use std::sync::Mutex;

use tokio::{sync::Notify, time::Instant};

use crate::HostError;

const MAX_WAITERS: usize = 16;
const PRIORITY_BURST: u8 = 4;

#[derive(Default)]
pub(crate) struct Admission {
    state: Mutex<State>,
    ready: Notify,
}

#[derive(Default)]
struct State {
    in_flight: bool,
    priority_waiters: usize,
    background_waiters: usize,
    consecutive_priority: u8,
}

pub(crate) struct Slot<'a> {
    budget: &'a Admission,
    priority: bool,
    acquired: bool,
}

impl Admission {
    pub(crate) async fn enter(&self, priority: bool) -> Result<Slot<'_>, HostError> {
        {
            let mut state = self.state.lock().expect("host admission");
            if state.priority_waiters + state.background_waiters >= MAX_WAITERS {
                return Err(HostError::Deferred {
                    until: Instant::now() + std::time::Duration::from_secs(1),
                });
            }
            *state.waiters(priority) += 1;
        }
        let mut slot = Slot {
            budget: self,
            priority,
            acquired: false,
        };
        loop {
            let ready = self.ready.notified();
            tokio::pin!(ready);
            ready.as_mut().enable();
            {
                let mut state = self.state.lock().expect("host admission");
                let priority_due = state.priority_waiters > 0
                    && (state.background_waiters == 0
                        || state.consecutive_priority < PRIORITY_BURST);
                if !state.in_flight && priority == priority_due {
                    *state.waiters(priority) -= 1;
                    state.consecutive_priority = if priority {
                        state.consecutive_priority.saturating_add(1)
                    } else {
                        0
                    };
                    state.in_flight = true;
                    slot.acquired = true;
                    return Ok(slot);
                }
            }
            ready.await;
        }
    }
}

impl State {
    fn waiters(&mut self, priority: bool) -> &mut usize {
        if priority {
            &mut self.priority_waiters
        } else {
            &mut self.background_waiters
        }
    }
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        let mut state = self.budget.state.lock().expect("host admission");
        if self.acquired {
            state.in_flight = false;
        } else {
            *state.waiters(self.priority) -= 1;
        }
        self.budget.ready.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{pin::pin, task::Poll};

    #[tokio::test]
    async fn priority_work_overtakes_background_waiters_and_cancellation_releases_budget() {
        let admission = Admission::default();
        let held = admission.enter(false).await.unwrap();
        let mut background = Box::pin(admission.enter(false));
        let mut priority = Box::pin(admission.enter(true));
        assert!(matches!(
            futures_util::poll!(&mut background),
            Poll::Pending
        ));
        assert!(matches!(futures_util::poll!(&mut priority), Poll::Pending));
        drop(held);
        assert!(matches!(
            futures_util::poll!(&mut background),
            Poll::Pending
        ));
        drop(priority.await.unwrap());
        drop(background.await.unwrap());

        let held = admission.enter(false).await.unwrap();
        {
            let mut cancelled = pin!(admission.enter(true));
            assert!(matches!(futures_util::poll!(&mut cancelled), Poll::Pending));
        }
        drop(held);
        drop(admission.enter(false).await.unwrap());
    }
}
