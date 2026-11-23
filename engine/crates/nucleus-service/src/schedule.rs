use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

use nucleus_core::WaitReason;
use nucleus_hosts::T3_RETRY_DELAY;
use nucleus_store::Store;
use tokio::time::Instant;

use crate::ServiceError;

const SCAN_PAGE: u32 = 32;
pub(crate) const PASS_BATCH: usize = 8;
const SCAN_INTERVAL: Duration = Duration::from_mins(1);
const LIVE_CHECK: Duration = Duration::from_secs(45);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Priority {
    Effect,
    Wake,
    Decision,
    Refresh,
}

pub(crate) struct DueTask {
    pub(crate) id: String,
    pub(crate) priority: Priority,
}

impl Priority {
    const ORDER: [Self; 4] = [Self::Effect, Self::Wake, Self::Decision, Self::Refresh];
}

#[derive(Default)]
struct Pending {
    deadlines: [Option<Instant>; Priority::ORDER.len()],
}

impl Pending {
    fn wake(&mut self, due: Instant, priority: Priority) {
        let slot = &mut self.deadlines[priority as usize];
        *slot = Some(slot.map_or(due, |prior| prior.min(due)));
    }

    fn ready(&self, now: Instant) -> Option<(Priority, Instant)> {
        Priority::ORDER.into_iter().find_map(|priority| {
            self.deadlines[priority as usize]
                .filter(|due| *due <= now)
                .map(|due| (priority, due))
        })
    }

    fn due(&self) -> Option<Instant> {
        self.deadlines.iter().flatten().copied().min()
    }
}

pub(crate) const fn retry(wait: Option<WaitReason>) -> (Duration, Priority) {
    match wait {
        Some(
            WaitReason::Running
            | WaitReason::Starting
            | WaitReason::Input
            | WaitReason::Permission
            | WaitReason::IdleWithoutTerminalRun
            | WaitReason::Hold,
        ) => (LIVE_CHECK, Priority::Refresh),
        Some(WaitReason::HostUnknown | WaitReason::RetainedThreadBusy | WaitReason::Question) => {
            (T3_RETRY_DELAY, Priority::Decision)
        }
        Some(WaitReason::ChecksPending) => (Duration::from_secs(15), Priority::Decision),
        _ => (Duration::from_secs(3), Priority::Decision),
    }
}

pub(crate) struct Schedule {
    tasks: BTreeMap<String, Pending>,
    scan_at: Instant,
    cursor: Option<String>,
}

impl Schedule {
    pub(crate) fn new() -> Self {
        Self {
            tasks: BTreeMap::new(),
            scan_at: Instant::now(),
            cursor: None,
        }
    }

    pub(crate) fn wake(&mut self, id: &str, due: Instant, priority: Priority) {
        self.tasks.entry(id.into()).or_default().wake(due, priority);
    }

    pub(crate) fn seed(&mut self, store: &Store, now: Instant) -> Result<(), ServiceError> {
        if now < self.scan_at {
            return Ok(());
        }
        let ids = store.active_ids(self.cursor.as_deref(), SCAN_PAGE)?;
        let more = ids.len() == SCAN_PAGE as usize;
        self.cursor = ids.last().filter(|_| more).cloned();
        self.scan_at = now
            + if more {
                Duration::from_secs(1)
            } else {
                SCAN_INTERVAL
            };
        for id in ids {
            self.tasks.entry(id).or_insert_with(|| {
                let mut pending = Pending::default();
                pending.wake(now, Priority::Decision);
                pending
            });
        }
        Ok(())
    }

    pub(crate) fn take_ready(
        &mut self,
        now: Instant,
        visited: &BTreeSet<String>,
    ) -> Option<DueTask> {
        let ((priority, _), id) = self
            .tasks
            .iter()
            .filter_map(|(id, pending)| pending.ready(now).map(|ready| (ready, id)))
            .min()?;
        // Start a fresh pass instead of observing the same task again with the
        // census shared by this pass. Lower priority work stays in the queue.
        if visited.contains(id) {
            return None;
        }
        let id = id.clone();
        self.tasks.remove(&id);
        Some(DueTask { id, priority })
    }

    pub(crate) fn next(&self) -> Instant {
        self.tasks
            .values()
            .filter_map(Pending::due)
            .min()
            .map_or(self.scan_at, |due| due.min(self.scan_at))
    }

    pub(crate) fn due(&self, id: &str) -> Option<Instant> {
        self.tasks.get(id).and_then(Pending::due)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn earlier_due_tasks_win_over_more_recent_wakes() {
        let now = Instant::now();
        let mut pending = Schedule::new();
        pending.wake("later-id", now, Priority::Decision);
        let later = now + Duration::from_secs(1);
        for number in 0..PASS_BATCH {
            pending.wake(&format!("first-{number}"), later, Priority::Decision);
        }
        assert_eq!(
            pending
                .take_ready(later, &BTreeSet::new())
                .map(|task| task.id),
            Some("later-id".into())
        );
    }

    #[test]
    fn command_wakes_overtake_backstops_between_task_reads() {
        let now = Instant::now();
        let mut pending = Schedule::new();
        for id in ["refresh-a", "refresh-b", "refresh-c"] {
            pending.wake(id, now, Priority::Refresh);
        }
        let mut visited = BTreeSet::new();
        let first = pending.take_ready(now, &visited).expect("first refresh").id;
        assert_eq!(first, "refresh-a");
        visited.insert(first);
        let later = now + Duration::from_secs(1);
        pending.wake("refresh-b", later, Priority::Wake);
        pending.wake("refresh-c", later, Priority::Refresh);
        pending.wake("write", later, Priority::Effect);
        pending.wake("decision", now, Priority::Decision);
        for expected in ["write", "refresh-b", "decision", "refresh-c"] {
            assert_eq!(
                pending.take_ready(later, &visited).expect("ready task").id,
                expected
            );
        }
        assert!(pending.take_ready(later, &visited).is_none());
    }
}
